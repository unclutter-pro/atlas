#!/usr/bin/env python3
"""
Email Communication Add-on.

Unified module for all email operations: polling IMAP, sending/replying via SMTP,
and thread tracking. Uses its own SQLite database per account.

Subcommands:
  poll   [--once]           Fetch new emails from IMAP, write to inbox, fire triggers
  send   <to> <subject> <body>   Send a new email
  reply  <thread_id> <body>      Reply to an existing thread
  threads [--limit N]       List tracked email threads
  thread <thread_id>        Show thread detail

Concurrency: poll fetches all new UIDs first, writes them to the email DB and
atlas inbox in a single pass, then fires triggers in the background (non-blocking)
so parallel threads don't block each other.
"""

import argparse
import email as emaillib
import email.utils
import fnmatch
import imaplib  # for imaplib.IMAP4.error caught at the top of cmd_poll(_idle)
import json
import os
import re
import signal
import smtplib
import sqlite3
import ssl
import subprocess
import sys
import time
from datetime import datetime
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, formatdate, make_msgid
from pathlib import Path

import html2text

# --- Paths ---
CONFIG_PATH = os.environ["HOME"] + "/config.yml"
RUNTIME_CONFIG_PATH = os.environ["HOME"] + "/.atlas-runtime-config.json"
ATLAS_DB_PATH = os.environ["HOME"] + "/.index/atlas.db"
EMAIL_DB_DIR = os.environ["HOME"] + "/.index/email"
WAKE_PATH = os.environ["HOME"] + "/.index/.wake"
TRIGGER_SCRIPT = "/atlas/app/triggers/trigger.sh"
TRIGGER_NAME = "email-handler"
ATTACHMENTS_DIR = os.environ["HOME"] + "/.index/email/attachments"
MESSAGES_DIR = os.environ["HOME"] + "/.index/email/messages"


# --- Config ---

# Configuration handling moved to email_config.EmailConfig. This thin
# wrapper preserves the legacy ``load_config()`` import path so old call
# sites keep working — production callers should use ``EmailConfig.load()``
# directly.
from email_config import (
    EmailConfig,
    extract_password_from_secret_blob as _extract_password_from_secret_blob,  # noqa: F401
)


def load_config():
    """Load email config — back-compat shim returning an :class:`EmailConfig`.

    The returned object behaves like the old plain ``dict`` (``config["foo"]``
    still works) but is also attribute-accessible (``config.foo``) and
    immutable. New code should call ``EmailConfig.load()`` directly.
    """
    return EmailConfig.load(
        config_path=CONFIG_PATH,
        runtime_path=RUNTIME_CONFIG_PATH,
    )


# --- IMAP client + SMTP helpers ---
#
# All IMAP protocol details live in imap_client.ImapClient — this file only
# orchestrates command flow on top of that abstraction. The factory below
# exists so tests can patch one well-known function to inject a mock client.

from imap_client import ImapClient, ImapError  # re-exported for back-compat


def _imap_client(config):
    """Factory for the IMAP client. Tests patch this with a mock."""
    return ImapClient(config)


def _ssl_context_for_smtp(config):
    """SSL context for the SMTP side. IMAP has its own in imap_client."""
    ctx = ssl.create_default_context()
    if not config.get("ssl_verify", True):
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _smtp_connect(config):
    """Connect to SMTP with STARTTLS, optionally disabling cert verification."""
    ctx = _ssl_context_for_smtp(config)
    server = smtplib.SMTP(config["smtp_host"], config["smtp_port"])
    server.starttls(context=ctx)
    server.login(config["username"], config["password"])
    return server


# --- Email Database ---
#
# Schema, migrations, and every typed query live in :mod:`email_db.EmailDb`.
# The thin factory below picks the DB directory and forwards through —
# every cmd_* function opens its DB via this single entry point.

from email_db import Email, EmailDb, EmailTarget, Thread  # noqa: F401


def open_email_db(config, *, db_dir: str | None = None) -> "EmailDb":
    """Open the per-account DB and apply schema + migrations.

    ``db_dir`` defaults to the module-level ``EMAIL_DB_DIR`` constant; tests
    redirect storage by monkeypatching that constant. The kwarg lets
    callers be explicit when the module-level location isn't appropriate
    (no ``globals()`` indirection — same shape as ``EmailConfig.load``'s
    explicit paths).
    """
    if db_dir is None:
        db_dir = EMAIL_DB_DIR
    return EmailDb.open(config, db_dir=db_dir)


# --- Thread helpers ---

def _clean_subject(subject):
    """Strip Re:/Fwd:/AW:/WG: prefixes and whitespace for comparison."""
    cleaned = re.sub(r"^(?:Re|Fwd|Fw|AW|WG)\s*:\s*", "", subject.strip(), flags=re.IGNORECASE)
    # Recurse in case of multiple prefixes like "Re: Fwd: ..."
    if cleaned != subject.strip():
        return _clean_subject(cleaned)
    return cleaned


def extract_thread_id(msg, db: "EmailDb | None" = None):
    """Extract thread identifier from email headers.

    Strategy (in order):
    1. Look up existing threads by referenced message IDs (References/In-Reply-To)
    2. Subject-based fallback: match against recent threads (last 14 days) with
       the same cleaned subject. Handles relay Message-ID rewriting (e.g. SES
       replaces the original Message-ID, so the recipient's reply references
       an ID we never stored).
    3. Derive from headers (original behavior) — creates a new thread.

    The DB-touching strategies are delegated to :class:`EmailDb` so the
    SQL stays in one place. When ``db`` is None the function still works
    — it just skips the lookups and falls through to strategy 3.
    """
    references = msg.get("References", "").strip()
    in_reply_to = msg.get("In-Reply-To", "").strip()

    # Collect all referenced message IDs
    ref_ids = []
    if references:
        ref_ids.extend(references.split())
    if in_reply_to and in_reply_to not in ref_ids:
        ref_ids.append(in_reply_to)

    # Strategy 1: Look up existing threads by any referenced message ID
    if db is not None and ref_ids:
        hit = db.find_thread_id_by_message_ids(ref_ids)
        if hit:
            return hit

    # Strategy 2: Subject-based fallback for replies (handles SES rewriting)
    subject = msg.get("Subject", "").strip()
    cleaned_subject = _clean_subject(subject)
    is_reply = subject.lower() != cleaned_subject.lower()  # Had a Re:/Fwd: prefix
    if db is not None and is_reply and cleaned_subject:
        hit = db.find_thread_id_by_subject(cleaned_subject)
        if hit:
            return hit

    # Strategy 3: Derive from headers (creates a new thread)
    if ref_ids:
        return sanitize_thread_id(ref_ids[0])

    message_id = msg.get("Message-ID", "").strip()
    return sanitize_thread_id(message_id) if message_id else f"email-{int(time.time())}"


def sanitize_thread_id(raw):
    clean = raw.strip("<>")
    clean = re.sub(r"[^a-zA-Z0-9@._-]", "_", clean)
    return clean[:128]


def build_references_chain(msg):
    """Build full references chain from email headers."""
    refs = []
    references = msg.get("References", "").strip()
    if references:
        refs = references.split()
    message_id = msg.get("Message-ID", "").strip()
    if message_id and message_id not in refs:
        refs.append(message_id)
    return refs


def _parse_address_list(header_value):
    """Parse a To/Cc/Bcc header value into a list of plain addresses.

    Handles RFC 5322 forms like ``"Alice <a@x>, b@x"`` correctly via
    ``email.utils.getaddresses``. Empty header → empty list.
    """
    if not header_value:
        return []
    pairs = emaillib.utils.getaddresses([header_value])
    return [addr.strip() for _, addr in pairs if addr and addr.strip()]


def update_thread(db: "EmailDb", thread_id: str, msg) -> dict:
    """Update thread state in the email DB to reflect an incoming message.

    Parses the email's headers (From, Cc, Subject, Message-ID, References)
    and forwards already-cleaned values into
    :meth:`EmailDb.upsert_incoming_thread`. Returns the small info dict
    the poll path expects (legacy contract preserved).
    """
    sender = msg.get("From", "")
    _, sender_addr = emaillib.utils.parseaddr(sender)
    cc_header = msg.get("Cc", "").strip()
    cc_addrs = _parse_address_list(cc_header)
    subject = msg.get("Subject", "(no subject)")
    subject_clean = _clean_subject(subject)
    message_id = msg.get("Message-ID", "").strip()
    references = build_references_chain(msg)

    return db.upsert_incoming_thread(
        thread_id=thread_id,
        subject_clean=subject_clean,
        last_message_id=message_id,
        references=references,
        sender_addr=sender_addr,
        sender_full=sender,
        cc_raw=cc_header,
        cc_addrs=cc_addrs,
    )


def _html_to_text(html):
    """Convert HTML to clean Markdown using html2text."""
    h = html2text.HTML2Text()
    h.body_width = 0          # Don't wrap lines
    h.ignore_images = False    # Keep inline images as ![alt](url)
    h.ignore_emphasis = False  # Keep bold/italic as markdown
    h.protect_links = True     # Keep URLs intact
    return h.handle(html).strip()


def get_body(msg):
    """Extract email body as Markdown text and raw HTML.

    Returns (markdown_body, raw_html) tuple. Prefers text/plain but falls
    back to HTML→Markdown if the plaintext part is suspiciously short
    (some clients send a truncated preview as text/plain while the full
    content is only in the HTML part).
    """
    plain_body = None
    html_body = None

    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            # Skip multipart containers and attachments
            if part.get_content_maintype() == "multipart":
                continue
            if part.get("Content-Disposition", "").startswith("attachment"):
                continue
            charset = part.get_content_charset() or "utf-8"
            try:
                payload = part.get_payload(decode=True)
                if not payload:
                    continue
                decoded = payload.decode(charset, errors="replace")
            except Exception:
                continue
            if ct == "text/plain" and plain_body is None:
                plain_body = decoded
            elif ct == "text/html" and html_body is None:
                html_body = decoded
    else:
        charset = msg.get_content_charset() or "utf-8"
        try:
            payload = msg.get_payload(decode=True)
            if payload:
                decoded = payload.decode(charset, errors="replace")
                if msg.get_content_type() == "text/html":
                    return _html_to_text(decoded), decoded
                return decoded, ""
        except Exception:
            pass
        return "", ""

    # If we have both, use plain unless it looks truncated
    if plain_body and html_body:
        html_text = _html_to_text(html_body)
        # If plaintext is much shorter than HTML text, the client likely
        # sent a preview-only plaintext part — use the HTML version instead
        if len(plain_body.strip()) < len(html_text.strip()) * 0.5 and len(plain_body.strip()) < 500:
            return html_text, html_body
        return plain_body, html_body
    if plain_body:
        return plain_body, html_body or ""
    if html_body:
        return _html_to_text(html_body), html_body
    return "", ""


def extract_attachments(msg, thread_id):
    """Extract and save attachments from an email. Returns list of attachment metadata."""
    if not msg.is_multipart():
        return []

    attachments = []
    save_dir = os.path.join(ATTACHMENTS_DIR, thread_id)

    for part in msg.walk():
        content_disposition = part.get("Content-Disposition", "")
        if "attachment" not in content_disposition and "inline" not in content_disposition:
            continue
        # Skip text parts that are the email body
        if part.get_content_type() in ("text/plain", "text/html") and "attachment" not in content_disposition:
            continue

        filename = part.get_filename()
        if not filename:
            ext = part.get_content_type().split("/")[-1]
            filename = f"attachment-{len(attachments) + 1}.{ext}"

        # Sanitize filename
        filename = re.sub(r"[^a-zA-Z0-9._-]", "_", filename)[:128]

        payload = part.get_payload(decode=True)
        if not payload:
            continue

        os.makedirs(save_dir, exist_ok=True)
        filepath = os.path.join(save_dir, filename)

        # Avoid overwriting existing files
        base, ext = os.path.splitext(filename)
        counter = 1
        while os.path.exists(filepath):
            filepath = os.path.join(save_dir, f"{base}-{counter}{ext}")
            counter += 1

        with open(filepath, "wb") as f:
            f.write(payload)

        attachments.append({
            "filename": filename,
            "content_type": part.get_content_type(),
            "size": len(payload),
            "path": filepath,
        })

    return attachments


def save_email_file(thread_id, sender, subject, date_str, body, attachments=None):
    """Save incoming email as a searchable markdown file."""
    thread_dir = os.path.join(MESSAGES_DIR, thread_id)
    os.makedirs(thread_dir, exist_ok=True)

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    filepath = os.path.join(thread_dir, f"{ts}.md")

    lines = [
        f"# {subject}",
        "",
        f"**From:** {sender}",
        f"**Date:** {date_str}",
        f"**Thread:** {thread_id}",
    ]

    if attachments:
        lines.append("")
        lines.append("**Attachments:**")
        for a in attachments:
            lines.append(f"- [{a['filename']}]({a['path']}) ({a['content_type']}, {a['size']} bytes)")

    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append(body[:8000])
    lines.append("")

    with open(filepath, "w") as f:
        f.write("\n".join(lines))

    return filepath


def is_whitelisted(sender, whitelist):
    if not whitelist:
        return True
    _, addr = emaillib.utils.parseaddr(sender)
    addr = addr.lower()
    for w in whitelist:
        w_lower = w.lower()
        if "*" in w or "?" in w:
            if fnmatch.fnmatch(addr, w_lower):
                return True
        elif addr == w_lower or addr.endswith(f"@{w_lower}"):
            return True
    return False


# --- Atlas inbox helper ---

def write_to_atlas_inbox(sender, content, thread_id):
    """Write email to the main Atlas inbox. Returns message ID."""
    with sqlite3.connect(ATLAS_DB_PATH) as atlas_db:
        atlas_db.execute("PRAGMA busy_timeout=5000")
        cursor = atlas_db.execute(
            "INSERT INTO messages (channel, sender, content) VALUES (?, ?, ?)",
            ("email", sender, content),
        )
        msg_id = cursor.lastrowid
        atlas_db.commit()
    # Touch .wake so main session picks up the message even if trigger.sh fails
    Path(WAKE_PATH).touch()
    return msg_id


# --- Shared fetch logic ---

def _fetch_new_emails(imap, db, config):
    """Fetch and process new emails through an :class:`ImapClient`.

    Reusable by both ``cmd_poll`` (one-shot) and ``cmd_poll_idle``
    (continuous IDLE). Returns the number of new emails stored.

    The client must already be connected; the caller manages its
    lifecycle. We re-SELECT the configured folder via
    :meth:`ImapClient.search_new` each call so it's safe even if a
    sibling operation switched folders in between.
    """
    # ``config['whitelist']`` is read by the loop below. The IDLE poller
    # (the only caller that lives long enough for the user to change the
    # whitelist mid-flight) calls ``_refresh_whitelist(config)`` between
    # IDLE ticks; the function itself stays pure — its behaviour is
    # fully determined by its arguments.
    whitelist = config.get("whitelist", [])

    last_uid = db.get_last_uid()

    folder = config.get("folder", "INBOX")
    try:
        uids = imap.search_new(folder, last_uid)
    except ImapError as e:
        print(f"[{datetime.now()}] {e}")
        return 0

    if not uids:
        return 0

    print(f"[{datetime.now()}] Found {len(uids)} new email(s)")

    max_uid = last_uid
    trigger_queue = []      # Collect triggers to fire after all emails stored
    mark_seen_uids = []     # Collect UIDs to mark \Seen in one batched call
    processed = 0

    # Single batched FETCH — chunked internally at UID_BATCH=100. This
    # replaces what used to be N sequential round-trips with ⌈N/100⌉.
    # PEEK preserves the server-side \Seen flag so ``mark_read: false``
    # actually works; we explicitly STORE below when configured.
    fresh_uids = [u for u in uids if u > last_uid]
    try:
        fetched = imap.fetch_peek_many(folder, fresh_uids)
    except ImapError as e:
        print(f"[{datetime.now()}] {e}")
        return 0

    for uid_int in fresh_uids:
        raw_and_seen = fetched.get(uid_int)
        if raw_and_seen is None:
            # UID was expunged between SEARCH and FETCH — rare but real.
            continue
        raw, server_is_read = raw_and_seen
        if not raw:
            continue

        msg = emaillib.message_from_bytes(raw)

        sender = msg.get("From", "unknown")
        cc_header = msg.get("Cc", "").strip()
        subject = msg.get("Subject", "(no subject)")
        body, body_html = get_body(msg)
        thread_id = extract_thread_id(msg, db)
        message_id_hdr = msg.get("Message-ID", "").strip()

        if not is_whitelisted(sender, whitelist):
            print(f"[{datetime.now()}] Blocked email from {sender}")
            max_uid = max(max_uid, uid_int)
            continue

        # 1. Update thread state in email DB
        thread_info = update_thread(db, thread_id, msg)

        # 1b. Extract attachments
        attachments = extract_attachments(msg, thread_id)

        # 2. Store email in email DB. We snapshot the IMAP UID + folder so the
        # mark-read/archive/spam/delete commands can later target this message
        # via UID STORE / UID MOVE without re-fetching anything.
        _, sender_addr = emaillib.utils.parseaddr(sender)
        # Effective read state: respect what the server says now, but if
        # mark_read=true we'll flip the server (and DB) to read after storage.
        will_mark_read = bool(config.get("mark_read", True))
        initial_is_read = 1 if (server_is_read or will_mark_read) else 0
        db.insert_incoming_email(
            thread_id=thread_id,
            message_id=message_id_hdr,
            sender_addr=sender_addr,
            cc=cc_header,
            subject=subject,
            body=body,
            body_html=body_html,
            imap_uid=uid_int,
            folder="INBOX",
            is_read=initial_is_read,
        )

        # 2b. Save as searchable file
        save_email_file(thread_id, sender, subject, msg.get("Date", ""), body, attachments)

        # 3. Write to agent inbox
        inbox_content = f"From: {sender}\n"
        if cc_header:
            inbox_content += f"Cc: {cc_header}\n"
        inbox_content += f"Subject: {subject}\n\n{body[:20000]}"
        if attachments:
            att_summary = "\n".join(f"  - {a['filename']} ({a['content_type']}, {a['size']} bytes): {a['path']}" for a in attachments)
            inbox_content += f"\n\nAttachments:\n{att_summary}"
        inbox_msg_id = write_to_atlas_inbox(sender, inbox_content, thread_id)

        # Link the freshly-inserted email row back to the inbox row
        db.set_inbox_msg_id(
            thread_id=thread_id,
            message_id=message_id_hdr,
            inbox_msg_id=inbox_msg_id,
        )

        print(f"[{datetime.now()}] Email from {sender}: {subject[:60]} "
              f"(thread={thread_id}, inbox={inbox_msg_id})")

        # 4. Queue trigger (fire after all emails stored)
        payload_data = {
            "inbox_message_id": inbox_msg_id,
            "sender": sender,
            "cc": cc_header,
            "subject": subject,
            "body": body[:20000],
            "thread_id": thread_id,
            "message_id": message_id_hdr,
            "date": msg.get("Date", ""),
        }
        if attachments:
            payload_data["attachments"] = [
                {"filename": a["filename"], "content_type": a["content_type"],
                 "size": a["size"], "path": a["path"]} for a in attachments
            ]
        payload = json.dumps(payload_data)
        trigger_queue.append((payload, thread_id))

        if will_mark_read:
            mark_seen_uids.append(uid_int)

        max_uid = max(max_uid, uid_int)
        processed += 1

    # One batched STORE for all newly-fetched messages instead of one per UID
    # — the client chunks for us, so this is also safe for huge inboxes.
    if mark_seen_uids:
        try:
            imap.set_seen(folder, mark_seen_uids, seen=True)
        except ImapError as e:
            # Non-fatal: messages are stored locally; the next poll's
            # UID-watermark search keeps us from re-processing them.
            print(f"[{datetime.now()}] {e}")

    # Persist UID state
    if max_uid > last_uid:
        db.set_last_uid(max_uid)

    db.commit()

    # Fire triggers non-blocking (each thread gets its own trigger session)
    for payload, thread_id in trigger_queue:
        try:
            subprocess.Popen(
                [TRIGGER_SCRIPT, TRIGGER_NAME, payload, thread_id],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            print(f"[{datetime.now()}] Trigger fired for thread {thread_id}")
        except Exception as e:
            print(f"[{datetime.now()}] Failed to fire trigger for {thread_id}: {e}")

    return processed


# --- POLL command (--once mode) ---

def _refresh_whitelist(config):
    """Re-read the whitelist from disk and return a fresh config snapshot.

    The IDLE poller calls this between ticks so a user can edit
    ``config.yml`` (or the runtime JSON) and have the new whitelist
    apply on the next fetch — no restart needed.

    Returns the *new* :class:`EmailConfig` (or the same object on error).
    Centralising the reload here keeps ``_fetch_new_emails`` pure: its
    behaviour is fully determined by its arguments.
    """
    try:
        fresh = load_config()
    except Exception:
        return config  # any error → keep the previous snapshot

    # Reuse the existing object if nothing actually changed. Comparing
    # whitelists by value avoids spurious config-rotation noise.
    if fresh.get("whitelist", []) == config.get("whitelist", []):
        return config
    return fresh


def cmd_poll(config, once=False):
    """Fetch new emails from IMAP, store in DB, write to inbox, fire triggers."""
    if not config["imap_host"] or not config["username"] or not config["password"]:
        print(f"[{datetime.now()}] ERROR: Email not configured (IMAP). Set email section in config.yml")
        return

    db = open_email_db(config)

    try:
        with _imap_client(config) as imap:
            _fetch_new_emails(imap, db, config)
    except imaplib.IMAP4.error as e:
        print(f"[{datetime.now()}] IMAP error: {e}")
    except Exception as e:
        print(f"[{datetime.now()}] Error: {e}")
    finally:
        db.close()


# --- IMAP IDLE helpers ---

# Global flag for graceful shutdown
_shutdown_requested = False


def cmd_poll_idle(config):
    """Continuous email polling using IMAP IDLE (persistent connection).

    Opens a single IMAP connection, fetches any pending emails, then enters
    IDLE mode to wait for server-side push notifications. Re-enters IDLE
    every idle_timeout seconds (default 25 min) to stay within the RFC 2177
    29-minute server limit. Auto-reconnects on connection drops.

    Falls back to traditional polling if the server does not support IDLE.

    Single-folder invariant
    -----------------------
    IMAP IDLE is per-folder: you SELECT one folder and IDLE on it. We only
    IDLE on ``config['folder']`` (defaults to INBOX) — by design, since the
    inbox is the only folder we *poll from*. Archive / Junk / Trash are
    write targets (via ``email archive`` etc.) but never poll sources, so
    there's no need for cross-folder watching.

    Cross-folder side effects from our own triage commands (e.g. an
    ``email archive 5`` running on a separate connection issues UID MOVE
    out of INBOX) reach this connection as ``EXPUNGE`` notifications. The
    ``_imap_idle`` loop only wakes on ``EXISTS`` / ``RECENT``, so those
    EXPUNGEs are silently absorbed without triggering false-positive
    fetches.
    """
    global _shutdown_requested
    _shutdown_requested = False

    idle_timeout = config.get("idle_timeout", 1500)
    poll_fallback_interval = int(os.environ.get("EMAIL_POLL_INTERVAL", 120))

    def _handle_signal(signum, frame):
        global _shutdown_requested
        sig_name = "SIGTERM" if signum == signal.SIGTERM else "SIGINT"
        print(f"[{datetime.now()}] {sig_name} received, shutting down gracefully...")
        _shutdown_requested = True

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    print(f"[{datetime.now()}] Email IDLE poller starting "
          f"(host={config['imap_host']}, idle_timeout={idle_timeout}s)")

    while not _shutdown_requested:
        imap = None
        db = None
        try:
            db = open_email_db(config)

            # Connect via the ImapClient — same factory as triage commands
            # so tests have one patch point.
            print(f"[{datetime.now()}] Connecting to {config['imap_host']}...")
            imap = _imap_client(config)
            imap.connect()
            imap.select(config["folder"])

            # Check IDLE support
            if not imap.supports_idle():
                print(f"[{datetime.now()}] Server does not support IDLE. "
                      f"Falling back to polling (interval={poll_fallback_interval}s)")
                imap.logout()
                db.close()
                # Fall back to traditional polling loop
                while not _shutdown_requested:
                    db = open_email_db(config)
                    try:
                        with _imap_client(config) as poll_imap:
                            # Hot-reload whitelist between ticks — the long-
                            # running poller is the only caller that needs it.
                            config = _refresh_whitelist(config)
                            _fetch_new_emails(poll_imap, db, config)
                    except Exception as e:
                        print(f"[{datetime.now()}] Poll error: {e}")
                    finally:
                        db.close()
                    # Interruptible sleep
                    for _ in range(poll_fallback_interval):
                        if _shutdown_requested:
                            break
                        time.sleep(1)
                return

            print(f"[{datetime.now()}] IDLE mode supported — using persistent connection")

            # Initial fetch of any pending emails
            _fetch_new_emails(imap, db, config)

            # IDLE loop
            while not _shutdown_requested:
                print(f"[{datetime.now()}] Entering IDLE mode (timeout={idle_timeout}s)...")
                try:
                    new_mail = imap.idle(idle_timeout)
                except ConnectionError as e:
                    print(f"[{datetime.now()}] Connection lost during IDLE: {e}")
                    break  # Will reconnect in outer loop

                if _shutdown_requested:
                    break

                if new_mail:
                    print(f"[{datetime.now()}] New mail detected via IDLE")
                    # Re-select to refresh mailbox state after IDLE
                    imap.select(config["folder"])
                    # Hot-reload whitelist before the fetch so config changes
                    # made while we were IDLE'ing take effect immediately.
                    config = _refresh_whitelist(config)
                    _fetch_new_emails(imap, db, config)
                else:
                    # Timeout — send NOOP to keep connection alive, then re-enter IDLE
                    try:
                        imap.noop()
                    except Exception:
                        print(f"[{datetime.now()}] NOOP failed, reconnecting...")
                        break  # Will reconnect in outer loop

            # Clean disconnect
            if imap is not None:
                imap.logout()

        except (imaplib.IMAP4.error, ConnectionError, OSError) as e:
            print(f"[{datetime.now()}] Connection error: {e}")
        except Exception as e:
            print(f"[{datetime.now()}] Unexpected error: {e}")
        finally:
            if db:
                db.close()

        if not _shutdown_requested:
            print(f"[{datetime.now()}] Reconnecting in 30 seconds...")
            for _ in range(30):
                if _shutdown_requested:
                    break
                time.sleep(1)

    print(f"[{datetime.now()}] Email IDLE poller stopped.")


# --- SEND command ---

def build_message(body, attachments=None):
    """Build a MIMEText or MIMEMultipart message depending on attachments."""
    if not attachments:
        return MIMEText(body)

    msg = MIMEMultipart()
    msg.attach(MIMEText(body))

    for filepath in attachments:
        path = Path(filepath)
        if not path.exists():
            print(f"WARNING: Attachment not found: {filepath}", file=sys.stderr)
            continue
        part = MIMEBase("application", "octet-stream")
        part.set_payload(path.read_bytes())
        encoders.encode_base64(part)
        part.add_header("Content-Disposition", f'attachment; filename="{path.name}"')
        msg.attach(part)

    return msg


def cmd_send(config, to, subject, body, attachments=None, cc=None, bcc=None):
    """Send a new email (not a reply)."""
    if not config["smtp_host"] or not config["username"] or not config["password"]:
        print("ERROR: SMTP not configured. Set email section in config.yml", file=sys.stderr)
        sys.exit(1)

    db = open_email_db(config)

    cc = cc or []
    bcc = bcc or []
    cc_str = ", ".join(cc)

    msg = build_message(body, attachments)
    msg["From"] = config["username"]
    msg["To"] = to
    if cc:
        msg["Cc"] = cc_str
    if bcc:
        # smtplib.send_message() reads Bcc from headers, strips it before
        # transmission, and uses it only to compute envelope recipients.
        msg["Bcc"] = ", ".join(bcc)
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    domain = config["username"].split("@")[-1] if "@" in config["username"] else "atlas.local"
    msg["Message-ID"] = make_msgid(domain=domain)

    try:
        with _smtp_connect(config) as server:
            server.send_message(msg)

        # Record the thread + outgoing row. BCC is intentionally excluded
        # from participants — it's a hidden delivery, not a thread member.
        thread_id = sanitize_thread_id(msg["Message-ID"])
        participants = sorted(set([config["username"], to] + cc))
        db.insert_outgoing_thread(
            thread_id=thread_id,
            subject=subject,
            last_message_id=msg["Message-ID"],
            username=config["username"],
            cc_raw=cc_str,
            participants=participants,
        )
        db.insert_outgoing_email(
            thread_id=thread_id,
            message_id=msg["Message-ID"],
            sender=config["username"],
            recipient=to,
            cc=cc_str,
            subject=subject,
            body=body,
        )
        db.commit()
        print(f"Email sent to {to}")
        if cc:
            print(f"  Cc:  {cc_str}")
        if bcc:
            print(f"  Bcc: {', '.join(bcc)}")
        print(f"  Subject: {subject}")
        print(f"  Thread:  {thread_id}")
        print(f"Reply to this thread with: email reply \"{thread_id}\" \"<body>\"")

    except Exception as e:
        print(f"ERROR: Failed to send: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        db.close()


# --- REPLY command ---

def cmd_reply(config, thread_id, body, attachments=None, cc=None, bcc=None, no_cc=False):
    """Reply to an existing email thread with proper threading headers.

    CC behavior:
      - ``no_cc=True``        → reply only to the sender, no CCs.
      - ``cc=[...]`` given    → use exactly those (replaces auto reply-all list).
      - otherwise (default)   → reply-all: CC the thread's last_cc list, minus
        ourselves and the To: recipient (to avoid duplicate delivery).
    """
    if not config["smtp_host"] or not config["username"] or not config["password"]:
        print("ERROR: SMTP not configured. Set email section in config.yml", file=sys.stderr)
        sys.exit(1)

    db = open_email_db(config)

    thread = db.get_thread(thread_id)
    if thread is None:
        print(f"ERROR: Thread {thread_id} not found", file=sys.stderr)
        db.close()
        sys.exit(1)

    recipient       = thread.last_sender
    subject         = thread.subject
    last_message_id = thread.last_message_id
    references      = list(thread.references_chain)   # mutable copy — we append below
    last_cc         = thread.last_cc or ""

    bcc = bcc or []

    # Resolve the CC list.
    if no_cc:
        cc_list = []
    elif cc:
        cc_list = list(cc)
    else:
        # Reply-all default: keep everyone from the last CC line except
        # ourselves and the new To: recipient (already addressed once each).
        skip = {config["username"].lower(), (recipient or "").lower()}
        cc_list = [a for a in _parse_address_list(last_cc) if a.lower() not in skip]

    cc_str = ", ".join(cc_list)

    msg = build_message(body, attachments)
    msg["From"] = config["username"]
    msg["To"] = recipient
    if cc_list:
        msg["Cc"] = cc_str
    if bcc:
        msg["Bcc"] = ", ".join(bcc)
    msg["Subject"] = f"Re: {subject}"
    msg["Date"] = formatdate(localtime=True)
    domain = config["username"].split("@")[-1] if "@" in config["username"] else "atlas.local"
    msg["Message-ID"] = make_msgid(domain=domain)

    if last_message_id:
        msg["In-Reply-To"] = last_message_id
    if references:
        msg["References"] = " ".join(references)

    try:
        with _smtp_connect(config) as server:
            server.send_message(msg)

        # Update thread state: append our Message-ID to references, and
        # refresh last_cc so the next reply defaults to the new list.
        references.append(msg["Message-ID"])
        db.update_thread_after_reply(
            thread_id=thread_id,
            last_message_id=msg["Message-ID"],
            references=references,
            last_cc=cc_str,
        )

        # Fold any new CC addresses into the thread's participant set
        if cc_list:
            db.add_thread_participants(thread_id, cc_list)

        # Store the outgoing reply (folder='Sent', is_read=1 — same logic as cmd_send)
        db.insert_outgoing_email(
            thread_id=thread_id,
            message_id=msg["Message-ID"],
            sender=config["username"],
            recipient=recipient,
            cc=cc_str,
            subject=f"Re: {subject}",
            body=body,
        )
        db.commit()
        print(f"Reply sent to {recipient}")
        if cc_list:
            print(f"  Cc:  {cc_str}")
        if bcc:
            print(f"  Bcc: {', '.join(bcc)}")
        print(f"  Subject: Re: {subject}")
        print(f"  Thread:  {thread_id}")
        print(f"Follow up on this thread with: email reply \"{thread_id}\" \"<body>\"")

    except Exception as e:
        print(f"ERROR: Failed to send reply: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        db.close()


# --- Read state / Folder operations ---
#
# The agent's mental model for an IMAP mailbox is the same as any mail client:
# messages live in folders (INBOX, Archive, Junk, Trash, …) and carry a read /
# unread flag. We mirror both into the local DB so filters are cheap, and sync
# every state change back to the IMAP server so the user's webmail agrees.

def _split_in_out(rows):
    """Partition resolved EmailTarget rows into (incoming, outgoing) lists."""
    in_rows  = [r for r in rows if r.direction == "in"]
    out_rows = [r for r in rows if r.direction == "out"]
    return in_rows, out_rows


def _skip_note(out_rows):
    """Format the outgoing-skipped note (or empty string when none)."""
    n = len(out_rows)
    if n == 0:
        return ""
    return (f" Note: {n} outgoing message{'s' if n != 1 else ''} "
            "skipped (no server UID).")


def _group_by_folder(targets):
    """Group EmailTarget rows with imap_uid by their current server folder.

    Result shape: ``{"INBOX": [target, ...], "Archive": [target, ...]}``.
    Used by the read-state / move action layer to feed one IMAP call per
    source folder into :meth:`ImapClient.set_seen` / :meth:`ImapClient.move`.
    """
    out = {}
    for t in targets:
        if t.imap_uid is None:
            continue
        out.setdefault(t.folder or "INBOX", []).append(t)
    return out


def _require_imap(config):
    if not config.get("imap_host") or not config.get("username") or not config.get("password"):
        print("ERROR: IMAP not configured. Set email section in config.yml",
              file=sys.stderr)
        sys.exit(1)


def _do_read_state(config, ident, mark_read):
    """Shared implementation for mark-read / mark-unread.

    DB updates are committed only after IMAP succeeds, so a 'NO' from the
    server (folder gone, ACL denial, quota) never leaves the DB claiming
    a state the server didn't actually accept.
    """
    _require_imap(config)
    db = open_email_db(config)
    try:
        all_rows = db.resolve_targets(ident)
        if not all_rows:
            print(f"No emails found for '{ident}'.", file=sys.stderr)
            sys.exit(1)

        in_rows, out_rows = _split_in_out(all_rows)
        if not in_rows:
            # Single outgoing email_id, or an outgoing-only thread — no
            # server-side action is possible and our DB already flags
            # outgoing rows as read.
            print(
                f"'{ident}' resolves only to outgoing message(s); "
                "no IMAP state to change.",
                file=sys.stderr,
            )
            sys.exit(1)

        with_uid = [t for t in in_rows if t.imap_uid is not None]
        if with_uid:
            try:
                with _imap_client(config) as imap:
                    # One set_seen() per source folder. The client chunks
                    # large UID sets internally and raises ImapError on
                    # any non-OK reply so we never commit the DB mirror.
                    for folder, group in _group_by_folder(with_uid).items():
                        uids = [t.imap_uid for t in group]
                        imap.set_seen(folder, uids, seen=mark_read)
            except ImapError as e:
                print(f"ERROR: {e}", file=sys.stderr)
                sys.exit(1)

        # Only reached on IMAP success (or when there were no UIDs to touch).
        db.set_emails_is_read([t.id for t in in_rows], is_read=mark_read)
        db.commit()

        verb = "read" if mark_read else "unread"
        n = len(in_rows)
        print(
            f"Marked {n} email{'s' if n != 1 else ''} {verb}."
            f"{_skip_note(out_rows)}"
        )
    finally:
        db.close()


def cmd_mark_read(config, ident):
    """Mark an email (by id) or all incoming emails in a thread as read."""
    _do_read_state(config, ident, mark_read=True)


def cmd_mark_unread(config, ident):
    """Mark an email (by id) or all incoming emails in a thread as unread."""
    _do_read_state(config, ident, mark_read=False)


def _resolve_destination(folder_map, all_folders, requested):
    """Pick the destination folder name.

    Accepts a logical role (``inbox`` / ``archive`` / ``junk`` / ``trash`` /
    ``sent`` / ``drafts``) and resolves it against the discovered folder map,
    or a literal folder name that must exist on the server.
    """
    key = requested.lower() if isinstance(requested, str) else ""
    if key in folder_map:
        return folder_map[key]
    # Literal folder name. If we have a server folder list, validate; if the
    # list call failed, accept the name and let IMAP error out — we'd rather
    # try than refuse on an empty list.
    if all_folders and requested not in all_folders:
        # Case-insensitive fallback — some servers return INBOX as "Inbox".
        for f in all_folders:
            if f.lower() == requested.lower():
                return f
        raise ValueError(
            f"Folder '{requested}' not found on server. "
            f"Available: {', '.join(sorted(all_folders))}"
        )
    return requested


def _do_move(config, ident, role_or_folder):
    """Move target message(s) (single id or whole thread) to a folder.

    DB updates only commit after IMAP confirms — see _do_read_state for the
    same pattern and rationale.
    """
    _require_imap(config)
    db = open_email_db(config)
    try:
        all_rows = db.resolve_targets(ident)
        if not all_rows:
            print(f"No emails found for '{ident}'.", file=sys.stderr)
            sys.exit(1)

        in_rows, out_rows = _split_in_out(all_rows)
        with_uid = [t for t in in_rows if t.imap_uid is not None]
        if not with_uid:
            print(
                f"No movable IMAP messages for '{ident}' (no stored UIDs — "
                "likely an outgoing-only thread).",
                file=sys.stderr,
            )
            sys.exit(1)

        dest = None
        try:
            with _imap_client(config) as imap:
                folder_map = imap.discover_folders()
                all_folders = imap.list_folders()
                try:
                    dest = _resolve_destination(
                        folder_map, all_folders, role_or_folder
                    )
                except ValueError as e:
                    print(f"ERROR: {e}", file=sys.stderr)
                    sys.exit(1)
                # One move() per source folder. The client chunks large
                # UID sets and uses UID MOVE → COPY+STORE+EXPUNGE fallback
                # transparently.
                for folder, group in _group_by_folder(with_uid).items():
                    uids = [t.imap_uid for t in group]
                    imap.move(folder, uids, dest)
        except ImapError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)

        # Only reached on IMAP success.
        db.set_emails_folder([t.id for t in with_uid], folder=dest)
        db.commit()
        n = len(with_uid)
        print(
            f"Moved {n} email{'s' if n != 1 else ''} to '{dest}'."
            f"{_skip_note(out_rows)}"
        )
    finally:
        db.close()


def cmd_archive(config, ident):
    """Move incoming message(s) to the Archive folder."""
    _do_move(config, ident, "archive")


def cmd_spam(config, ident):
    """Move incoming message(s) to the Junk/Spam folder."""
    _do_move(config, ident, "junk")


def cmd_delete(config, ident):
    """Move incoming message(s) to the Trash folder (soft delete)."""
    _do_move(config, ident, "trash")


def cmd_move(config, ident, folder):
    """Move incoming message(s) to an arbitrary folder (role or literal name)."""
    _do_move(config, ident, folder)


def cmd_folders(config):
    """List server folders and the resolved logical role mapping."""
    _require_imap(config)
    with _imap_client(config) as imap:
        folder_map = imap.discover_folders()
        all_folders = imap.list_folders()

    # Roles first (the agent's vocabulary), then the full server listing.
    print("Logical roles → server folders:")
    for role in ("inbox", "archive", "sent", "drafts", "junk", "trash"):
        name = folder_map.get(role, "(unresolved)")
        print(f"  {role:<8} → {name}")

    print("")
    if all_folders:
        print("All server folders:")
        for f in sorted(all_folders):
            print(f"  {f}")
    else:
        print("(could not list folders — server returned no LIST results)")


# --- THREADS command ---

def cmd_threads(config, limit=20, folder=None, unread=None):
    """List tracked email threads, with optional folder / read-state filters.

    Args:
      folder: if given, only show threads with at least one incoming message
              currently in that folder (case-sensitive match against
              ``emails.folder``).
      unread: ``True`` → threads with at least one unread incoming message;
              ``False`` → threads where every incoming message is read;
              ``None`` → no read-state filter.
    """
    db = open_email_db(config)
    try:
        threads, truncated = db.list_threads(folder=folder, unread=unread, limit=limit)
    finally:
        # Close after the read so the truncation flag isn't lost; the
        # rendering below uses only the already-fetched dataclasses.
        db.close()

    # Build a small filter caption so the agent knows what's filtered out.
    caption_bits = []
    if folder is not None:
        caption_bits.append(f"folder={folder}")
    if unread is True:
        caption_bits.append("unread only")
    elif unread is False:
        caption_bits.append("read only")
    caption = f" ({', '.join(caption_bits)})" if caption_bits else ""

    if not threads:
        print(f"No email threads found{caption}.")
        return

    n = len(threads)
    suffix = "+" if truncated else ""
    if caption or truncated:
        # Always show the count when filtered or truncated so the agent can
        # distinguish "all N results" from "first N of more".
        header = f"{n}{suffix} thread{'s' if n != 1 else ''}{caption}:"
        print(header)
    for t in threads:
        plural = "s" if t.message_count != 1 else ""
        print(
            f"{t.thread_id}  \"{t.subject}\"  from {t.last_sender}  "
            f"{t.message_count} msg{plural}  {t.updated_at[:10]}"
        )

    if truncated:
        print("")
        print(f"(more results exist — pass --limit {limit * 2} to see more)")
    print("")
    print('email thread "<thread_id>" | email reply "<thread_id>" "<body>"')


def cmd_inbox(config, limit=20):
    """Show the agent's to-do list: threads with unread messages in INBOX.

    This is the focused view — anything archived, trashed, or already read
    is filtered out. Use ``email threads`` with no filters to see everything.
    """
    cmd_threads(config, limit=limit, folder="INBOX", unread=True)


# --- Format a single email as Markdown ---

def _format_email_md(direction, sender, recipient, cc, subject, date, body, email_id=None):
    """Format a single email as clean Markdown."""
    arrow = "→" if direction == "out" else "←"
    who = f"**To:** {recipient}" if direction == "out" else f"**From:** {sender}"
    lines = []
    if email_id is not None:
        lines.append(f"### {arrow} #{email_id} — {subject}")
    else:
        lines.append(f"### {arrow} {subject}")
    lines.append("")
    lines.append(f"{who}  ")
    if cc:
        lines.append(f"**Cc:** {cc}  ")
    lines.append(f"**Date:** {date}  ")
    lines.append("")
    lines.append(body or "*(empty)*")
    lines.append("")
    return "\n".join(lines)


# --- THREAD detail command ---

def cmd_thread_detail(config, thread_id, raw=False):
    """Show all emails in a thread as Markdown (or raw HTML with --raw)."""
    db = open_email_db(config)
    try:
        thread = db.get_thread(thread_id)
        if thread is None:
            print(f"Thread {thread_id} not found.", file=sys.stderr)
            sys.exit(1)
        emails = db.list_thread_emails(thread_id)
    finally:
        db.close()

    # Thread header
    print(f"# {thread.subject}")
    print(f"")
    print(f"**Thread:** {thread_id}  ")
    print(f"**Messages:** {thread.message_count}  ")
    print(f"**Participants:** {', '.join(thread.participants)}  ")
    print(f"**Last updated:** {thread.updated_at}")
    print("")

    if not emails:
        print("*(no messages)*")
        return

    for e in emails:
        if raw and e.body_html:
            print(f"<!-- Email #{e.id} from {e.sender} ({e.created_at}) -->")
            print(e.body_html)
            print("")
        else:
            print(_format_email_md(
                e.direction, e.sender, e.recipient, e.cc, e.subject,
                e.created_at, e.body, email_id=e.id,
            ))
        print("---")
        print("")

    print(f"Reply to this thread with: email reply \"{thread_id}\" \"<body>\"")


# --- READ single email command ---

def cmd_read_email(config, email_id, raw=False):
    """Read a single email by its ID."""
    db = open_email_db(config)
    try:
        email = db.get_email(email_id)
    finally:
        db.close()

    if email is None:
        print(f"Email #{email_id} not found.", file=sys.stderr)
        sys.exit(1)

    if raw and email.body_html:
        print(email.body_html)
        return

    print(f"# {email.subject}")
    print("")
    arrow = "→ Sent" if email.direction == "out" else "← Received"
    print(f"**{arrow}**  ")
    if email.direction == "out":
        print(f"**To:** {email.recipient}  ")
    else:
        print(f"**From:** {email.sender}  ")
    if email.cc:
        print(f"**Cc:** {email.cc}  ")
    print(f"**Date:** {email.created_at}  ")
    print(f"**Thread:** {email.thread_id}  ")
    print("")
    print(email.body or "*(empty)*")
    print("")
    print(f"Reply to this thread with: email reply \"{email.thread_id}\" \"<body>\"")


# --- Main CLI ---

def main():
    parser = argparse.ArgumentParser(
        description=f"{os.environ.get('AGENT_NAME', 'Atlas')} Email Add-on — unified email management",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  email-addon.py poll --once                 # Check IMAP once
  email-addon.py poll                        # Continuous via IMAP IDLE
  email-addon.py send alice@x.com "Subject" "Body"
  email-addon.py send alice@x.com "Subject" "Body" --cc bob@x.com --bcc carol@x.com
  email-addon.py reply <thread_id> "Reply body"             # Reply-all (auto CCs)
  email-addon.py reply <thread_id> "Reply body" --no-cc     # Reply only to sender
  email-addon.py inbox                       # Unread threads in INBOX (to-do list)
  email-addon.py threads                     # All threads (any folder, any state)
  email-addon.py threads --folder Archive    # Threads currently in Archive
  email-addon.py threads --unread            # Threads with at least one unread msg
  email-addon.py thread <thread_id>          # Thread detail (Markdown)
  email-addon.py read <email_id>             # Read single email
  email-addon.py mark-read <id|thread_id>    # Mark read (syncs to IMAP \\Seen)
  email-addon.py mark-unread <id|thread_id>  # Mark unread
  email-addon.py archive <id|thread_id>      # Move to Archive folder
  email-addon.py spam <id|thread_id>         # Move to Junk/Spam
  email-addon.py delete <id|thread_id>       # Move to Trash
  email-addon.py move <id|thread_id> <folder>  # Move to a specific folder
  email-addon.py folders                     # List server folders + role mapping
        """,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # poll
    p_poll = sub.add_parser("poll", help="Fetch new emails from IMAP")
    p_poll.add_argument("--once", action="store_true", help="Check once and exit")

    # send
    p_send = sub.add_parser("send", help="Send a new email")
    p_send.add_argument("to", help="Recipient email address")
    p_send.add_argument("subject", help="Email subject")
    p_send.add_argument("body", help="Email body text")
    p_send.add_argument("--attach", action="append", default=[], metavar="FILE",
                        help="Attach a file (can be used multiple times)")
    p_send.add_argument("--cc", action="append", default=[], metavar="ADDR",
                        help="CC recipient (can be used multiple times)")
    p_send.add_argument("--bcc", action="append", default=[], metavar="ADDR",
                        help="BCC recipient (can be used multiple times)")

    # reply
    p_reply = sub.add_parser("reply", help="Reply to an email thread")
    p_reply.add_argument("thread_id", help="Thread ID to reply to")
    p_reply.add_argument("body", help="Reply body text")
    p_reply.add_argument("--attach", action="append", default=[], metavar="FILE",
                        help="Attach a file (can be used multiple times)")
    p_reply.add_argument("--cc", action="append", default=[], metavar="ADDR",
                        help="CC recipient (overrides the auto reply-all list)")
    p_reply.add_argument("--bcc", action="append", default=[], metavar="ADDR",
                        help="BCC recipient (can be used multiple times)")
    p_reply.add_argument("--no-cc", dest="no_cc", action="store_true",
                        help="Don't CC anyone — reply only to the sender")

    # threads — generic listing with folder + read-state filters
    p_threads = sub.add_parser("threads", help="List email threads (filterable)")
    p_threads.add_argument("--limit", type=int, default=20, help="Max threads to show")
    p_threads.add_argument("--folder", metavar="NAME",
                           help="Filter to threads with msgs in this folder "
                                "(INBOX, Archive, Junk, Trash, ...)")
    state = p_threads.add_mutually_exclusive_group()
    state.add_argument("--unread", action="store_true",
                       help="Only show threads with at least one unread message")
    state.add_argument("--read", action="store_true",
                       help="Only show threads where every incoming message is read")

    # inbox — focused shortcut: unread threads in INBOX (the agent's to-do list)
    p_inbox = sub.add_parser(
        "inbox",
        help="Unread threads in INBOX (focused to-do view; shortcut for "
             "`threads --folder INBOX --unread`)",
    )
    p_inbox.add_argument("--limit", type=int, default=20, help="Max threads to show")

    # thread detail
    p_thread = sub.add_parser("thread", help="Show full thread (Markdown or --raw HTML)")
    p_thread.add_argument("thread_id", help="Thread ID")
    p_thread.add_argument("--raw", action="store_true", help="Output raw HTML instead of Markdown")

    # read single email
    p_read = sub.add_parser("read", help="Read a single email by ID (Markdown or --raw HTML)")
    p_read.add_argument("email_id", type=int, help="Email ID (shown as #N in thread view)")
    p_read.add_argument("--raw", action="store_true", help="Output raw HTML instead of Markdown")

    # mark-read / mark-unread / archive / spam / delete share the same arg shape
    for verb, _help in (
        ("mark-read",   "Mark email(s) read (syncs IMAP \\Seen)"),
        ("mark-unread", "Mark email(s) unread (clears IMAP \\Seen)"),
        ("archive",     "Move email(s) to the Archive folder"),
        ("spam",        "Move email(s) to the Junk/Spam folder"),
        ("delete",      "Move email(s) to the Trash folder (soft delete)"),
    ):
        _p = sub.add_parser(verb, help=_help)
        _p.add_argument("ident", metavar="ID_OR_THREAD",
                        help="Numeric email id, or thread_id (applies to all "
                             "incoming messages in the thread)")

    # generic move
    p_move = sub.add_parser("move", help="Move email(s) to a specific folder")
    p_move.add_argument("ident", metavar="ID_OR_THREAD",
                        help="Numeric email id or thread_id")
    p_move.add_argument("folder", help="Destination folder (role name or literal)")

    # folders listing
    sub.add_parser("folders", help="List server folders and role mapping")

    args = parser.parse_args()
    config = load_config()

    if args.command == "poll":
        if args.once:
            cmd_poll(config, once=True)
        else:
            cmd_poll_idle(config)

    elif args.command == "send":
        cmd_send(config, args.to, args.subject, args.body,
                 attachments=args.attach or None,
                 cc=args.cc or None, bcc=args.bcc or None)

    elif args.command == "reply":
        cmd_reply(config, args.thread_id, args.body,
                  attachments=args.attach or None,
                  cc=args.cc or None, bcc=args.bcc or None,
                  no_cc=args.no_cc)

    elif args.command == "threads":
        unread = True if args.unread else (False if args.read else None)
        cmd_threads(config, limit=args.limit, folder=args.folder, unread=unread)

    elif args.command == "inbox":
        cmd_inbox(config, limit=args.limit)

    elif args.command == "thread":
        cmd_thread_detail(config, args.thread_id, raw=args.raw)

    elif args.command == "mark-read":
        cmd_mark_read(config, args.ident)

    elif args.command == "mark-unread":
        cmd_mark_unread(config, args.ident)

    elif args.command == "archive":
        cmd_archive(config, args.ident)

    elif args.command == "spam":
        cmd_spam(config, args.ident)

    elif args.command == "delete":
        cmd_delete(config, args.ident)

    elif args.command == "move":
        cmd_move(config, args.ident, args.folder)

    elif args.command == "folders":
        cmd_folders(config)

    elif args.command == "read":
        cmd_read_email(config, args.email_id, raw=args.raw)


if __name__ == "__main__":
    main()
