"""IMAP client wrapper for the email add-on.

Encapsulates every ``imaplib`` interaction so the higher-level command code
in ``email-addon.py`` never touches raw IMAP protocol details. This module:

* Manages the TLS / STARTTLS connection (context manager).
* Discovers folder roles via IMAP SPECIAL-USE (RFC 6154) with
  Mailcow/Dovecot defaults and config overrides — cached per connection.
* Performs UID-set operations (STORE / MOVE / COPY) with automatic
  chunking so large UID sets don't exceed server command-line caps.
* Falls back from ``UID MOVE`` (RFC 6851) to ``COPY + STORE \\Deleted +
  EXPUNGE`` on older servers transparently.
* Implements the IDLE (RFC 2177) push-notification primitive.
* Checks every response status and raises :class:`ImapError` on non-OK
  replies — callers can roll back local state safely without leaving the
  DB claiming an operation succeeded when the server refused it.

The class is deliberately thin: every method maps to one logical IMAP
operation and returns plain Python values. No business logic (whitelists,
thread tracking, attachment extraction, etc.) lives here — that's the
add-on's job. Keeping this layer narrow makes isolated testing
straightforward and means adding a new operation usually means adding
one method.
"""

from __future__ import annotations

import imaplib
import re
import select as _select
import ssl
import time
from typing import Iterator, List, Optional


# ── Errors ──────────────────────────────────────────────────────────────────

class ImapError(Exception):
    """Raised when an IMAP command returns a non-OK status.

    Callers catch this to abort cleanly without committing local DB changes
    — a 'NO' response (folder gone, ACL denial, quota, malformed UID set)
    would otherwise leave the DB claiming an action succeeded while the
    server actually refused it.
    """


# ── Constants ───────────────────────────────────────────────────────────────

# IMAP SPECIAL-USE attribute → logical folder role. We treat ``\All``
# (Gmail's "All Mail") as an archive synonym — closest semantic match to
# "out of inbox but not trashed". Order matters: ``\Archive`` is checked
# before ``\All`` so a server advertising both keeps the dedicated archive.
_SPECIAL_USE_MAP = {
    b"\\Sent":    "sent",
    b"\\Drafts":  "drafts",
    b"\\Junk":    "junk",
    b"\\Trash":   "trash",
    b"\\Archive": "archive",
    b"\\All":     "archive",
}

# Mailcow/Dovecot/SOGo defaults for servers that don't advertise SPECIAL-USE.
DEFAULT_FOLDERS = {
    "sent":    "Sent",
    "drafts":  "Drafts",
    "junk":    "Junk",
    "trash":   "Trash",
    "archive": "Archive",
}

# Cap UID-set length per command. IMAP itself has no protocol limit, but
# many servers and middleware reject command lines past 8–16 KB. 100
# comma-joined UIDs (~600–1000 bytes) stays comfortably under every cap
# we've seen while keeping round-trips minimal.
UID_BATCH = 100

# LIST response: ``(<flags>) "<delim>" "<name>"``. Name can also be unquoted
# (atom) or NIL. Delimiter may be NIL for hierarchy-less servers.
_LIST_RE = re.compile(
    rb'^\(([^)]*)\)\s+(?:"([^"]*)"|NIL)\s+(?:"((?:[^"\\]|\\.)*)"|(\S+))\s*$'
)


# ── Module-level helpers (testable in isolation) ────────────────────────────

def parse_list_response(line):
    """Parse one LIST response line into ``(attrs:set[bytes], name:str)`` or None.

    Robust against tuple-wrapped literals (some imaplib paths return
    ``(metadata, payload)`` instead of a flat bytes string).
    """
    if not isinstance(line, (bytes, bytearray)):
        if isinstance(line, tuple) and line and isinstance(line[0], (bytes, bytearray)):
            line = line[0]
        else:
            return None
    m = _LIST_RE.match(line)
    if not m:
        return None
    attrs_blob, _qdelim, qname, uname = m.groups()
    raw_name = qname if qname is not None else uname
    if raw_name is None or raw_name == b"NIL":
        return None
    attrs = set(attrs_blob.split())
    return attrs, raw_name.decode("utf-8", errors="replace")


def _chunked(items, n):
    """Yield successive ``n``-sized chunks from a list."""
    for i in range(0, len(items), n):
        yield items[i:i + n]


def _parse_fetch_many_response(data) -> dict:
    """Parse an imaplib multi-UID FETCH response into ``{uid: (raw, seen)}``.

    imaplib returns interleaved entries: each message contributes a tuple
    ``(metadata_bytes, body_bytes)`` followed by a separator (``b")"``).
    UIDs may arrive out of order. We extract the UID + ``\\Seen`` flag from
    the metadata and pair them with the body.

    Anything that isn't a 2-tuple (separators, malformed entries) is
    silently skipped — this keeps us tolerant of server quirks without
    losing the messages that *did* come back cleanly.
    """
    result: dict = {}
    if not data:
        return result
    for entry in data:
        if not (isinstance(entry, tuple) and len(entry) >= 2):
            continue
        raw_meta, raw_body = entry[0], entry[1]
        if not isinstance(raw_meta, (bytes, bytearray)):
            continue
        try:
            meta_str = raw_meta.decode("ascii", errors="replace")
        except Exception:
            continue
        # Extract UID
        uid_match = re.search(r"\bUID\s+(\d+)", meta_str)
        if not uid_match:
            continue
        uid = int(uid_match.group(1))
        # Extract FLAGS list
        flags_match = re.search(r"FLAGS \(([^)]*)\)", meta_str)
        flag_tokens = flags_match.group(1).split() if flags_match else []
        seen = "\\Seen" in flag_tokens
        result[uid] = (raw_body, seen)
    return result


def _ssl_context(verify):
    """Build an SSL context, optionally disabling verification (self-signed certs)."""
    ctx = ssl.create_default_context()
    if not verify:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _ok(status_data, op_desc):
    """Raise :class:`ImapError` unless the response status is ``OK``.

    ``status_data`` is the ``(status, data)`` tuple returned by every
    imaplib call. Returns ``data`` on success so call sites can chain.
    """
    if not isinstance(status_data, tuple) or len(status_data) < 2:
        raise ImapError(f"IMAP {op_desc}: malformed response {status_data!r}")
    status, data = status_data
    if status != "OK":
        detail = ""
        if data:
            parts = [d for d in data if isinstance(d, (bytes, bytearray))]
            if parts:
                detail = b" ".join(parts).decode("utf-8", errors="replace")
        raise ImapError(f"IMAP {op_desc} failed: {status} {detail}".strip())
    return data


def _expand_uid_set(uid_set: str) -> List[int]:
    """Expand an IMAP UID set (``"5,10:12"``) into a flat ``[5, 10, 11, 12]``.

    Handles single ids, comma lists, and inclusive ranges. The IMAP wildcard
    ``*`` is left unresolved (it must be substituted by the server in
    COPYUID/MOVEUID responses, so we never see it here in practice).
    """
    out: List[int] = []
    for part in uid_set.split(","):
        part = part.strip()
        if not part:
            continue
        if ":" in part:
            lo_s, hi_s = part.split(":", 1)
            try:
                lo, hi = int(lo_s), int(hi_s)
            except ValueError:
                continue
            if lo > hi:
                lo, hi = hi, lo
            out.extend(range(lo, hi + 1))
        else:
            try:
                out.append(int(part))
            except ValueError:
                continue
    return out


def _parse_copyuid(raw) -> dict:
    """Parse a ``COPYUID`` response into ``{src_uid: dst_uid}``.

    RFC 4315 / 6851 format::

        COPYUID <uidvalidity> <src-uid-set> <dst-uid-set>

    Both sets are positional, so we zip them after range-expansion. Returns
    an empty dict if the response is missing or malformed — the caller's
    fallback path (Message-ID reconciliation or imap_uid=NULL) takes over.

    ``raw`` accepts either the tuple ``(code, [bytes])`` returned by
    ``imaplib.IMAP4.response()`` or a single bytes/str payload.
    """
    payload = None
    if isinstance(raw, tuple) and len(raw) == 2 and raw[1]:
        first = raw[1][0]
        if isinstance(first, (bytes, bytearray)):
            payload = first.decode("utf-8", errors="replace")
    elif isinstance(raw, (bytes, bytearray)):
        payload = raw.decode("utf-8", errors="replace")
    elif isinstance(raw, str):
        payload = raw
    if not payload:
        return {}
    # Tolerate the bracketed form some servers return inside the OK line.
    payload = payload.strip().strip("[]")
    if payload.upper().startswith("COPYUID "):
        payload = payload[len("COPYUID "):]
    parts = payload.split()
    if len(parts) < 3:
        return {}
    src_uids = _expand_uid_set(parts[1])
    dst_uids = _expand_uid_set(parts[2])
    if len(src_uids) != len(dst_uids):
        return {}
    return dict(zip(src_uids, dst_uids))


# ── IDLE protocol helpers (RFC 2177) ────────────────────────────────────────

def _read_until_tag(mail, tag, max_lines=50):
    """Read lines from IMAP until the tagged response or a safety limit.

    Prevents infinite spin when the connection is in a broken state where
    ``readline()`` returns empty or unexpected data in a tight loop. Raises
    ConnectionError if readline() returns empty bytes (connection lost)
    or if ``max_lines`` is exceeded without finding the tag.
    """
    for _ in range(max_lines):
        line = mail.readline()
        if not line:
            raise ConnectionError("IMAP connection lost (empty readline)")
        if line.startswith(tag):
            return line
    raise ConnectionError(
        f"IMAP protocol error: did not receive tagged response after {max_lines} lines"
    )


def _do_idle(mail, timeout):
    """Run one IDLE round-trip against an open imaplib connection.

    Sends ``IDLE`` and waits for server notifications via ``select()``.
    Returns True if new mail was detected (``EXISTS`` / ``RECENT``),
    False on timeout. Raises ConnectionError if the server closes the
    connection mid-IDLE.

    ``EXPUNGE`` notifications (e.g. from our own ``UID MOVE`` running on
    another connection) are silently absorbed — we only react to messages
    that signal arrival, not disappearance.
    """
    tag = mail._new_tag()
    mail.send(tag + b' IDLE\r\n')
    resp = mail.readline()
    if not resp.startswith(b'+'):
        return False

    sock = mail.socket()
    deadline = time.time() + timeout
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            break
        ready = _select.select([sock], [], [], min(remaining, 30))
        if ready[0]:
            data = sock.recv(4096)
            if not data:
                raise ConnectionError("IMAP connection closed during IDLE")
            if b'EXISTS' in data or b'RECENT' in data:
                mail.send(b'DONE\r\n')
                _read_until_tag(mail, tag)
                return True

    mail.send(b'DONE\r\n')
    _read_until_tag(mail, tag)
    return False


# ── The client class ────────────────────────────────────────────────────────

class ImapClient:
    """Thin, opinionated wrapper around :mod:`imaplib`.

    Use as a context manager so the connection is always closed::

        with ImapClient(config) as imap:
            imap.set_seen("INBOX", [42, 43])

    For test injection, pass ``_connection=<mock>`` to bypass the real
    network setup::

        client = ImapClient(cfg, _connection=mock_imaplib_obj)
    """

    def __init__(self, config: dict, *, _connection=None):
        self._config = config
        self._mail = _connection                # ``None`` until connect()
        self._folder_map: Optional[dict] = None
        self._all_folders: Optional[List[str]] = None
        self._selected: Optional[str] = None    # current SELECTed folder
        self._move_supported: Optional[bool] = None
        self._idle_supported: Optional[bool] = None
        self._caps_cache: Optional[bytes] = None

    # --- Context manager ---------------------------------------------------

    def __enter__(self) -> "ImapClient":
        if self._mail is None:
            self.connect()
        return self

    def __exit__(self, *exc) -> None:
        self.logout()

    # --- Connection lifecycle ---------------------------------------------

    def connect(self) -> None:
        """Open the IMAP connection and authenticate.

        Idempotent: a second call while already connected is a no-op.
        Supports both implicit TLS (port 993) and STARTTLS (port 143)
        based on ``config['imap_starttls']``.
        """
        if self._mail is not None:
            return
        cfg = self._config
        ctx = _ssl_context(cfg.get("ssl_verify", True))
        if cfg.get("imap_starttls", False):
            mail = imaplib.IMAP4(cfg["imap_host"], cfg["imap_port"])
            mail.starttls(ssl_context=ctx)
        else:
            mail = imaplib.IMAP4_SSL(
                cfg["imap_host"], cfg["imap_port"], ssl_context=ctx
            )
        mail.login(cfg["username"], cfg["password"])
        self._mail = mail

    def logout(self) -> None:
        """Close the connection gracefully. Safe to call repeatedly."""
        if self._mail is None:
            return
        try:
            self._mail.logout()
        except Exception:
            pass
        finally:
            self._mail = None
            self._selected = None

    @property
    def selected(self) -> Optional[str]:
        """The folder currently SELECTed on the server (or None)."""
        return self._selected

    @property
    def raw(self):
        """Escape hatch: the underlying imaplib object.

        Provided for the small number of low-level paths (e.g. raw
        ``noop()`` during IDLE keepalive) where wrapping each method
        would add noise without value. Prefer the client API.
        """
        return self._mail

    # --- Capabilities ------------------------------------------------------

    def _capabilities(self) -> bytes:
        if self._caps_cache is None:
            status, caps = self._mail.capability()
            if status != "OK":
                return b""
            self._caps_cache = b" ".join(caps).upper()
        return self._caps_cache

    def supports_move(self) -> bool:
        """RFC 6851 ``UID MOVE`` support. Falls back to COPY+STORE+EXPUNGE."""
        if self._move_supported is None:
            try:
                self._move_supported = b"MOVE" in self._capabilities()
            except Exception:
                return False
        return self._move_supported

    def supports_idle(self) -> bool:
        """RFC 2177 IDLE support. Falls back to interval polling."""
        if self._idle_supported is None:
            try:
                self._idle_supported = b"IDLE" in self._capabilities()
            except Exception:
                return False
        return self._idle_supported

    # --- Selection ---------------------------------------------------------

    def select(self, folder: str) -> None:
        """``SELECT`` a folder. Idempotent — repeated calls are no-ops."""
        if self._selected == folder:
            return
        _ok(self._mail.select(folder), f"SELECT {folder}")
        self._selected = folder

    # --- Folder discovery --------------------------------------------------

    def discover_folders(self) -> dict:
        """Return logical-role → server-folder name mapping (cached).

        Priority per role:
          1. ``config['folders'][role]`` override
          2. Server SPECIAL-USE attribute (RFC 6154)
          3. Mailcow/Dovecot default ("Junk", "Trash", …)

        Always includes ``inbox → 'INBOX'``. As a side benefit, the same
        LIST response is used to populate :meth:`list_folders`, so the
        two methods share a single round-trip on the first call.
        """
        if self._folder_map is not None:
            return self._folder_map

        overrides = {}
        cfg_folders = (self._config.get("folders") or {})
        if isinstance(cfg_folders, dict):
            for role in DEFAULT_FOLDERS:
                v = cfg_folders.get(role)
                if isinstance(v, str) and v.strip():
                    overrides[role] = v.strip()

        discovered = {}
        all_names: List[str] = []
        try:
            status, lines = self._mail.list()
        except Exception as e:
            # LIST is best-effort: we'll fall back to Dovecot defaults below.
            # Log the failure though — otherwise a wrong-folder MOVE later
            # ("Junk doesn't exist; the server calls it SPAM") looks like a
            # destination error with no trace of LIST having quietly failed.
            print(
                f"[imap_client] WARN: LIST failed ({type(e).__name__}: {e}) — "
                "falling back to default folder names",
                flush=True,
            )
            status, lines = ("NO", [])
        if status == "OK" and lines:
            for line in lines:
                parsed = parse_list_response(line)
                if not parsed:
                    continue
                attrs, name = parsed
                all_names.append(name)
                for attr_bytes, role in _SPECIAL_USE_MAP.items():
                    if attr_bytes in attrs and role not in discovered:
                        discovered[role] = name

        result = {"inbox": "INBOX"}
        for role, default in DEFAULT_FOLDERS.items():
            result[role] = overrides.get(role) or discovered.get(role) or default

        self._folder_map = result
        self._all_folders = all_names
        return result

    def list_folders(self) -> List[str]:
        """Return every folder name advertised by the server (cached)."""
        if self._all_folders is not None:
            return self._all_folders
        # Cold cache → populate via discovery
        self.discover_folders()
        return self._all_folders or []

    # --- Search / Fetch ---------------------------------------------------

    def search_new(self, folder: str, last_uid: int) -> List[int]:
        """Return UIDs greater than ``last_uid``, or all ``UNSEEN`` if 0.

        SELECTs the folder if not already current.
        """
        self.select(folder)
        if last_uid > 0:
            data = _ok(
                self._mail.uid("search", None, f"UID {last_uid + 1}:*"),
                f"UID SEARCH > {last_uid} in {folder}",
            )
        else:
            data = _ok(
                self._mail.uid("search", None, "UNSEEN"),
                f"UID SEARCH UNSEEN in {folder}",
            )
        if not data or not data[0]:
            return []
        return [int(u) for u in data[0].split()]

    def find_uid_by_message_id(self, folder: str, message_id: str) -> Optional[int]:
        """Resolve a message's UID in ``folder`` via its ``Message-ID`` header.

        Recovery path for DB rows that predate UID snapshotting
        ("pre-migration" rows with ``imap_uid IS NULL``): without a stored
        UID, flag operations like mark-read can only update the local DB,
        leaving the server's ``\\Seen`` state permanently stale. Searching by
        the globally-unique Message-ID re-anchors such rows to a live UID.

        Searches the bracketed form (``<id>``) — RFC 5322 mandates angle
        brackets in the header, and the substring semantics of ``HEADER``
        (RFC 3501 §6.4.4) would otherwise let a bare id match a longer,
        unrelated Message-ID that merely contains it.

        Returns the highest matching UID (a message can appear twice after a
        COPY; the newest copy is the one the server would re-report), or
        ``None`` when the id is empty/unquotable or nothing matches. Raises
        :class:`ImapError` on a non-OK SEARCH reply.
        """
        mid = (message_id or "").strip().strip("<>")
        # Reject double-quotes (unrepresentable in an IMAP quoted string) and
        # CR/LF/NUL: a folded Message-ID header preserves internal CRLF, which
        # imaplib would forward verbatim into the SEARCH command (command
        # injection). Such ids are malformed anyway — bail out.
        if not mid or any(c in mid for c in '"\r\n\x00'):
            return None
        self.select(folder)
        data = _ok(
            self._mail.uid("search", None, "HEADER", "Message-ID", f'"<{mid}>"'),
            f"UID SEARCH HEADER Message-ID in {folder}",
        )
        if not data or not data[0]:
            return None
        uids = [int(u) for u in data[0].split()]
        return max(uids) if uids else None

    def fetch_peek(self, folder: str, uid: int):
        """Fetch one message with ``BODY.PEEK[]`` — preserves the \\Seen flag.

        Returns ``(raw_bytes, was_seen)``. ``was_seen`` reflects the
        server-side flag at the moment of fetch, so the caller can decide
        the initial DB ``is_read`` state from the actual server state
        rather than assuming.

        Returns ``(None, False)`` if the server returns an empty result —
        callers must handle that gracefully (rare; usually means the UID
        was expunged between SEARCH and FETCH).

        Convenience wrapper around :meth:`fetch_peek_many`. For batches of
        more than one message, prefer the batched form — it cuts N
        round-trips down to ``ceil(N / UID_BATCH)``.
        """
        results = self.fetch_peek_many(folder, [uid])
        return results.get(uid, (None, False))

    def fetch_peek_many(self, folder: str, uids: List[int]):
        """Fetch many messages in one round-trip per ``UID_BATCH`` chunk.

        Returns ``{uid: (raw_bytes, was_seen)}``. UIDs absent from the
        server's reply (e.g. expunged between SEARCH and FETCH) are
        simply omitted — callers iterate the input list and skip missing
        keys.

        Without batching the poller incurs one network round-trip per
        new UID. On a 100-message backlog (typical after a poller
        outage) that's 5–20 s of avoidable latency; batching collapses
        it to one or two round-trips.
        """
        out: dict = {}
        if not uids:
            return out
        self.select(folder)
        for batch in _chunked(uids, UID_BATCH):
            uid_set = ",".join(str(u) for u in batch)
            data = _ok(
                self._mail.uid("fetch", uid_set, "(FLAGS BODY.PEEK[])"),
                f"UID FETCH {len(batch)} UIDs from {folder}",
            )
            out.update(_parse_fetch_many_response(data))
        return out

    # --- Flag / move operations -------------------------------------------

    def set_seen(self, folder: str, uids: List[int], seen: bool = True) -> None:
        """``UID STORE +/-FLAGS (\\Seen)`` on multiple UIDs (chunked).

        Raises :class:`ImapError` on any non-OK response — caller can skip
        its DB mirror update.
        """
        if not uids:
            return
        self.select(folder)
        flag_op = "+FLAGS" if seen else "-FLAGS"
        for batch in _chunked(uids, UID_BATCH):
            uid_set = ",".join(str(u) for u in batch)
            # RFC 3501 §6.4.6: the flag list argument to UID STORE must be a
            # parenthesised list, even when it contains a single flag. Lenient
            # servers (Dovecot, Exchange) accept the unparenthesised form, but
            # strict ones (GreenMail, Cyrus, some O365 tenants) reject it with
            # BAD. Always wrap in parens for portability.
            _ok(
                self._mail.uid("store", uid_set, flag_op, "(\\Seen)"),
                f"UID STORE {flag_op} (\\Seen) on {len(batch)} UIDs in {folder}",
            )

    def move(self, src_folder: str, uids: List[int], dest_folder: str) -> dict:
        """Move ``uids`` from ``src_folder`` to ``dest_folder`` server-side.

        Returns ``{src_uid: dst_uid}`` for every UID the server reported a
        new identity for (via COPYUID — RFC 4315 / 6851). Servers without
        UIDPLUS return an empty mapping; the caller should then clear
        ``imap_uid`` on those rows so subsequent triage commands fail loudly
        rather than silently no-op'ing against a stale source UID.

        Prefers ``UID MOVE`` (RFC 6851); transparently falls back to
        ``UID COPY`` + ``UID STORE +FLAGS \\Deleted`` + ``EXPUNGE`` for
        servers that don't advertise MOVE. Both paths chunk large UID
        sets to stay under server command-line limits.

        Atomicity: on the COPY+STORE+EXPUNGE fallback, a failure after the
        successful COPY attempts a best-effort ``STORE -FLAGS \\Deleted``
        on the source UIDs to undo the half-move. The COPY in the
        destination remains (we can't un-COPY) — but at least the source
        copy isn't tombstoned. Without this, a partial failure leaves the
        message in *both* folders and a subsequent retry creates a third
        copy. The original ``ImapError`` is always re-raised.

        Idempotent when ``src_folder == dest_folder`` (no-op).
        """
        if not uids or src_folder == dest_folder:
            return {}
        self.select(src_folder)
        use_move = self.supports_move()
        result: dict = {}
        for batch in _chunked(uids, UID_BATCH):
            uid_set = ",".join(str(u) for u in batch)
            # Clear any stale COPYUID from a prior command so the next
            # response() call returns only this batch's mapping.
            self._mail.response("COPYUID")
            if use_move:
                _ok(
                    self._mail.uid("MOVE", uid_set, dest_folder),
                    f"UID MOVE {len(batch)} → {dest_folder}",
                )
                result.update(_parse_copyuid(self._mail.response("COPYUID")))
            else:
                _ok(
                    self._mail.uid("COPY", uid_set, dest_folder),
                    f"UID COPY {len(batch)} → {dest_folder}",
                )
                result.update(_parse_copyuid(self._mail.response("COPYUID")))
                try:
                    # See RFC 3501 §6.4.6 note above: the flag list must be
                    # parenthesised even for a single flag.
                    _ok(
                        self._mail.uid("STORE", uid_set, "+FLAGS", "(\\Deleted)"),
                        f"UID STORE (\\Deleted) on {len(batch)}",
                    )
                    _ok(self._mail.expunge(), "EXPUNGE")
                except ImapError:
                    # Half-move: COPY landed in dest but the source is in an
                    # ambiguous state (possibly \Deleted, definitely not
                    # expunged). Attempt to unflag so the source row survives.
                    # Swallow rollback errors — we'll surface the original
                    # failure either way.
                    try:
                        self._mail.uid("STORE", uid_set, "-FLAGS", "(\\Deleted)")
                    except Exception:
                        pass
                    raise
        return result

    # --- IDLE (RFC 2177) --------------------------------------------------

    def idle(self, timeout: int) -> bool:
        """Enter IDLE; return True on new mail (EXISTS/RECENT), False on timeout.

        Raises ``ConnectionError`` if the server drops mid-IDLE so the
        caller can reconnect. Single-folder by design: IDLE binds to the
        currently SELECTed folder, and we only ever IDLE on INBOX (the
        only folder we poll *from*).
        """
        return _do_idle(self._mail, timeout)

    def noop(self) -> None:
        """Send ``NOOP`` to keep the connection alive between IDLEs."""
        self._mail.noop()
