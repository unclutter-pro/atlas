"""Per-account email database — schema, migrations, and typed access.

Centralises every SQL touch that ``email-addon.py`` used to do inline. The
command code now talks to :class:`EmailDb` via typed methods like
``insert_incoming`` / ``set_emails_folder`` / ``list_threads`` and never
sees the underlying SQL.

Two table-backed entities are returned as frozen dataclasses
(:class:`Thread`, :class:`Email`); a smaller :class:`EmailTarget` carries
just the columns the triage layer (mark-read / move) needs.

Lifecycle: ``EmailDb.open(config)`` opens the connection, applies schema
+ migrations + the legacy-row backfill, and hands back a ready-to-use
instance. Use as a context manager (or call ``.close()`` explicitly).
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable, List, Mapping, Optional, Tuple


__all__ = [
    "EmailDb",
    "EmailDbSchemaError",
    "Thread",
    "Email",
    "EmailTarget",
    "Attachment",
]


class EmailDbSchemaError(RuntimeError):
    """Raised when the per-account DB is missing required tables or columns.

    The schema bootstrap is normally self-healing (idempotent ``CREATE
    TABLE IF NOT EXISTS`` + targeted ``ALTER TABLE``) so this should never
    fire in steady state. When it does, it means migrations failed
    mid-run, the DB file is corrupted, or an older binary is talking to a
    newer schema (or vice versa).

    Failing loud here is intentional — see the 2026-05-26 post-mortem:
    a session continued for hours against a DB missing the ``messages``
    table and ``from_addr`` column, every query erroring out into
    graceful-degradation paths nobody noticed.
    """


# ── Entity types ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Thread:
    """One row of the ``threads`` table, with JSON columns pre-decoded."""

    thread_id: str
    subject: str
    last_message_id: str
    references_chain: List[str]
    last_sender: str
    last_sender_full: str
    last_cc: str
    participants: List[str]
    message_count: int
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class Email:
    """One row of the ``emails`` table."""

    id: int
    thread_id: str
    message_id: str
    direction: str           # "in" | "out"
    sender: str
    recipient: str
    cc: str
    subject: str
    body: str
    body_html: str
    headers_json: str
    inbox_msg_id: Optional[int]
    imap_uid: Optional[int]
    is_read: int
    folder: str
    created_at: str


@dataclass(frozen=True)
class EmailTarget:
    """Subset of an Email row used by mark-read / archive / move.

    Carries only the columns the IMAP-action layer needs, so resolving
    a thread_id to many rows stays cheap.
    """

    id: int
    imap_uid: Optional[int]
    folder: str
    message_id: str
    direction: str


@dataclass(frozen=True)
class Attachment:
    """One row of the ``attachments`` table.

    Attachments are extracted from incoming multipart messages and saved
    to disk under ``ATTACHMENTS_DIR/<thread_id>/`` by the poller; this
    row keeps the metadata so display commands (``email read`` /
    ``email thread``) can surface them without re-scanning the filesystem.
    """

    id: int
    email_id: int
    filename: str
    content_type: str
    size: int
    path: str


# ── Result-row → entity helpers ─────────────────────────────────────────────

# Cached column ordering for the SELECT * style reads used by get_thread /
# get_email. Populated lazily from the cursor description so a schema migration
# down the line doesn't force us to keep these in sync by hand.
_THREAD_COLS = (
    "thread_id", "subject", "last_message_id", "references_chain",
    "last_sender", "last_sender_full", "last_cc", "participants",
    "message_count", "created_at", "updated_at",
)
_EMAIL_COLS = (
    "id", "thread_id", "message_id", "direction", "sender", "recipient",
    "cc", "subject", "body", "body_html", "headers_json", "inbox_msg_id",
    "imap_uid", "is_read", "folder", "created_at",
)
_ATTACHMENT_COLS = (
    "id", "email_id", "filename", "content_type", "size", "path",
)


def _row_to_thread(row: Mapping[str, Any]) -> Thread:
    return Thread(
        thread_id        = row["thread_id"],
        subject          = row["subject"],
        last_message_id  = row["last_message_id"],
        references_chain = json.loads(row["references_chain"] or "[]"),
        last_sender      = row["last_sender"],
        last_sender_full = row["last_sender_full"],
        last_cc          = row["last_cc"] or "",
        participants     = json.loads(row["participants"] or "[]"),
        message_count    = row["message_count"],
        created_at       = row["created_at"],
        updated_at       = row["updated_at"],
    )


def _row_to_email(row: Mapping[str, Any]) -> Email:
    return Email(
        id           = row["id"],
        thread_id    = row["thread_id"],
        message_id   = row["message_id"],
        direction    = row["direction"],
        sender       = row["sender"],
        recipient    = row["recipient"],
        cc           = row["cc"],
        subject      = row["subject"],
        body         = row["body"],
        body_html    = row["body_html"],
        headers_json = row["headers_json"],
        inbox_msg_id = row["inbox_msg_id"],
        imap_uid     = row["imap_uid"],
        is_read      = row["is_read"],
        folder       = row["folder"],
        created_at   = row["created_at"],
    )


def _row_to_attachment(row: Mapping[str, Any]) -> Attachment:
    return Attachment(
        id           = row["id"],
        email_id     = row["email_id"],
        filename     = row["filename"],
        content_type = row["content_type"],
        size         = row["size"],
        path         = row["path"],
    )


# ── Repository ──────────────────────────────────────────────────────────────

class EmailDb:
    """Repository over a single account's SQLite database.

    Construct via :meth:`open` so schema + migrations are applied. The
    instance owns its connection and closes it on context-manager exit.
    """

    # --- Construction / lifecycle -----------------------------------------

    def __init__(self, conn: sqlite3.Connection):
        # Row factory so column access by name works (lets _row_to_* be tidy).
        conn.row_factory = sqlite3.Row
        self._conn = conn

    @classmethod
    def open(cls, config, db_dir: str) -> "EmailDb":
        """Open (or create) the account DB and apply schema + migrations.

        Args:
            config: Anything exposing ``.username`` (an :class:`EmailConfig`)
                or with ``config["username"]`` access (a plain mapping).
                Determines the per-account DB filename.
            db_dir: Directory holding the per-account ``.db`` files. The
                caller passes this explicitly so this module never has to
                import or guess at the host application's path constants.

        The DB path is ``{db_dir}/{sanitized-username}.db``.
        """
        user = _resolve_username(config)
        os.makedirs(db_dir, exist_ok=True)
        account = re.sub(r"[^a-zA-Z0-9@._-]", "_", user)
        db_path = os.path.join(db_dir, f"{account}.db")

        conn = sqlite3.connect(db_path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        instance = cls(conn)
        instance._bootstrap_schema()
        instance._validate_schema(db_path)
        return instance

    def __enter__(self) -> "EmailDb":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None  # type: ignore[assignment]

    def commit(self) -> None:
        self._conn.commit()

    @property
    def conn(self) -> sqlite3.Connection:
        """Escape hatch for callers that still need raw SQL (e.g. tests).

        Prefer the typed methods on this class. Long-term, every external
        ``conn.execute`` call site should migrate to a method here.
        """
        return self._conn

    # --- Schema + migrations ----------------------------------------------

    def _bootstrap_schema(self) -> None:
        """Create tables + indexes; apply idempotent migrations + backfill.

        Schema layout matches the legacy ``get_email_db`` exactly so this
        refactor is a behaviour-preserving move. The folder/is_read
        indexes are created *after* the migration ALTERs so a pre-existing
        DB without those columns doesn't crash mid-bootstrap.
        """
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS threads (
                thread_id       TEXT PRIMARY KEY,
                subject         TEXT NOT NULL DEFAULT '',
                last_message_id TEXT NOT NULL DEFAULT '',
                references_chain TEXT NOT NULL DEFAULT '[]',
                last_sender     TEXT NOT NULL DEFAULT '',
                last_sender_full TEXT NOT NULL DEFAULT '',
                last_cc         TEXT NOT NULL DEFAULT '',
                participants    TEXT NOT NULL DEFAULT '[]',
                message_count   INTEGER NOT NULL DEFAULT 0,
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS emails (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id       TEXT NOT NULL,
                message_id      TEXT NOT NULL DEFAULT '',
                direction       TEXT NOT NULL DEFAULT 'in',
                sender          TEXT NOT NULL DEFAULT '',
                recipient       TEXT NOT NULL DEFAULT '',
                cc              TEXT NOT NULL DEFAULT '',
                subject         TEXT NOT NULL DEFAULT '',
                body            TEXT NOT NULL DEFAULT '',
                body_html       TEXT NOT NULL DEFAULT '',
                headers_json    TEXT NOT NULL DEFAULT '{}',
                inbox_msg_id    INTEGER,
                imap_uid        INTEGER,
                is_read         INTEGER NOT NULL DEFAULT 0,
                folder          TEXT NOT NULL DEFAULT 'INBOX',
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (thread_id) REFERENCES threads(thread_id)
            );

            CREATE TABLE IF NOT EXISTS state (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT ''
            );

            -- Attachments persisted out-of-band — payload bytes live in
            -- ATTACHMENTS_DIR on disk; this table just keeps the metadata
            -- so display commands can show what came in without re-scanning
            -- the filesystem. ON DELETE CASCADE on email_id keeps the table
            -- consistent if/when emails are ever pruned.
            CREATE TABLE IF NOT EXISTS attachments (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                email_id        INTEGER NOT NULL,
                filename        TEXT NOT NULL DEFAULT '',
                content_type    TEXT NOT NULL DEFAULT '',
                size            INTEGER NOT NULL DEFAULT 0,
                path            TEXT NOT NULL DEFAULT '',
                FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_emails_thread      ON emails(thread_id);
            CREATE INDEX IF NOT EXISTS idx_emails_direction   ON emails(direction);
            CREATE INDEX IF NOT EXISTS idx_attachments_email  ON attachments(email_id);
            -- folder / is_read indexes are created post-migration (below).
        """)

        # Idempotent migrations for legacy databases — probe each column,
        # ALTER if absent. Order matters: cc/body_html before folder/is_read
        # so older DBs catch up step-by-step without referencing not-yet-added
        # columns from index DDL.
        #
        # ``message_id`` is technically part of the original schema, but we
        # include it here for forward-safety — any sufficiently-old DB
        # without it would otherwise break the post-migration message_id
        # index creation, and adding a defaulted column is harmless.
        #
        # Every column listed in _THREAD_COLS / _EMAIL_COLS must have a
        # backfill entry here so _validate_schema() never trips on a
        # sparse pre-existing DB. ``CREATE TABLE IF NOT EXISTS`` above
        # is a no-op on pre-existing tables, so columns added in a later
        # release of the schema only land via this loop.
        #
        # SQLite ALTER TABLE ADD COLUMN restriction: NOT NULL columns
        # need a *constant literal* DEFAULT — CURRENT_TIMESTAMP and
        # ``datetime('now')`` are both rejected. Timestamp backfills
        # therefore default to ''; see the per-entry comment below.
        for table, column, ddl in (
            ("emails",  "message_id",   "ALTER TABLE emails  ADD COLUMN message_id   TEXT NOT NULL DEFAULT ''"),
            ("emails",  "sender",       "ALTER TABLE emails  ADD COLUMN sender       TEXT NOT NULL DEFAULT ''"),
            ("emails",  "recipient",    "ALTER TABLE emails  ADD COLUMN recipient    TEXT NOT NULL DEFAULT ''"),
            ("emails",  "subject",      "ALTER TABLE emails  ADD COLUMN subject      TEXT NOT NULL DEFAULT ''"),
            ("emails",  "body",         "ALTER TABLE emails  ADD COLUMN body         TEXT NOT NULL DEFAULT ''"),
            ("emails",  "body_html",    "ALTER TABLE emails  ADD COLUMN body_html    TEXT NOT NULL DEFAULT ''"),
            ("emails",  "cc",           "ALTER TABLE emails  ADD COLUMN cc           TEXT NOT NULL DEFAULT ''"),
            ("emails",  "headers_json", "ALTER TABLE emails  ADD COLUMN headers_json TEXT NOT NULL DEFAULT '{}'"),
            ("emails",  "inbox_msg_id", "ALTER TABLE emails  ADD COLUMN inbox_msg_id INTEGER"),
            ("emails",  "imap_uid",     "ALTER TABLE emails  ADD COLUMN imap_uid     INTEGER"),
            ("emails",  "is_read",      "ALTER TABLE emails  ADD COLUMN is_read      INTEGER NOT NULL DEFAULT 0"),
            ("emails",  "folder",       "ALTER TABLE emails  ADD COLUMN folder       TEXT NOT NULL DEFAULT 'INBOX'"),
            # SQLite forbids CURRENT_TIMESTAMP / non-constant defaults
            # in ALTER … ADD COLUMN, so backfilled created_at rows get an
            # empty string. Fresh rows still get datetime('now') via the
            # CREATE TABLE default; this only affects legacy DBs that
            # somehow predate the original schema's created_at column.
            ("emails",  "created_at",   "ALTER TABLE emails  ADD COLUMN created_at   TEXT NOT NULL DEFAULT ''"),
            ("threads", "subject",          "ALTER TABLE threads ADD COLUMN subject          TEXT NOT NULL DEFAULT ''"),
            ("threads", "last_message_id",  "ALTER TABLE threads ADD COLUMN last_message_id  TEXT NOT NULL DEFAULT ''"),
            ("threads", "references_chain", "ALTER TABLE threads ADD COLUMN references_chain TEXT NOT NULL DEFAULT '[]'"),
            ("threads", "last_sender",      "ALTER TABLE threads ADD COLUMN last_sender      TEXT NOT NULL DEFAULT ''"),
            ("threads", "last_sender_full", "ALTER TABLE threads ADD COLUMN last_sender_full TEXT NOT NULL DEFAULT ''"),
            ("threads", "last_cc",          "ALTER TABLE threads ADD COLUMN last_cc          TEXT NOT NULL DEFAULT ''"),
            ("threads", "participants",     "ALTER TABLE threads ADD COLUMN participants     TEXT NOT NULL DEFAULT '[]'"),
            ("threads", "message_count",    "ALTER TABLE threads ADD COLUMN message_count    INTEGER NOT NULL DEFAULT 0"),
            # Backfill timestamps as '' (see emails.created_at comment).
            ("threads", "created_at",       "ALTER TABLE threads ADD COLUMN created_at       TEXT NOT NULL DEFAULT ''"),
            ("threads", "updated_at",       "ALTER TABLE threads ADD COLUMN updated_at       TEXT NOT NULL DEFAULT ''"),
        ):
            try:
                self._conn.execute(f"SELECT {column} FROM {table} LIMIT 0")
            except sqlite3.OperationalError:
                self._conn.execute(ddl)

        # One-time backfill: pre-migration outgoing rows would otherwise
        # inherit folder='INBOX' from the DEFAULT and falsely appear under
        # ``--folder INBOX`` filters. Pin them to 'Sent'.
        #
        # Gated on a state key so this UPDATE doesn't re-run on every
        # ``EmailDb.open()`` — the IDLE poller reconnects every ~25
        # minutes, and each reconnect would otherwise re-fire this
        # unindexed compound-filter UPDATE and grab a write lock for
        # nothing.
        if self._get_state("backfill_outgoing_folder_v1") != "done":
            # Run the UPDATE *and* the gate write in a single explicit
            # transaction, then commit before the gate is set persistent.
            # The old order (UPDATE + _set_state("done") + … + commit)
            # could persist the gate via an implicit auto-commit from a
            # subsequent CREATE INDEX while the UPDATE was still pending
            # — a crash in that narrow window would leave the gate at
            # "done" with no actual backfill applied.
            self._conn.execute(
                "UPDATE emails SET folder = 'Sent' "
                "WHERE direction = 'out' AND folder = 'INBOX' AND imap_uid IS NULL"
            )
            self._conn.commit()
            self._set_state("backfill_outgoing_folder_v1", "done")
            self._conn.commit()

        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_emails_folder     ON emails(folder)"
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_emails_is_read    ON emails(is_read)"
        )
        # ``find_thread_id_by_message_ids`` does ``WHERE message_id IN (…)``
        # for every inbound reply during thread resolution. Without this
        # index it's a full table scan per inbound message — measurable
        # latency above ~10k rows.
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id)"
        )
        # The CREATE INDEX / UPDATE backfill above start an implicit
        # transaction that would block a sibling connection's bootstrap
        # until this instance closes. Commit explicitly so concurrent
        # opens on the same DB file (multi-process / IDLE poller + CLI
        # invocation) don't deadlock on the schema-lock.
        self._conn.commit()

    # Source of truth for the schema probe below — reuses the same
    # column tuples that _row_to_thread / _row_to_email / _row_to_attachment
    # rely on, so they cannot drift independently.
    _REQUIRED_SCHEMA: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
        ("threads",     _THREAD_COLS),
        ("emails",      _EMAIL_COLS),
        ("attachments", _ATTACHMENT_COLS),
        ("state",       ("key", "value")),
    )

    def _validate_schema(self, db_path: str) -> None:
        """Assert that every required table + column exists post-bootstrap.

        Runs after ``_bootstrap_schema`` has created tables, applied
        migrations, and committed. Normally a no-op; raises
        :class:`EmailDbSchemaError` with the offending DB path on any
        mismatch so the caller sees a single loud failure instead of N
        downstream ``OperationalError`` surprises.
        """
        for table, expected_cols in self._REQUIRED_SCHEMA:
            try:
                cursor = self._conn.execute(f"PRAGMA table_info({table})")
            except sqlite3.OperationalError as exc:  # pragma: no cover — defensive
                raise EmailDbSchemaError(
                    f"email DB {db_path!r}: cannot inspect table {table!r} "
                    f"({exc})"
                ) from exc
            present_cols = {row[1] for row in cursor}
            if not present_cols:
                raise EmailDbSchemaError(
                    f"email DB {db_path!r}: required table {table!r} "
                    f"is missing after bootstrap"
                )
            missing = [c for c in expected_cols if c not in present_cols]
            if missing:
                raise EmailDbSchemaError(
                    f"email DB {db_path!r}: table {table!r} is missing "
                    f"required column(s) {missing!r} after bootstrap — "
                    f"migrations may have failed mid-run"
                )

    # --- Threads ----------------------------------------------------------

    def get_thread(self, thread_id: str) -> Optional[Thread]:
        row = self._conn.execute(
            "SELECT * FROM threads WHERE thread_id = ?", (thread_id,)
        ).fetchone()
        return _row_to_thread(row) if row else None

    def list_threads(
        self,
        *,
        folder: Optional[str] = None,
        unread: Optional[bool] = None,
        limit: int = 20,
    ) -> Tuple[List[Thread], bool]:
        """Return (threads, has_more).

        ``has_more`` indicates the result was truncated by ``limit`` —
        the caller can use it to render a "more results exist" hint
        without a second COUNT(*) round-trip.

        Filtering semantics (preserved from the inline SQL):
          - ``folder=X``: threads with at least one *incoming* msg in X
          - ``unread=True``: threads with at least one unread incoming msg
          - ``unread=False``: threads where every incoming msg is read
        """
        where: List[str] = []
        params: List[Any] = []
        if folder is not None:
            where.append(
                "EXISTS (SELECT 1 FROM emails e "
                "WHERE e.thread_id = t.thread_id AND e.direction='in' "
                "AND e.folder = ?)"
            )
            params.append(folder)
        if unread is True:
            where.append(
                "EXISTS (SELECT 1 FROM emails e "
                "WHERE e.thread_id = t.thread_id AND e.direction='in' "
                "AND e.is_read = 0)"
            )
        elif unread is False:
            where.append(
                "NOT EXISTS (SELECT 1 FROM emails e "
                "WHERE e.thread_id = t.thread_id AND e.direction='in' "
                "AND e.is_read = 0)"
            )

        sql = "SELECT * FROM threads t"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY t.updated_at DESC LIMIT ?"
        # Fetch one extra row so the caller can detect truncation without
        # a second COUNT(*).
        params.append(limit + 1)

        rows = self._conn.execute(sql, params).fetchall()
        has_more = len(rows) > limit
        if has_more:
            rows = rows[:limit]
        return [_row_to_thread(r) for r in rows], has_more

    def upsert_incoming_thread(
        self,
        *,
        thread_id: str,
        subject_clean: str,
        last_message_id: str,
        references: List[str],
        sender_addr: str,
        sender_full: str,
        cc_raw: str,
        cc_addrs: List[str],
    ) -> dict:
        """Insert or update a thread row to reflect a new incoming message.

        Merges sender + CC addresses into the existing ``participants`` set
        and bumps ``message_count``. Returns a small dict with the relevant
        fields, mirroring the legacy ``update_thread()`` return contract
        so the poll path can stay the same.
        """
        existing = self._conn.execute(
            "SELECT participants, message_count FROM threads WHERE thread_id = ?",
            (thread_id,),
        ).fetchone()

        if existing:
            participants = set(json.loads(existing["participants"] or "[]"))
            count = existing["message_count"] + 1
        else:
            participants = set()
            count = 1

        if sender_addr:
            participants.add(sender_addr)
        participants.update(cc_addrs)

        self._conn.execute(
            """
            INSERT INTO threads (thread_id, subject, last_message_id, references_chain,
                                 last_sender, last_sender_full, last_cc,
                                 participants, message_count, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET
                subject = excluded.subject,
                last_message_id = excluded.last_message_id,
                references_chain = excluded.references_chain,
                last_sender = excluded.last_sender,
                last_sender_full = excluded.last_sender_full,
                last_cc = excluded.last_cc,
                participants = excluded.participants,
                message_count = excluded.message_count,
                updated_at = excluded.updated_at
            """,
            (
                thread_id, subject_clean, last_message_id,
                json.dumps(references), sender_addr, sender_full, cc_raw,
                json.dumps(sorted(participants)), count,
                datetime.now().isoformat(),
            ),
        )
        return {
            "thread_id":       thread_id,
            "subject":         subject_clean,
            "last_message_id": last_message_id,
            "references":      references,
            "last_sender":     sender_addr,
            "cc":              cc_raw,
        }

    def insert_outgoing_thread(
        self,
        *,
        thread_id: str,
        subject: str,
        last_message_id: str,
        username: str,
        cc_raw: str,
        participants: List[str],
    ) -> None:
        """First-write for a thread the agent itself opened (cmd_send).

        Uses ``INSERT OR IGNORE`` because we don't want to clobber an
        existing thread row in the rare race where one already exists.
        """
        self._conn.execute(
            """
            INSERT OR IGNORE INTO threads
              (thread_id, subject, last_message_id, references_chain,
               last_sender, last_sender_full, last_cc, participants, message_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
            """,
            (
                thread_id, subject, last_message_id,
                json.dumps([last_message_id]),
                username, username, cc_raw,
                json.dumps(participants),
            ),
        )

    def update_thread_after_reply(
        self,
        *,
        thread_id: str,
        last_message_id: str,
        references: List[str],
        last_cc: str,
    ) -> None:
        """Append the agent's outgoing reply to the thread's references chain,
        bump ``message_count``, and refresh ``last_cc``.
        """
        self._conn.execute(
            """
            UPDATE threads SET
                last_message_id  = ?,
                references_chain = ?,
                last_cc          = ?,
                message_count    = message_count + 1,
                updated_at       = ?
            WHERE thread_id = ?
            """,
            (last_message_id, json.dumps(references), last_cc,
             datetime.now().isoformat(), thread_id),
        )

    def add_thread_participants(self, thread_id: str, new_addresses: Iterable[str]) -> None:
        """Merge new addresses into a thread's participant set.

        Used by cmd_reply when the user CCs someone new on a follow-up —
        keeps the thread's participant list comprehensive without leaking
        the JSON-blob storage shape into the caller.
        """
        row = self._conn.execute(
            "SELECT participants FROM threads WHERE thread_id = ?", (thread_id,)
        ).fetchone()
        if row is None:
            return
        existing = set(json.loads(row["participants"] or "[]"))
        existing.update(new_addresses)
        self._conn.execute(
            "UPDATE threads SET participants = ? WHERE thread_id = ?",
            (json.dumps(sorted(existing)), thread_id),
        )

    # --- Thread-id derivation ---------------------------------------------

    def find_thread_id_by_message_ids(self, ref_ids: Iterable[str]) -> Optional[str]:
        """Look up an existing thread by any of the supplied Message-IDs.

        Used by ``extract_thread_id`` strategy 1: a reply's ``In-Reply-To``
        / ``References`` headers point at our stored ``message_id`` column.

        Match is robust against either side using the bracketed (``<id>``)
        or bare (``id``) form: we normalize each input to *both* forms
        before searching, so a stored ``<x>`` is found from ``x`` input
        and vice versa.
        """
        ids = list(ref_ids)
        if not ids:
            return None
        search_ids: List[str] = []
        for r in ids:
            bare = r.strip("<>")
            search_ids.append(bare)
            search_ids.append(f"<{bare}>")
        placeholders = ",".join("?" * len(search_ids))
        row = self._conn.execute(
            f"SELECT thread_id FROM emails WHERE message_id IN ({placeholders}) "
            f"ORDER BY created_at ASC LIMIT 1",
            search_ids,
        ).fetchone()
        return row["thread_id"] if row else None

    def find_thread_id_by_subject(
        self, cleaned_subject: str, *, max_age_days: int = 14
    ) -> Optional[str]:
        """Look up a thread by cleaned subject within a recent window.

        Strategy 2 of ``extract_thread_id``: handles relays (e.g. SES) that
        rewrite the Message-ID so the inbound reply references an ID we
        never stored.
        """
        if not cleaned_subject:
            return None
        row = self._conn.execute(
            f"""SELECT thread_id FROM threads
                WHERE subject = ? AND updated_at > datetime('now', '-{int(max_age_days)} days')
                ORDER BY updated_at DESC LIMIT 1""",
            (cleaned_subject,),
        ).fetchone()
        return row["thread_id"] if row else None

    # --- Emails -----------------------------------------------------------

    def get_email(self, email_id: int) -> Optional[Email]:
        row = self._conn.execute(
            "SELECT * FROM emails WHERE id = ?", (email_id,)
        ).fetchone()
        return _row_to_email(row) if row else None

    def list_thread_emails(self, thread_id: str) -> List[Email]:
        rows = self._conn.execute(
            "SELECT * FROM emails WHERE thread_id = ? ORDER BY created_at",
            (thread_id,),
        ).fetchall()
        return [_row_to_email(r) for r in rows]

    def insert_outgoing_email(
        self,
        *,
        thread_id: str,
        message_id: str,
        sender: str,
        recipient: str,
        cc: str,
        subject: str,
        body: str,
    ) -> int:
        """Store one outbound message (cmd_send / cmd_reply).

        Outgoing rows land in ``folder='Sent'`` with ``is_read=1`` so they
        never surface in inbox/unread filters by accident, and they carry
        no ``imap_uid`` (we never fetched them from the server).
        """
        cur = self._conn.execute(
            """
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient,
                                cc, subject, body, folder, is_read)
            VALUES (?, ?, 'out', ?, ?, ?, ?, ?, 'Sent', 1)
            """,
            (thread_id, message_id, sender, recipient, cc, subject, body[:8000]),
        )
        return int(cur.lastrowid or 0)

    def find_email_by_message_id(self, message_id: str) -> Optional[Email]:
        """Look up one stored email by its RFC Message-ID header.

        Poller re-ingest guard: when the server re-reports a message we
        already stored (UID-watermark reset → ``UNSEEN`` search, UIDVALIDITY
        change renumbering the mailbox, a message bounced back into the
        polled folder), the poller must recognise it instead of inserting a
        duplicate unread row and re-firing the email-handler trigger on a
        historical thread.

        Matches either the bracketed (``<id>``) or bare stored form, same
        normalisation as :meth:`find_thread_id_by_message_ids`. Returns the
        oldest matching row, or ``None``.
        """
        bare = (message_id or "").strip().strip("<>")
        if not bare:
            return None
        row = self._conn.execute(
            "SELECT * FROM emails WHERE message_id IN (?, ?) "
            "ORDER BY id ASC LIMIT 1",
            (bare, f"<{bare}>"),
        ).fetchone()
        return _row_to_email(row) if row else None

    def insert_incoming_email(
        self,
        *,
        thread_id: str,
        message_id: str,
        sender_addr: str,
        cc: str,
        subject: str,
        body: str,
        body_html: str,
        imap_uid: int,
        folder: str,
        is_read: int,
    ) -> int:
        """Store one fetched-from-IMAP message.

        The caller has already decided the initial ``is_read`` from the
        server's FLAGS plus the ``mark_read`` config — see _fetch_new_emails
        for the precedence.
        """
        cur = self._conn.execute(
            """
            INSERT INTO emails (thread_id, message_id, direction, sender, cc,
                                subject, body, body_html,
                                imap_uid, folder, is_read)
            VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                thread_id, message_id, sender_addr, cc,
                subject, body[:8000], body_html[:50000],
                imap_uid, folder, is_read,
            ),
        )
        return int(cur.lastrowid or 0)

    # --- Attachments ------------------------------------------------------

    def insert_attachments(
        self, email_id: int, attachments: Iterable[Mapping[str, Any]]
    ) -> List[int]:
        """Persist attachment metadata for one email.

        Each ``attachments`` item must expose ``filename``, ``content_type``,
        ``size`` and ``path`` (the keys produced by
        ``email_addon.extract_attachments``). Empty/None inputs are a no-op
        so callers don't need to special-case "no attachments".

        Returns the list of newly-created attachment row IDs in insert order
        so callers can correlate back if needed (tests use this).
        """
        if not attachments:
            return []
        ids: List[int] = []
        for a in attachments:
            cur = self._conn.execute(
                """
                INSERT INTO attachments (email_id, filename, content_type, size, path)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    email_id,
                    str(a.get("filename") or ""),
                    str(a.get("content_type") or ""),
                    int(a.get("size") or 0),
                    str(a.get("path") or ""),
                ),
            )
            ids.append(int(cur.lastrowid or 0))
        return ids

    def list_attachments_for_email(self, email_id: int) -> List[Attachment]:
        """All attachments belonging to one email, in insert order."""
        rows = self._conn.execute(
            "SELECT * FROM attachments WHERE email_id = ? ORDER BY id",
            (email_id,),
        ).fetchall()
        return [_row_to_attachment(r) for r in rows]

    def list_attachments_for_thread(
        self, thread_id: str
    ) -> List[Attachment]:
        """All attachments across every email in a thread, ordered by email then insert order.

        Convenience for thread-level views that want to render attachments
        inline with each message without doing N+1 queries — callers can
        group by ``email_id`` once.
        """
        rows = self._conn.execute(
            """
            SELECT a.* FROM attachments a
            JOIN emails e ON e.id = a.email_id
            WHERE e.thread_id = ?
            ORDER BY a.email_id, a.id
            """,
            (thread_id,),
        ).fetchall()
        return [_row_to_attachment(r) for r in rows]

    def set_inbox_msg_id(
        self, *, thread_id: str, message_id: str, inbox_msg_id: int
    ) -> None:
        """Record the Atlas-inbox message ID against the just-inserted email.

        Called right after we've written the email into the cross-DB
        Atlas inbox — keeps the link bi-directional so triage commands
        can correlate back to the inbox row.
        """
        self._conn.execute(
            "UPDATE emails SET inbox_msg_id = ? "
            "WHERE thread_id = ? AND message_id = ?",
            (inbox_msg_id, thread_id, message_id),
        )

    def resolve_targets(self, ident: str) -> List[EmailTarget]:
        """Resolve an id-or-thread identifier to email rows.

        Numeric ``ident`` → single row by ``emails.id``. Anything else →
        every row in that thread (both directions; caller filters out
        outgoing rows when only IMAP-targetable messages matter).
        """
        if str(ident).isdigit():
            rows = self._conn.execute(
                "SELECT id, imap_uid, folder, message_id, direction "
                "FROM emails WHERE id = ?",
                (int(ident),),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT id, imap_uid, folder, message_id, direction "
                "FROM emails WHERE thread_id = ? ORDER BY id",
                (ident,),
            ).fetchall()
        return [
            EmailTarget(
                id         = r["id"],
                imap_uid   = r["imap_uid"],
                folder     = r["folder"],
                message_id = r["message_id"],
                direction  = r["direction"],
            )
            for r in rows
        ]

    def set_emails_is_read(self, ids: List[int], is_read: bool) -> None:
        """Mirror an IMAP \\Seen flip into the DB for the given email rows."""
        if not ids:
            return
        placeholders = ",".join("?" * len(ids))
        self._conn.execute(
            f"UPDATE emails SET is_read = ? WHERE id IN ({placeholders})",
            [1 if is_read else 0] + ids,
        )

    def set_emails_folder(self, ids: List[int], folder: str) -> None:
        """Mirror an IMAP UID MOVE into the DB for the given email rows."""
        if not ids:
            return
        placeholders = ",".join("?" * len(ids))
        self._conn.execute(
            f"UPDATE emails SET folder = ? WHERE id IN ({placeholders})",
            [folder] + ids,
        )

    def set_email_folder_and_uid(
        self, row_id: int, folder: str, imap_uid: Optional[int]
    ) -> None:
        """Atomic folder + UID rebind for one row after an IMAP MOVE.

        Captures the new UID the server assigned in the destination folder
        (parsed from COPYUID — RFC 4315 / 6851). When the server doesn't
        advertise UIDPLUS and no mapping was returned, the caller passes
        ``imap_uid=None`` to clear the now-stale UID — subsequent triage
        commands then fail loudly (``no stored UID``) rather than silently
        no-op'ing against a UID that no longer exists in the new folder.
        """
        self._conn.execute(
            "UPDATE emails SET folder = ?, imap_uid = ? WHERE id = ?",
            (folder, imap_uid, row_id),
        )

    # --- State ------------------------------------------------------------

    def get_last_uid(self) -> int:
        """Return the highest IMAP UID we've already polled, or 0."""
        row = self._conn.execute(
            "SELECT value FROM state WHERE key='last_uid'"
        ).fetchone()
        if row is None:
            return 0
        v = row["value"]
        return int(v) if v.isdigit() else 0

    def set_last_uid(self, uid: int) -> None:
        """Persist the highest IMAP UID we've polled."""
        self._set_state("last_uid", str(int(uid)))

    # --- Generic state KV (private) --------------------------------------

    def _get_state(self, key: str) -> Optional[str]:
        """Generic read from the ``state`` KV table."""
        row = self._conn.execute(
            "SELECT value FROM state WHERE key = ?", (key,)
        ).fetchone()
        return row["value"] if row is not None else None

    def _set_state(self, key: str, value: str) -> None:
        """Generic write into the ``state`` KV table."""
        self._conn.execute(
            "INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)",
            (key, value),
        )


# ── Internal helpers ────────────────────────────────────────────────────────

def _resolve_username(config: Any) -> str:
    """Extract ``username`` from either an EmailConfig or a Mapping."""
    user = getattr(config, "username", None)
    if user is None and isinstance(config, Mapping):
        user = config.get("username")
    return user or "default"
