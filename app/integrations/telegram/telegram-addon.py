#!/usr/bin/env python3
"""
Telegram Bot Add-on.

Manages a Telegram bot for receiving and sending messages. Uses the
Telegram Bot API directly (no external library required).

Subcommands:
  incoming <chat_id> <message>  Inject a message: write to DB + inbox, fire trigger
  send     <chat_id> <message>  Send a Telegram message (supports --attach for files)
  contacts [--limit N]          List known contacts/chats
  history  <chat_id> [--limit]  Show message history with a chat
  status                        Show bot status and info
  setup                         Interactive setup: create bot via BotFather instructions
"""

import argparse
import json
import os
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
TELEGRAM_DB_DIR = os.environ["HOME"] + "/.index/telegram"
TELEGRAM_ATTACHMENTS_DIR = os.environ["HOME"] + "/.local/share/telegram/attachments"
WAKE_PATH = os.environ["HOME"] + "/.index/.wake"
TRIGGER_SCRIPT = "/atlas/app/triggers/trigger.sh"
TRIGGER_NAME = "telegram-chat"

# Audio MIME types that should be transcribed
AUDIO_MIME_TYPES = {"audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav",
                    "audio/x-m4a", "audio/webm"}


# --- Config ---

def load_config():
    """Load config.yml and extract telegram settings."""
    import yaml  # lazy import, only used here
    if not os.path.exists(CONFIG_PATH):
        return {}
    with open(CONFIG_PATH) as f:
        cfg = yaml.safe_load(f) or {}
    return cfg


def get_bot_token():
    """Get the Telegram bot token from config or env."""
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if token:
        return token
    cfg = load_config()
    return cfg.get("telegram", {}).get("bot_token", "")


# --- Telegram Bot API ---

def api_call(method: str, data: dict = None, files: dict = None) -> dict:
    """Make a Telegram Bot API call."""
    token = get_bot_token()
    if not token:
        print("ERROR: No Telegram bot token configured.", file=sys.stderr)
        print("Set TELEGRAM_BOT_TOKEN in config.yml or env.", file=sys.stderr)
        sys.exit(1)

    url = f"https://api.telegram.org/bot{token}/{method}"

    if files:
        import mimetypes
        boundary = "----AtlasTelegramBoundary"
        body = b""
        for key, val in (data or {}).items():
            body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{val}\r\n".encode()
        for key, filepath in files.items():
            filename = os.path.basename(filepath)
            mime = mimetypes.guess_type(filepath)[0] or "application/octet-stream"
            with open(filepath, "rb") as f:
                file_data = f.read()
            body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"; "
                     f"filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n").encode()
            body += file_data + b"\r\n"
        body += f"--{boundary}--\r\n".encode()
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    elif data:
        body = json.dumps(data).encode()
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
    else:
        req = urllib.request.Request(url)

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        print(f"Telegram API error ({e.code}): {err_body}", file=sys.stderr)
        sys.exit(1)


# --- Database ---

def get_db() -> sqlite3.Connection:
    """Get or create the Telegram SQLite database."""
    os.makedirs(TELEGRAM_DB_DIR, exist_ok=True)
    db_path = os.path.join(TELEGRAM_DB_DIR, "telegram.db")
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS contacts (
            chat_id TEXT PRIMARY KEY,
            name TEXT DEFAULT '',
            username TEXT DEFAULT '',
            first_seen TEXT DEFAULT CURRENT_TIMESTAMP,
            last_message TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            direction TEXT NOT NULL,
            body TEXT DEFAULT '',
            timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
            attachments TEXT DEFAULT '[]'
        )
    """)
    conn.commit()
    return conn


# --- Commands ---

def cmd_incoming(config, chat_id: str, message: str, name: str = "",
                 username: str = "", timestamp: str = "", attachments_json: str = ""):
    """Process an incoming Telegram message."""
    db = get_db()
    ts = timestamp or datetime.utcnow().isoformat()

    # Upsert contact
    db.execute("""
        INSERT INTO contacts (chat_id, name, username, last_message)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
            name = CASE WHEN excluded.name != '' THEN excluded.name ELSE contacts.name END,
            username = CASE WHEN excluded.username != '' THEN excluded.username ELSE contacts.username END,
            last_message = excluded.last_message
    """, (chat_id, name, username, ts))

    # Insert message
    db.execute("""
        INSERT INTO messages (chat_id, direction, body, timestamp, attachments)
        VALUES (?, 'incoming', ?, ?, ?)
    """, (chat_id, message, ts, attachments_json or "[]"))
    db.commit()
    db.close()

    # Build XML payload for trigger
    display = name or username or chat_id
    xml = f'<telegram-message from="{xml_escape(chat_id)}" name="{xml_escape(display)}" at="{xml_escape(ts)}">\n'
    xml += f"  {xml_escape(message)}\n"
    xml += "</telegram-message>"

    # Fire trigger
    subprocess.Popen(
        [TRIGGER_SCRIPT, TRIGGER_NAME, xml, chat_id],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    print(f"Incoming from {display}: {message[:80]}")


def cmd_send(config, chat_id: str, message: str, attachments: list = None):
    """Send a Telegram message."""
    db = get_db()

    # Send text message
    if message.strip():
        api_call("sendMessage", {"chat_id": chat_id, "text": message})

    # Send attachments
    for filepath in (attachments or []):
        if not os.path.exists(filepath):
            print(f"WARNING: Attachment not found: {filepath}", file=sys.stderr)
            continue
        ext = os.path.splitext(filepath)[1].lower()
        if ext in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
            api_call("sendPhoto", {"chat_id": chat_id}, files={"photo": filepath})
        else:
            api_call("sendDocument", {"chat_id": chat_id}, files={"document": filepath})

    # Log to DB
    db.execute("""
        INSERT INTO messages (chat_id, direction, body, timestamp)
        VALUES (?, 'outgoing', ?, ?)
    """, (chat_id, message, datetime.utcnow().isoformat()))
    db.commit()
    db.close()

    print(f"Telegram message sent to {chat_id}")


def cmd_contacts(config, limit: int = 20):
    """List known Telegram contacts."""
    db = get_db()
    rows = db.execute("""
        SELECT chat_id, name, username, last_message
        FROM contacts ORDER BY last_message DESC LIMIT ?
    """, (limit,)).fetchall()
    db.close()

    if not rows:
        print("No Telegram contacts found.")
        return

    for chat_id, name, username, last_msg in rows:
        display = name or username or chat_id
        handle = f" (@{username})" if username else ""
        print(f"  {display}{handle}  [{chat_id}]  last: {last_msg}")


def cmd_history(config, chat_id: str, limit: int = 20):
    """Show message history with a Telegram chat."""
    db = get_db()
    rows = db.execute("""
        SELECT direction, body, timestamp
        FROM messages WHERE chat_id = ?
        ORDER BY timestamp DESC LIMIT ?
    """, (chat_id, limit)).fetchall()
    db.close()

    if not rows:
        print(f"No messages with {chat_id}.")
        return

    for direction, body, ts in reversed(rows):
        arrow = "→" if direction == "outgoing" else "←"
        print(f"  [{ts}] {arrow} {body[:200]}")


def cmd_status():
    """Show bot status and info."""
    token = get_bot_token()
    if not token:
        print("Status: not configured")
        print("No bot token found. Run 'telegram setup' or set TELEGRAM_BOT_TOKEN.")
        return

    result = api_call("getMe")
    if result.get("ok"):
        bot = result["result"]
        print(f"Status: connected")
        print(f"Bot: @{bot.get('username', '?')}")
        print(f"Name: {bot.get('first_name', '?')}")
        print(f"ID: {bot.get('id', '?')}")
    else:
        print("Status: error — invalid token or API issue")


def cmd_setup():
    """Print setup instructions for creating a Telegram bot."""
    print("""
Telegram Bot einrichten
=======================

1. Öffne Telegram und suche nach @BotFather
2. Sende /newbot an den BotFather
3. Wähle einen Namen für deinen Bot (z.B. "Mein Assistent")
4. Wähle einen Benutzernamen (muss auf 'bot' enden, z.B. "mein_assistent_bot")
5. Der BotFather gibt dir einen Token — kopiere ihn

6. Trage den Token in ~/config.yml ein:
   telegram:
     bot_token: "DEIN_TOKEN_HIER"

7. Starte den Telegram-Daemon:
   supervisorctl start telegram-daemon

8. Öffne deinen Bot in Telegram und schreibe /start

Hinweis zur Sicherheit:
  Telegram-Bots sind NICHT Ende-zu-Ende-verschlüsselt.
  Für sensible Daten nutze Signal oder den Dashboard-Chat.
""")


def main():
    parser = argparse.ArgumentParser(
        description=f"{os.environ.get('AGENT_NAME', 'Atlas')} Telegram Add-on",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # incoming
    p_in = sub.add_parser("incoming", help="Inject an incoming message")
    p_in.add_argument("chat_id", help="Chat ID")
    p_in.add_argument("message", help="Message text")
    p_in.add_argument("--name", default="", help="Sender display name")
    p_in.add_argument("--username", default="", help="Sender username")
    p_in.add_argument("--timestamp", default="", help="Message timestamp")
    p_in.add_argument("--attachments", default="", help="JSON array of attachment metadata")

    # send
    p_send = sub.add_parser("send", help="Send a Telegram message")
    p_send.add_argument("chat_id", help="Chat ID")
    p_send.add_argument("message", help="Message text")
    p_send.add_argument("--attach", action="append", default=[], metavar="FILE",
                         help="Attach a file. Can be repeated.")

    # contacts
    p_contacts = sub.add_parser("contacts", help="List known contacts")
    p_contacts.add_argument("--limit", type=int, default=20)

    # history
    p_history = sub.add_parser("history", help="Message history with a chat")
    p_history.add_argument("chat_id", help="Chat ID")
    p_history.add_argument("--limit", type=int, default=20)

    # status
    sub.add_parser("status", help="Show bot status")

    # setup
    sub.add_parser("setup", help="Setup instructions for Telegram bot")

    args = parser.parse_args()
    config = load_config()

    if args.command == "incoming":
        cmd_incoming(config, args.chat_id, args.message,
                     name=args.name, username=args.username,
                     timestamp=args.timestamp, attachments_json=args.attachments)
    elif args.command == "send":
        cmd_send(config, args.chat_id, args.message, attachments=args.attach)
    elif args.command == "contacts":
        cmd_contacts(config, limit=args.limit)
    elif args.command == "history":
        cmd_history(config, args.chat_id, limit=args.limit)
    elif args.command == "status":
        cmd_status()
    elif args.command == "setup":
        cmd_setup()


if __name__ == "__main__":
    main()
