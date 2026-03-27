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
import imaplib
import json
import os
import re
import select
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

def load_config():
    """Load email config from config.yml + runtime config, with env overrides.

    Resolution order (highest priority wins):
      1. Environment variables
      2. Runtime config (~/.atlas-runtime-config.json)
      3. config.yml
      4. Built-in defaults

    This matches the TypeScript resolveConfig() behavior in config.ts.
    """
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            import yaml
            with open(CONFIG_PATH) as f:
                data = yaml.safe_load(f) or {}
            cfg = data.get("email", {})
        except ImportError:
            pass

    # Layer 2: Runtime config overrides (written by /api/v1/config endpoint)
    rt = {}
    if os.path.exists(RUNTIME_CONFIG_PATH):
        try:
            with open(RUNTIME_CONFIG_PATH) as f:
                rt_data = json.load(f)
            rt = rt_data.get("email", {}) if isinstance(rt_data, dict) else {}
        except (json.JSONDecodeError, OSError):
            pass

    # Merge: runtime overrides config.yml (for each key, use rt value if present,
    # else cfg value, else default).  Env vars override both.
    def _resolve(key, default, env_var=None):
        """Pick the highest-priority value for a config key."""
        file_val = cfg.get(key, default)
        runtime_val = rt.get(key)
        base = runtime_val if runtime_val is not None else file_val
        if env_var:
            env_raw = os.environ.get(env_var)
            if env_raw is not None:
                if isinstance(default, int):
                    return int(env_raw)
                return env_raw
        return base

    config = {
        "imap_host": _resolve("imap_host", "", "EMAIL_IMAP_HOST"),
        "imap_port": _resolve("imap_port", 993, "EMAIL_IMAP_PORT"),
        "imap_starttls": _resolve("imap_starttls", False),
        "smtp_host": _resolve("smtp_host", "", "EMAIL_SMTP_HOST"),
        "smtp_port": _resolve("smtp_port", 587, "EMAIL_SMTP_PORT"),
        "username": _resolve("username", "", "EMAIL_USERNAME"),
        "password": os.environ.get("EMAIL_PASSWORD", ""),
        "password_file": _resolve("password_file", ""),
        "folder": _resolve("folder", "INBOX", "EMAIL_FOLDER"),
        "ssl_verify": _resolve("ssl_verify", True),
        "whitelist": _resolve("whitelist", []),
        "mark_read": _resolve("mark_read", True),
        "idle_timeout": _resolve("idle_timeout", 1500, "EMAIL_IDLE_TIMEOUT"),
    }

    if not config["password"] and config["password_file"]:
        pf = Path(config["password_file"])
        if pf.exists():
            config["password"] = pf.read_text().strip()

    return config


# --- SSL / Connection helpers ---

def _ssl_context(config):
    """Create an SSL context, optionally disabling verification for self-signed certs."""
    ctx = ssl.create_default_context()
    if not config.get("ssl_verify", True):
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _imap_connect(config):
    """Connect to IMAP, supporting both implicit TLS (port 993) and STARTTLS (port 143)."""
    ctx = _ssl_context(config)
    if config.get("imap_starttls", False):
        mail = imaplib.IMAP4(config["imap_host"], config["imap_port"])
        mail.starttls(ssl_context=ctx)
    else:
        mail = imaplib.IMAP4_SSL(config["imap_host"], config["imap_port"], ssl_context=ctx)
    mail.login(config["username"], config["password"])
    return mail


def _smtp_connect(config):
    """Connect to SMTP with STARTTLS, optionally disabling cert verification."""
    ctx = _ssl_context(config)
    server = smtplib.SMTP(config["smtp_host"], config["smtp_port"])
    server.starttls(context=ctx)
    server.login(config["username"], config["password"])
    return server


# --- Email Database ---

def get_email_db(config):
    """Open (or create) the per-account email database."""
    os.makedirs(EMAIL_DB_DIR, exist_ok=True)

    # Sanitize username for filename
    account = re.sub(r"[^a-zA-Z0-9@._-]", "_", config.get("username", "default"))
    db_path = os.path.join(EMAIL_DB_DIR, f"{account}.db")

    db = sqlite3.connect(db_path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=5000")

    db.executescript("""
        CREATE TABLE IF NOT EXISTS threads (
            thread_id       TEXT PRIMARY KEY,
            subject         TEXT NOT NULL DEFAULT '',
            last_message_id TEXT NOT NULL DEFAULT '',
            references_chain TEXT NOT NULL DEFAULT '[]',
            last_sender     TEXT NOT NULL DEFAULT '',
            last_sender_full TEXT NOT NULL DEFAULT '',
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
            subject         TEXT NOT NULL DEFAULT '',
            body            TEXT NOT NULL DEFAULT '',
            headers_json    TEXT NOT NULL DEFAULT '{}',
            inbox_msg_id    INTEGER,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (thread_id) REFERENCES threads(thread_id)
        );

        CREATE TABLE IF NOT EXISTS state (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id);
        CREATE INDEX IF NOT EXISTS idx_emails_direction ON emails(direction);
    """)

    return db


# --- Thread helpers ---

def extract_thread_id(msg, db=None):
    """Extract thread identifier from email headers.

    If db is provided, looks up existing threads by referenced message IDs
    to prevent conversation splitting from incomplete References headers.
    Apple Mail sometimes sends only the last reply's Message-ID in References
    rather than the full chain, which would otherwise create a new thread_id.
    """
    references = msg.get("References", "").strip()
    in_reply_to = msg.get("In-Reply-To", "").strip()

    # Collect all referenced message IDs
    ref_ids = []
    if references:
        ref_ids.extend(references.split())
    if in_reply_to and in_reply_to not in ref_ids:
        ref_ids.append(in_reply_to)

    # Look up existing threads by any referenced message ID
    if db and ref_ids:
        # Search for both raw (<...>) and stripped forms
        search_ids = []
        for r in ref_ids:
            search_ids.append(r)
            search_ids.append(r.strip("<>"))
        placeholders = ",".join("?" * len(search_ids))
        row = db.execute(
            f"SELECT thread_id FROM emails WHERE message_id IN ({placeholders}) ORDER BY created_at ASC LIMIT 1",
            search_ids,
        ).fetchone()
        if row:
            return row[0]

    # Fallback: derive from headers (original behavior)
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


def update_thread(db, thread_id, msg):
    """Update thread state in the email DB."""
    sender = msg.get("From", "")
    _, sender_addr = emaillib.utils.parseaddr(sender)
    subject = msg.get("Subject", "(no subject)")
    subject_clean = re.sub(r"^(Re:\s*)+", "", subject, flags=re.IGNORECASE).strip()
    message_id = msg.get("Message-ID", "").strip()
    references = build_references_chain(msg)

    existing = db.execute("SELECT participants, message_count FROM threads WHERE thread_id = ?",
                          (thread_id,)).fetchone()

    if existing:
        participants = set(json.loads(existing[0]))
        count = existing[1] + 1
    else:
        participants = set()
        count = 1

    if sender_addr:
        participants.add(sender_addr)

    db.execute("""
        INSERT INTO threads (thread_id, subject, last_message_id, references_chain,
                             last_sender, last_sender_full, participants, message_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
            subject = excluded.subject,
            last_message_id = excluded.last_message_id,
            references_chain = excluded.references_chain,
            last_sender = excluded.last_sender,
            last_sender_full = excluded.last_sender_full,
            participants = excluded.participants,
            message_count = excluded.message_count,
            updated_at = excluded.updated_at
    """, (
        thread_id, subject_clean, message_id,
        json.dumps(references), sender_addr, sender,
        json.dumps(sorted(participants)), count,
        datetime.now().isoformat(),
    ))

    return {
        "thread_id": thread_id,
        "subject": subject_clean,
        "last_message_id": message_id,
        "references": references,
        "last_sender": sender_addr,
    }


def get_body(msg):
    """Extract plaintext body from email message."""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                charset = part.get_content_charset() or "utf-8"
                return part.get_payload(decode=True).decode(charset, errors="replace")
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                charset = part.get_content_charset() or "utf-8"
                html = part.get_payload(decode=True).decode(charset, errors="replace")
                return re.sub(r"<[^>]+>", "", html)
    else:
        charset = msg.get_content_charset() or "utf-8"
        return msg.get_payload(decode=True).decode(charset, errors="replace")
    return ""


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
    atlas_db = sqlite3.connect(ATLAS_DB_PATH)
    atlas_db.execute("PRAGMA busy_timeout=5000")
    cursor = atlas_db.execute(
        "INSERT INTO messages (channel, sender, content) VALUES (?, ?, ?)",
        ("email", sender, content),
    )
    msg_id = cursor.lastrowid
    atlas_db.commit()
    atlas_db.close()
    # Touch .wake so main session picks up the message even if trigger.sh fails
    Path(WAKE_PATH).touch()
    return msg_id


# --- Shared fetch logic ---

def _fetch_new_emails(mail, db, config):
    """Fetch and process new emails from an open IMAP connection.

    Reusable by both cmd_poll (--once) and cmd_poll_idle (continuous IDLE).
    Returns the number of new emails processed.
    """
    # Re-read whitelist from runtime config so changes apply without restart
    try:
        fresh_config = load_config()
        config["whitelist"] = fresh_config.get("whitelist", [])
    except Exception:
        pass  # Keep existing whitelist on error

    row = db.execute("SELECT value FROM state WHERE key='last_uid'").fetchone()
    last_uid = int(row[0]) if row and row[0].isdigit() else 0

    # Search for new emails
    if last_uid > 0:
        status, data = mail.uid("search", None, f"UID {last_uid + 1}:*")
    else:
        status, data = mail.uid("search", None, "UNSEEN")

    if status != "OK" or not data[0]:
        return 0

    uids = data[0].split()
    print(f"[{datetime.now()}] Found {len(uids)} new email(s)")

    max_uid = last_uid
    trigger_queue = []  # Collect triggers to fire after all emails are stored
    processed = 0

    for uid_bytes in uids:
        uid = uid_bytes.decode()
        uid_int = int(uid)

        if uid_int <= last_uid:
            continue

        status, msg_data = mail.uid("fetch", uid, "(RFC822)")
        if status != "OK":
            continue

        raw = msg_data[0][1]
        msg = emaillib.message_from_bytes(raw)

        sender = msg.get("From", "unknown")
        subject = msg.get("Subject", "(no subject)")
        body = get_body(msg)
        thread_id = extract_thread_id(msg, db)
        message_id_hdr = msg.get("Message-ID", "").strip()

        if not is_whitelisted(sender, config["whitelist"]):
            print(f"[{datetime.now()}] Blocked email from {sender}")
            max_uid = max(max_uid, uid_int)
            continue

        # 1. Update thread state in email DB
        thread_info = update_thread(db, thread_id, msg)

        # 1b. Extract attachments
        attachments = extract_attachments(msg, thread_id)

        # 2. Store email in email DB
        _, sender_addr = emaillib.utils.parseaddr(sender)
        db.execute("""
            INSERT INTO emails (thread_id, message_id, direction, sender, subject, body)
            VALUES (?, ?, 'in', ?, ?, ?)
        """, (thread_id, message_id_hdr, sender_addr, subject, body[:8000]))

        # 2b. Save as searchable file
        save_email_file(thread_id, sender, subject, msg.get("Date", ""), body, attachments)

        # 3. Write to agent inbox
        inbox_content = f"From: {sender}\nSubject: {subject}\n\n{body[:4000]}"
        if attachments:
            att_summary = "\n".join(f"  - {a['filename']} ({a['content_type']}, {a['size']} bytes): {a['path']}" for a in attachments)
            inbox_content += f"\n\nAttachments:\n{att_summary}"
        inbox_msg_id = write_to_atlas_inbox(sender, inbox_content, thread_id)

        # Update email record with inbox msg id
        db.execute("UPDATE emails SET inbox_msg_id = ? WHERE rowid = last_insert_rowid()", (inbox_msg_id,))

        print(f"[{datetime.now()}] Email from {sender}: {subject[:60]} "
              f"(thread={thread_id}, inbox={inbox_msg_id})")

        # 4. Queue trigger (fire after all emails stored)
        payload_data = {
            "inbox_message_id": inbox_msg_id,
            "sender": sender,
            "subject": subject,
            "body": body[:4000],
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

        if config["mark_read"]:
            mail.uid("store", uid, "+FLAGS", "\\Seen")

        max_uid = max(max_uid, uid_int)
        processed += 1

    # Persist UID state
    if max_uid > last_uid:
        db.execute("INSERT OR REPLACE INTO state (key, value) VALUES ('last_uid', ?)", (str(max_uid),))

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

def cmd_poll(config, once=False):
    """Fetch new emails from IMAP, store in DB, write to inbox, fire triggers."""
    if not config["imap_host"] or not config["username"] or not config["password"]:
        print(f"[{datetime.now()}] ERROR: Email not configured (IMAP). Set email section in config.yml")
        return

    db = get_email_db(config)

    try:
        mail = _imap_connect(config)
        mail.select(config["folder"])

        _fetch_new_emails(mail, db, config)

        mail.logout()

    except imaplib.IMAP4.error as e:
        print(f"[{datetime.now()}] IMAP error: {e}")
    except Exception as e:
        print(f"[{datetime.now()}] Error: {e}")
    finally:
        db.close()


# --- IMAP IDLE helpers ---

def _read_until_tag(mail, tag, max_lines=50):
    """Read lines from IMAP until we see the tagged response or hit a safety limit.

    Prevents infinite spin when the connection is in a broken state where
    readline() returns empty or unexpected data in a tight loop.
    Raises ConnectionError if readline() returns empty bytes (connection lost)
    or if max_lines is exceeded without finding the tag.
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


def _imap_idle(mail, timeout=1500):
    """Enter IMAP IDLE mode (RFC 2177).

    Sends the IDLE command and waits for server notifications using select().
    Returns True if new mail was detected (EXISTS/RECENT), False on timeout.
    Raises ConnectionError if the server closes the connection.
    """
    tag = mail._new_tag()
    mail.send(tag + b' IDLE\r\n')
    resp = mail.readline()
    if not resp.startswith(b'+'):
        # Server rejected IDLE — should not happen if capability was checked
        return False

    sock = mail.socket()
    deadline = time.time() + timeout
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            break
        ready = select.select([sock], [], [], min(remaining, 30))
        if ready[0]:
            data = sock.recv(4096)
            if not data:
                raise ConnectionError("IMAP connection closed during IDLE")
            if b'EXISTS' in data or b'RECENT' in data:
                # New mail — exit IDLE
                mail.send(b'DONE\r\n')
                _read_until_tag(mail, tag)
                return True

    # Timeout — exit IDLE gracefully
    mail.send(b'DONE\r\n')
    _read_until_tag(mail, tag)
    return False


def _server_supports_idle(mail):
    """Check if the IMAP server advertises the IDLE capability."""
    status, caps = mail.capability()
    if status != "OK":
        return False
    cap_str = b" ".join(caps).upper()
    return b"IDLE" in cap_str


# Global flag for graceful shutdown
_shutdown_requested = False


def cmd_poll_idle(config):
    """Continuous email polling using IMAP IDLE (persistent connection).

    Opens a single IMAP connection, fetches any pending emails, then enters
    IDLE mode to wait for server-side push notifications. Re-enters IDLE
    every idle_timeout seconds (default 25 min) to stay within the RFC 2177
    29-minute server limit. Auto-reconnects on connection drops.

    Falls back to traditional polling if the server does not support IDLE.
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
        mail = None
        db = None
        try:
            db = get_email_db(config)

            # Connect
            print(f"[{datetime.now()}] Connecting to {config['imap_host']}...")
            mail = _imap_connect(config)
            mail.select(config["folder"])

            # Check IDLE support
            if not _server_supports_idle(mail):
                print(f"[{datetime.now()}] Server does not support IDLE. "
                      f"Falling back to polling (interval={poll_fallback_interval}s)")
                mail.logout()
                db.close()
                # Fall back to traditional polling loop
                while not _shutdown_requested:
                    db = get_email_db(config)
                    try:
                        mail = _imap_connect(config)
                        mail.select(config["folder"])
                        _fetch_new_emails(mail, db, config)
                        mail.logout()
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
            _fetch_new_emails(mail, db, config)

            # IDLE loop
            while not _shutdown_requested:
                print(f"[{datetime.now()}] Entering IDLE mode (timeout={idle_timeout}s)...")
                try:
                    new_mail = _imap_idle(mail, timeout=idle_timeout)
                except ConnectionError as e:
                    print(f"[{datetime.now()}] Connection lost during IDLE: {e}")
                    break  # Will reconnect in outer loop

                if _shutdown_requested:
                    break

                if new_mail:
                    print(f"[{datetime.now()}] New mail detected via IDLE")
                    # Re-select to refresh mailbox state after IDLE
                    mail.select(config["folder"])
                    _fetch_new_emails(mail, db, config)
                else:
                    # Timeout — send NOOP to keep connection alive, then re-enter IDLE
                    try:
                        mail.noop()
                    except Exception:
                        print(f"[{datetime.now()}] NOOP failed, reconnecting...")
                        break  # Will reconnect in outer loop

            # Clean disconnect
            if mail:
                try:
                    mail.logout()
                except Exception:
                    pass

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


def cmd_send(config, to, subject, body, attachments=None):
    """Send a new email (not a reply)."""
    if not config["smtp_host"] or not config["username"] or not config["password"]:
        print("ERROR: SMTP not configured. Set email section in config.yml", file=sys.stderr)
        sys.exit(1)

    db = get_email_db(config)

    msg = build_message(body, attachments)
    msg["From"] = config["username"]
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    domain = config["username"].split("@")[-1] if "@" in config["username"] else "atlas.local"
    msg["Message-ID"] = make_msgid(domain=domain)

    try:
        with _smtp_connect(config) as server:
            server.send_message(msg)

        # Create thread in DB
        thread_id = sanitize_thread_id(msg["Message-ID"])
        db.execute("""
            INSERT OR IGNORE INTO threads
            (thread_id, subject, last_message_id, references_chain,
             last_sender, last_sender_full, participants, message_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        """, (
            thread_id, subject, msg["Message-ID"],
            json.dumps([msg["Message-ID"]]),
            config["username"], config["username"],
            json.dumps(sorted([config["username"], to])),
        ))

        # Store email record
        db.execute("""
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient, subject, body)
            VALUES (?, ?, 'out', ?, ?, ?, ?)
        """, (thread_id, msg["Message-ID"], config["username"], to, subject, body[:8000]))

        db.commit()
        print(f"Email sent to {to} (subject=\"{subject}\", thread={thread_id})")

    except Exception as e:
        print(f"ERROR: Failed to send: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        db.close()


# --- REPLY command ---

def cmd_reply(config, thread_id, body, attachments=None):
    """Reply to an existing email thread with proper threading headers."""
    if not config["smtp_host"] or not config["username"] or not config["password"]:
        print("ERROR: SMTP not configured. Set email section in config.yml", file=sys.stderr)
        sys.exit(1)

    db = get_email_db(config)

    thread = db.execute("SELECT * FROM threads WHERE thread_id = ?", (thread_id,)).fetchone()
    if not thread:
        print(f"ERROR: Thread {thread_id} not found", file=sys.stderr)
        db.close()
        sys.exit(1)

    # Unpack thread data
    cols = [d[0] for d in db.execute("SELECT * FROM threads LIMIT 0").description]
    thread_data = dict(zip(cols, thread))

    recipient = thread_data["last_sender"]
    subject = thread_data["subject"]
    last_message_id = thread_data["last_message_id"]
    references = json.loads(thread_data["references_chain"])

    msg = build_message(body, attachments)
    msg["From"] = config["username"]
    msg["To"] = recipient
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

        # Update thread state: append our Message-ID to references
        references.append(msg["Message-ID"])
        db.execute("""
            UPDATE threads SET
                last_message_id = ?,
                references_chain = ?,
                message_count = message_count + 1,
                updated_at = ?
            WHERE thread_id = ?
        """, (msg["Message-ID"], json.dumps(references), datetime.now().isoformat(), thread_id))

        # Store email record
        db.execute("""
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient, subject, body)
            VALUES (?, ?, 'out', ?, ?, ?, ?)
        """, (thread_id, msg["Message-ID"], config["username"], recipient,
              f"Re: {subject}", body[:8000]))

        db.commit()
        print(f"Reply sent to {recipient} (thread={thread_id}, "
              f"In-Reply-To={last_message_id or 'none'})")

    except Exception as e:
        print(f"ERROR: Failed to send reply: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        db.close()


# --- THREADS command ---

def cmd_threads(config, limit=20):
    """List tracked email threads."""
    db = get_email_db(config)
    rows = db.execute("""
        SELECT thread_id, subject, last_sender, message_count, updated_at
        FROM threads ORDER BY updated_at DESC LIMIT ?
    """, (limit,)).fetchall()

    if not rows:
        print("No email threads found.")
        db.close()
        return

    print(f"{'Thread ID':<40} {'Subject':<30} {'From':<25} {'Msgs':>4}  {'Updated'}")
    print("-" * 130)
    for row in rows:
        tid = row[0][:38]
        subj = row[1][:28]
        sender = row[2][:23]
        count = row[3]
        updated = row[4][:16]
        print(f"{tid:<40} {subj:<30} {sender:<25} {count:>4}  {updated}")

    db.close()


# --- THREAD detail command ---

def cmd_thread_detail(config, thread_id):
    """Show detail for a specific thread."""
    db = get_email_db(config)

    thread = db.execute("SELECT * FROM threads WHERE thread_id = ?", (thread_id,)).fetchone()
    if not thread:
        print(f"Thread {thread_id} not found.", file=sys.stderr)
        db.close()
        sys.exit(1)

    cols = [d[0] for d in db.execute("SELECT * FROM threads LIMIT 0").description]
    data = dict(zip(cols, thread))
    data["references_chain"] = json.loads(data["references_chain"])
    data["participants"] = json.loads(data["participants"])

    print(json.dumps(data, indent=2))

    # Show emails in thread
    emails = db.execute("""
        SELECT direction, sender, subject, created_at, body
        FROM emails WHERE thread_id = ? ORDER BY created_at
    """, (thread_id,)).fetchall()

    if emails:
        print(f"\n--- Messages ({len(emails)}) ---")
        for e in emails:
            direction = "→" if e[0] == "out" else "←"
            print(f"\n{direction} {e[1]} ({e[3]})")
            print(f"  Subject: {e[2]}")
            print(f"  {e[4][:200]}{'...' if len(e[4] or '') > 200 else ''}")

    db.close()


# --- Main CLI ---

def main():
    parser = argparse.ArgumentParser(
        description=f"{os.environ.get('AGENT_NAME', 'Atlas')} Email Add-on — unified email management",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  email-addon.py poll --once          # Check IMAP once
  email-addon.py poll                 # Continuous via IMAP IDLE
  email-addon.py send alice@x.com "Subject" "Body text"
  email-addon.py reply <thread_id> "Reply body"
  email-addon.py threads              # List all threads
  email-addon.py thread <thread_id>   # Thread detail
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

    # reply
    p_reply = sub.add_parser("reply", help="Reply to an email thread")
    p_reply.add_argument("thread_id", help="Thread ID to reply to")
    p_reply.add_argument("body", help="Reply body text")
    p_reply.add_argument("--attach", action="append", default=[], metavar="FILE",
                        help="Attach a file (can be used multiple times)")

    # threads
    p_threads = sub.add_parser("threads", help="List email threads")
    p_threads.add_argument("--limit", type=int, default=20, help="Max threads to show")

    # thread detail
    p_thread = sub.add_parser("thread", help="Show thread detail")
    p_thread.add_argument("thread_id", help="Thread ID")

    args = parser.parse_args()
    config = load_config()

    if args.command == "poll":
        if args.once:
            cmd_poll(config, once=True)
        else:
            cmd_poll_idle(config)

    elif args.command == "send":
        cmd_send(config, args.to, args.subject, args.body,
                 attachments=args.attach or None)

    elif args.command == "reply":
        cmd_reply(config, args.thread_id, args.body,
                  attachments=args.attach or None)

    elif args.command == "threads":
        cmd_threads(config, limit=args.limit)

    elif args.command == "thread":
        cmd_thread_detail(config, args.thread_id)


if __name__ == "__main__":
    main()
