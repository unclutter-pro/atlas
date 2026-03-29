#!/usr/bin/env python3
"""
WhatsApp Communication Add-on.

All WhatsApp operations in one module: injecting incoming messages,
sending/replying, and contact/conversation tracking. Uses its own SQLite
database. The WhatsApp daemon (whatsapp-daemon.ts) handles the actual
Baileys connection — this addon is the CLI interface.

Subcommands:
  incoming <sender> <message>    Inject a message: write to DB + inbox, fire trigger
  send     <number> <message>    Send a WhatsApp message (supports --attach for files)
  contacts [--limit N]           List known contacts
  history  <number> [--limit]    Show message history with a contact
"""

import argparse
import json
import os
import re
import socket as _socket_mod
import sqlite3
import subprocess
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape as xml_escape

# --- Paths ---
CONFIG_PATH = os.environ["HOME"] + "/config.yml"
ATLAS_DB_PATH = os.environ["HOME"] + "/.index/atlas.db"
WHATSAPP_DB_DIR = os.environ["HOME"] + "/.index/whatsapp"
WHATSAPP_ATTACHMENTS_DIR = os.environ["HOME"] + "/.local/share/whatsapp/attachments"
WAKE_PATH = os.environ["HOME"] + "/.index/.wake"
TRIGGER_SCRIPT = "/atlas/app/triggers/trigger.sh"
TRIGGER_NAME = "whatsapp-chat"
DAEMON_SOCKET = "/tmp/whatsapp.sock"
WHATSAPP_STATUS_PATH = os.environ["HOME"] + "/.local/share/whatsapp/status.json"
WHATSAPP_QR_PATH = os.environ["HOME"] + "/.local/share/whatsapp/qr-code.png"

# Audio MIME types that should be transcribed
AUDIO_MIME_TYPES = {"audio/aac", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav",
                    "audio/x-m4a", "audio/m4a", "audio/webm", "audio/flac",
                    "audio/ogg; codecs=opus"}


# --- Config ---

def load_config():
    """Load WhatsApp config from config.yml, with env overrides."""
    cfg = {}
    stt_cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            import yaml
            with open(CONFIG_PATH) as f:
                data = yaml.safe_load(f) or {}
            cfg = data.get("whatsapp", {})
            stt_cfg = data.get("stt", {})
        except ImportError:
            pass

    return {
        "whitelist": cfg.get("whitelist", []),
        "stt_url": os.environ.get("ATLAS_STT_URL", os.environ.get("STT_URL", stt_cfg.get("url", "http://stt:5092/v1/audio/transcriptions"))),
        "stt_enabled": os.environ.get("ATLAS_STT_ENABLED", os.environ.get("STT_ENABLED", str(stt_cfg.get("enabled", True)))).lower() not in ("false", "0", "no"),
    }


# --- WhatsApp Database ---

def get_whatsapp_db():
    """Open (or create) the WhatsApp database."""
    os.makedirs(WHATSAPP_DB_DIR, exist_ok=True)

    db_path = os.path.join(WHATSAPP_DB_DIR, "whatsapp.db")

    db = sqlite3.connect(db_path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=5000")

    db.executescript("""
        CREATE TABLE IF NOT EXISTS contacts (
            number          TEXT PRIMARY KEY,
            name            TEXT NOT NULL DEFAULT '',
            message_count   INTEGER NOT NULL DEFAULT 0,
            first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
            last_seen       TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS messages (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            contact_number  TEXT NOT NULL,
            direction       TEXT NOT NULL DEFAULT 'in',
            body            TEXT NOT NULL DEFAULT '',
            timestamp       TEXT NOT NULL DEFAULT '',
            inbox_msg_id    INTEGER,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (contact_number) REFERENCES contacts(number)
        );

        CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_number);
        CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);
    """)

    return db


def update_contact(db, number, name=""):
    """Update or create contact in the WhatsApp DB."""
    db.execute("""
        INSERT INTO contacts (number, name, message_count, last_seen)
        VALUES (?, ?, 1, datetime('now'))
        ON CONFLICT(number) DO UPDATE SET
            name = CASE WHEN excluded.name != '' THEN excluded.name ELSE contacts.name END,
            message_count = contacts.message_count + 1,
            last_seen = datetime('now')
    """, (number, name))


# --- Speech-to-Text ---

def _resolve_attachment_path(attachment_id: str) -> str | None:
    """Find the attachment file downloaded by the WhatsApp daemon."""
    att_dir = Path(WHATSAPP_ATTACHMENTS_DIR)
    if not att_dir.exists():
        return None
    for f in att_dir.iterdir():
        if f.stem == attachment_id or f.name == attachment_id:
            return str(f)
    return None


def _convert_to_wav(file_path: str) -> str | None:
    """Convert audio file to WAV using ffmpeg. Returns path to temp WAV file."""
    import tempfile
    wav_path = tempfile.mktemp(suffix=".wav")
    try:
        result = subprocess.run(
            ["ffmpeg", "-i", file_path, "-ar", "16000", "-ac", "1", "-y", wav_path],
            capture_output=True, timeout=120,
        )
        if result.returncode == 0 and os.path.exists(wav_path):
            return wav_path
        print(f"[{datetime.now()}] ffmpeg conversion failed: {result.stderr.decode()[:200]}", file=sys.stderr)
    except Exception as e:
        print(f"[{datetime.now()}] ffmpeg error: {e}", file=sys.stderr)
    return None


def _get_audio_duration(file_path: str) -> float:
    """Get audio duration in seconds using ffprobe."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", file_path],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            import json as _json
            info = _json.loads(result.stdout)
            return float(info.get("format", {}).get("duration", 0))
    except Exception:
        pass
    return 0


def _split_wav_chunks(wav_path: str, chunk_secs: int = 120, overlap_secs: int = 1) -> list[str]:
    """Split a WAV file into overlapping chunks using ffmpeg. Returns list of chunk paths."""
    import tempfile
    duration = _get_audio_duration(wav_path)
    if duration <= chunk_secs:
        return [wav_path]

    chunks = []
    start = 0
    idx = 0
    while start < duration:
        chunk_path = tempfile.mktemp(suffix=f"_chunk{idx}.wav")
        try:
            result = subprocess.run(
                ["ffmpeg", "-y", "-i", wav_path, "-ss", str(start), "-t", str(chunk_secs),
                 "-ar", "16000", "-ac", "1", chunk_path],
                capture_output=True, timeout=60,
            )
            if result.returncode == 0 and os.path.exists(chunk_path) and os.path.getsize(chunk_path) > 100:
                chunks.append(chunk_path)
            else:
                break
        except Exception as e:
            print(f"[{datetime.now()}] Chunk split error at {start}s: {e}", file=sys.stderr)
            break
        start += chunk_secs - overlap_secs
        idx += 1

    return chunks if chunks else [wav_path]


# Formats that Parakeet supports natively (no conversion needed)
_NATIVE_STT_FORMATS = {".wav", ".flac", ".ogg"}

# Audio longer than this (seconds) gets split into chunks
_CHUNK_THRESHOLD_SECS = 120
_CHUNK_SIZE_SECS = 120
_CHUNK_OVERLAP_SECS = 1


def _transcribe_audio(file_path: str, stt_url: str) -> str | None:
    """Send audio file to STT endpoint (Whisper-compatible API) and return text.
    Long audio files are split into overlapping chunks to avoid timeouts."""
    import mimetypes

    # Convert non-native formats to WAV
    ext = os.path.splitext(file_path)[1].lower()
    converted_path = None
    if ext not in _NATIVE_STT_FORMATS:
        converted_path = _convert_to_wav(file_path)
        if not converted_path:
            return None
        file_path = converted_path

    content_type = mimetypes.guess_type(file_path)[0] or "audio/wav"
    chunk_paths = []

    try:
        duration = _get_audio_duration(file_path)
        if duration > _CHUNK_THRESHOLD_SECS:
            print(f"[{datetime.now()}] Audio is {duration:.0f}s, splitting into {_CHUNK_SIZE_SECS}s chunks "
                  f"with {_CHUNK_OVERLAP_SECS}s overlap", file=sys.stderr)
            chunk_paths = _split_wav_chunks(file_path, _CHUNK_SIZE_SECS, _CHUNK_OVERLAP_SECS)
            transcriptions = []
            for i, chunk in enumerate(chunk_paths):
                print(f"[{datetime.now()}] Transcribing chunk {i+1}/{len(chunk_paths)}", file=sys.stderr)
                chunk_name = os.path.basename(chunk)
                text = _do_stt_request(chunk, chunk_name, "audio/wav", stt_url)
                if text:
                    transcriptions.append(text)
            return " ".join(transcriptions) if transcriptions else None
        else:
            filename = os.path.basename(file_path)
            return _do_stt_request(file_path, filename, content_type, stt_url)
    finally:
        if converted_path and os.path.exists(converted_path):
            os.unlink(converted_path)
        for cp in chunk_paths:
            if cp != file_path and os.path.exists(cp):
                os.unlink(cp)


def _do_stt_request(file_path: str, filename: str, content_type: str, stt_url: str) -> str | None:
    """Build and send the multipart STT request."""
    boundary = "----AtlasSTTBoundary"
    body = b""
    body += f"--{boundary}\r\n".encode()
    body += f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode()
    body += f"Content-Type: {content_type}\r\n\r\n".encode()
    with open(file_path, "rb") as f:
        body += f.read()
    body += b"\r\n"
    body += f"--{boundary}\r\n".encode()
    body += b'Content-Disposition: form-data; name="model"\r\n\r\n'
    body += b"default\r\n"
    body += f"--{boundary}--\r\n".encode()

    req = urllib.request.Request(
        stt_url,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            result = json.loads(resp.read())
            return result.get("text", "").strip()
    except (urllib.error.URLError, json.JSONDecodeError, OSError) as e:
        print(f"[{datetime.now()}] STT error: {e}", file=sys.stderr)
        return None


def _process_attachments(attachments_json: str, config: dict) -> tuple[list[dict], str]:
    """Process attachments: resolve paths, transcribe audio.

    Returns (attachment_metadata_list, transcription_text).
    """
    try:
        attachments = json.loads(attachments_json)
    except (json.JSONDecodeError, TypeError):
        return [], ""

    metadata = []
    transcriptions = []

    for att in attachments:
        att_id = att.get("id", "")
        content_type = att.get("contentType", att.get("content_type", ""))
        size = att.get("size", 0)
        file_path = att.get("path") or (_resolve_attachment_path(att_id) if att_id else None)

        entry = {
            "id": att_id,
            "content_type": content_type,
            "size": size,
            "path": file_path,
        }

        # Transcribe audio attachments
        if file_path and content_type in AUDIO_MIME_TYPES and config.get("stt_enabled", True):
            stt_url = config.get("stt_url", "")
            if stt_url:
                print(f"[{datetime.now()}] Transcribing audio: {file_path} ({content_type})")
                text = _transcribe_audio(file_path, stt_url)
                if text:
                    entry["transcription"] = text
                    transcriptions.append(text)
                    print(f"[{datetime.now()}] Transcription: {text[:100]}...")
                else:
                    entry["transcription_error"] = "STT failed or unavailable"
                    print(f"[{datetime.now()}] Transcription failed for {file_path}")

        metadata.append(entry)

    transcription_text = " ".join(transcriptions) if transcriptions else ""
    return metadata, transcription_text


# --- XML payload helpers ---

WEEKDAYS_DE = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]
MONTHS_DE = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"]


def _format_timestamp(ts_raw: str) -> str:
    """Format a timestamp into a human-readable German-style string."""
    try:
        if ts_raw.isdigit():
            dt = datetime.fromtimestamp(int(ts_raw) / 1000)
        else:
            dt = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
        wd = WEEKDAYS_DE[dt.weekday()]
        mon = MONTHS_DE[dt.month - 1]
        return f"{wd}, {dt.day:02d}. {mon} {dt.year}, {dt.hour:02d}:{dt.minute:02d}"
    except Exception:
        return ts_raw


def _build_xml_payload(
    inbox_msg_id: int,
    sender: str,
    sender_name: str,
    message: str,
    timestamp: str,
    attachments: list | None = None,
    channel: str = "whatsapp",
) -> str:
    """Build a structured XML payload for AI processing."""
    name_attr = f' name="{xml_escape(sender_name)}"' if sender_name else ""
    tag = f"{channel}-message"
    parts = [
        f'<{tag} from="{xml_escape(sender)}"{name_attr} at="{xml_escape(timestamp)}" inbox-id="{inbox_msg_id}">',
    ]

    if attachments:
        for att in attachments:
            att_attrs = f'type="{xml_escape(str(att.get("content_type", "unknown")))}"'
            if att.get("path"):
                att_attrs += f' path="{xml_escape(att["path"])}"'
            if att.get("size"):
                att_attrs += f' size="{att["size"]}"'
            if att.get("transcription"):
                att_attrs += f' transcription="{xml_escape(att["transcription"])}"'
            elif att.get("transcription_error"):
                att_attrs += f' transcription-error="{xml_escape(att["transcription_error"])}"'
            parts.append(f"  <attachment {att_attrs} />")

    parts.append(f"  {xml_escape(message)}")
    parts.append(f"</{tag}>")
    return "\n".join(parts)


# --- INCOMING command (core: inject message into session) ---

def cmd_incoming(config, sender, message, name="", timestamp="", attachments_json=""):
    """Inject an incoming message: store in DB, write to inbox, fire trigger."""
    # Whitelist check
    if config["whitelist"] and sender not in config["whitelist"]:
        print(f"Blocked: {sender} not in whitelist", file=sys.stderr)
        return

    # Process attachments (transcribe audio)
    attachment_metadata = []
    transcription = ""
    if attachments_json:
        attachment_metadata, transcription = _process_attachments(attachments_json, config)

    # Build the effective message: original text + transcription
    effective_message = message
    if transcription and not message:
        effective_message = f"[Voice message] {transcription}"
    elif transcription and message:
        effective_message = f"{message}\n[Voice message] {transcription}"

    db = get_whatsapp_db()
    ts = timestamp or datetime.now().isoformat()

    # 1. Store in WhatsApp DB
    update_contact(db, sender, name)
    db.execute("""
        INSERT INTO messages (contact_number, direction, body, timestamp)
        VALUES (?, 'in', ?, ?)
    """, (sender, effective_message[:8000], ts))

    # 2. Write to atlas inbox
    atlas_db = sqlite3.connect(ATLAS_DB_PATH)
    atlas_db.execute("PRAGMA busy_timeout=5000")
    cursor = atlas_db.execute(
        "INSERT INTO messages (channel, sender, content) VALUES (?, ?, ?)",
        ("whatsapp", sender, effective_message),
    )
    inbox_msg_id = cursor.lastrowid
    atlas_db.commit()
    atlas_db.close()

    # Update WhatsApp DB with inbox reference
    db.execute("UPDATE messages SET inbox_msg_id = ? WHERE rowid = last_insert_rowid()",
               (inbox_msg_id,))
    db.commit()
    db.close()

    # Touch .wake
    Path(WAKE_PATH).touch()

    print(f"[{datetime.now()}] WhatsApp from {sender}: {effective_message[:80]}... (inbox={inbox_msg_id})")

    # Check for /new command
    if message.strip().lower() == "/new":
        cmd_new_session(config, sender, inbox_msg_id, name=name, timestamp=ts)
        return

    # 3. Fire trigger — structured XML payload
    formatted_ts = _format_timestamp(ts)
    payload = _build_xml_payload(
        inbox_msg_id=inbox_msg_id,
        sender=sender,
        sender_name=name,
        message=effective_message[:10000],
        timestamp=formatted_ts,
        attachments=attachment_metadata if attachment_metadata else None,
        channel="whatsapp",
    )

    try:
        subprocess.Popen(
            [TRIGGER_SCRIPT, TRIGGER_NAME, payload, sender],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        print(f"Failed to fire trigger: {e}", file=sys.stderr)


# --- /new SESSION RESET ---

FAREWELL_TEMPLATE_PATH = "/atlas/app/prompts/trigger-channel-whatsapp-farewell.md"


def _inject_ipc(socket_path, message):
    """Inject a message into a running Claude session via IPC socket."""
    s = _socket_mod.socket(_socket_mod.AF_UNIX, _socket_mod.SOCK_STREAM)
    s.settimeout(10)
    try:
        s.connect(socket_path)
        s.sendall(json.dumps({"action": "send", "text": message, "submit": True}).encode() + b"\n")
    finally:
        s.close()


def _wait_for_socket_gone(socket_path, timeout=120):
    """Wait for IPC socket to disappear (session finished processing)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not os.path.exists(socket_path):
            return True
        time.sleep(2)
    return False


def _load_farewell_message():
    """Load the farewell prompt template with today's date substituted."""
    today = datetime.now().strftime("%Y-%m-%d")
    if os.path.exists(FAREWELL_TEMPLATE_PATH):
        with open(FAREWELL_TEMPLATE_PATH) as f:
            return f.read().replace("{{today}}", today)
    # Inline fallback
    return (
        "<session-ending reason=\"user-requested-new-session\">\n"
        "The user sent /new to start a fresh conversation. This session is being retired.\n\n"
        f"Save important context to memory/journal/{today}.md (create or append):\n"
        "- Summary of this conversation's key topics\n"
        "- Decisions made and tasks created/completed\n"
        "- Open questions or commitments\n"
        "- Context the next session should know\n\n"
        "Update memory/MEMORY.md only for genuinely new long-term information.\n\n"
        "IMPORTANT: Do NOT send any WhatsApp messages. Save to memory silently.\n"
        "</session-ending>"
    )


def _resume_with_farewell(session_id, sender, farewell):
    """Resume an inactive session with a farewell message so it can save to memory."""
    env = os.environ.copy()
    env["ATLAS_TRIGGER"] = TRIGGER_NAME
    env["ATLAS_TRIGGER_CHANNEL"] = "whatsapp"
    env["ATLAS_TRIGGER_SESSION_KEY"] = sender
    env.pop("CLAUDECODE", None)
    subprocess.run(
        ["/atlas/app/triggers/trigger-runner",
         "--direct", farewell,
         "--channel", "whatsapp",
         "--resume", session_id],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=180,
        env=env,
    )


def cmd_new_session(config, sender, inbox_msg_id, name="", timestamp=""):
    """Handle /new command: instruct old session to save to memory, then start fresh."""
    ts = timestamp or datetime.now().isoformat()

    atlas_db = sqlite3.connect(ATLAS_DB_PATH)
    atlas_db.execute("PRAGMA busy_timeout=5000")

    # Find existing session
    row = atlas_db.execute(
        "SELECT session_id FROM trigger_sessions WHERE trigger_name=? AND session_key=?",
        (TRIGGER_NAME, sender),
    ).fetchone()

    old_session_id = row[0] if row else None
    farewell_sent = False

    if old_session_id:
        farewell = _load_farewell_message()
        socket_path = f"/tmp/claudec-{old_session_id}.sock"

        if os.path.exists(socket_path):
            try:
                _inject_ipc(socket_path, farewell)
                farewell_sent = True
                print(f"[{datetime.now()}] /new: Injected farewell into running session {old_session_id}")
                _wait_for_socket_gone(socket_path, timeout=120)
            except Exception as e:
                print(f"[{datetime.now()}] /new: Failed to inject farewell: {e}", file=sys.stderr)
        else:
            try:
                _resume_with_farewell(old_session_id, sender, farewell)
                farewell_sent = True
                print(f"[{datetime.now()}] /new: Resumed session {old_session_id} for farewell")
            except subprocess.TimeoutExpired:
                print(f"[{datetime.now()}] /new: Farewell resume timed out", file=sys.stderr)
            except Exception as e:
                print(f"[{datetime.now()}] /new: Failed to resume for farewell: {e}", file=sys.stderr)

        atlas_db.execute(
            "DELETE FROM trigger_sessions WHERE trigger_name=? AND session_key=?",
            (TRIGGER_NAME, sender),
        )
        atlas_db.commit()
        print(f"[{datetime.now()}] /new: Cleared session for {sender}")

    atlas_db.close()

    # Fire fresh trigger
    payload = json.dumps({
        "inbox_message_id": inbox_msg_id,
        "sender": sender,
        "sender_name": name,
        "message": "/new",
        "timestamp": ts,
    })

    try:
        subprocess.Popen(
            [TRIGGER_SCRIPT, TRIGGER_NAME, payload, sender],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        print(f"[{datetime.now()}] /new: Failed to fire fresh trigger: {e}", file=sys.stderr)

    print(f"[{datetime.now()}] /new: Fresh session fired for {sender} (farewell_sent={farewell_sent})")


# --- SEND command ---

def _send_via_socket(to, message, attachments=None):
    """Send via the WhatsApp daemon JSON-RPC socket."""
    import socket as _socket
    with _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM) as s:
        s.settimeout(30)
        s.connect(DAEMON_SOCKET)
        params = {"recipient": [to], "message": message}
        if attachments:
            params["attachments"] = [os.path.abspath(f) for f in attachments]
        req = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "send", "params": params})
        s.sendall(req.encode() + b"\n")
        # Read response
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(4096)
            if not chunk:
                break
            buf += chunk
        resp = json.loads(buf.split(b"\n")[0])
        if "error" in resp:
            raise RuntimeError(resp["error"].get("message", str(resp["error"])))


def cmd_send(config, to, message, attachments=None):
    """Send a WhatsApp message via the daemon socket."""
    # Validate attachment files exist
    attachments = attachments or []
    for f in attachments:
        if not os.path.isfile(f):
            print(f"ERROR: Attachment not found: {f}", file=sys.stderr)
            sys.exit(1)

    if not os.path.exists(DAEMON_SOCKET):
        print("ERROR: WhatsApp daemon not running (socket not found). "
              "Start the daemon first: supervisorctl start whatsapp-daemon",
              file=sys.stderr)
        sys.exit(1)

    db = get_whatsapp_db()
    try:
        _send_via_socket(to, message, attachments)

        update_contact(db, to)
        stored_msg = message
        if attachments:
            filenames = [os.path.basename(f) for f in attachments]
            stored_msg += f"\n[Attachments: {', '.join(filenames)}]"
        db.execute("""
            INSERT INTO messages (contact_number, direction, body, timestamp)
            VALUES (?, 'out', ?, ?)
        """, (to, stored_msg[:8000], datetime.now().isoformat()))
        db.commit()
        att_info = f" (+{len(attachments)} attachment(s))" if attachments else ""
        print(f"WhatsApp message sent to {to}{att_info}")
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        db.close()


# --- CONTACTS command ---

def cmd_contacts(config, limit=20):
    """List known WhatsApp contacts."""
    db = get_whatsapp_db()
    rows = db.execute("""
        SELECT number, name, message_count, last_seen
        FROM contacts ORDER BY last_seen DESC LIMIT ?
    """, (limit,)).fetchall()

    if not rows:
        print("No WhatsApp contacts found.")
        db.close()
        return

    print(f"{'Number':<20} {'Name':<25} {'Messages':>8}  {'Last Seen'}")
    print("-" * 80)
    for row in rows:
        print(f"{row[0][:18]:<20} {(row[1] or '-')[:23]:<25} {row[2]:>8}  {row[3][:16]}")

    db.close()


# --- HISTORY command ---

def cmd_history(config, contact_number, limit=20):
    """Show message history with a contact."""
    db = get_whatsapp_db()

    contact = db.execute("SELECT * FROM contacts WHERE number = ?",
                         (contact_number,)).fetchone()
    if not contact:
        print(f"Contact {contact_number} not found.", file=sys.stderr)
        db.close()
        sys.exit(1)

    cols = [d[0] for d in db.execute("SELECT * FROM contacts LIMIT 0").description]
    data = dict(zip(cols, contact))
    print(f"Contact: {data['number']} ({data['name'] or 'unknown'})")
    print(f"Messages: {data['message_count']}, First seen: {data['first_seen']}")
    print()

    messages = db.execute("""
        SELECT direction, body, created_at
        FROM messages WHERE contact_number = ? ORDER BY created_at DESC LIMIT ?
    """, (contact_number, limit)).fetchall()

    for m in reversed(messages):
        direction = "\u2192" if m[0] == "out" else "\u2190"
        print(f"{direction} ({m[2][:16]})")
        print(f"  {m[1][:200]}{'...' if len(m[1] or '') > 200 else ''}")
        print()

    db.close()


# --- Main CLI ---

def cmd_status():
    """Show WhatsApp connection status. If waiting for QR scan, print the QR image path."""
    if os.path.exists(WHATSAPP_STATUS_PATH):
        with open(WHATSAPP_STATUS_PATH) as f:
            status = json.load(f)
        print(f"Status: {status.get('status', 'unknown')}")
        print(f"Updated: {status.get('updatedAt', 'unknown')}")
        print(f"Message: {status.get('message', '')}")
        if status.get("status") == "waiting_for_scan" and os.path.exists(WHATSAPP_QR_PATH):
            print(f"QR Code: {WHATSAPP_QR_PATH}")
    else:
        # Check if daemon socket exists (connection might be up without status file)
        if os.path.exists(DAEMON_SOCKET):
            print("Status: connected (legacy — no status file)")
        else:
            print("Status: not running")
            print("Start with: supervisorctl start whatsapp-daemon")


def main():
    parser = argparse.ArgumentParser(
        description=f"{os.environ.get('AGENT_NAME', 'Atlas')} WhatsApp Add-on",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  whatsapp-addon.py incoming +49170123 "Hello!"        # Inject incoming message
  whatsapp-addon.py send +49170123 "Hi!"               # Send outgoing message
  whatsapp-addon.py contacts                           # List contacts
  whatsapp-addon.py history +49170123                  # Conversation history
        """,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # incoming
    p_in = sub.add_parser("incoming", help="Inject an incoming message")
    p_in.add_argument("sender", help="Sender phone number")
    p_in.add_argument("message", help="Message text")
    p_in.add_argument("--name", default="", help="Sender display name")
    p_in.add_argument("--timestamp", default="", help="Message timestamp")
    p_in.add_argument("--attachments", default="", help="JSON array of attachment metadata")

    # send
    p_send = sub.add_parser("send", help="Send a WhatsApp message")
    p_send.add_argument("number", help="Recipient phone number")
    p_send.add_argument("message", help="Message text")
    p_send.add_argument("--attach", action="append", default=[], metavar="FILE",
                         help="Attach a file (image, PDF, etc.). Can be repeated.")

    # contacts
    p_contacts = sub.add_parser("contacts", help="List known contacts")
    p_contacts.add_argument("--limit", type=int, default=20)

    # history
    p_history = sub.add_parser("history", help="Message history with a contact")
    p_history.add_argument("number", help="Contact phone number")
    p_history.add_argument("--limit", type=int, default=20)

    # status
    sub.add_parser("status", help="Show WhatsApp connection status and QR code path if available")

    args = parser.parse_args()
    config = load_config()

    if args.command == "incoming":
        cmd_incoming(config, args.sender, args.message,
                     name=args.name, timestamp=args.timestamp,
                     attachments_json=args.attachments)
    elif args.command == "send":
        cmd_send(config, args.number, args.message, attachments=args.attach)
    elif args.command == "contacts":
        cmd_contacts(config, limit=args.limit)
    elif args.command == "history":
        cmd_history(config, args.number, limit=args.limit)
    elif args.command == "status":
        cmd_status()


if __name__ == "__main__":
    main()
