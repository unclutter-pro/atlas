# Integrations

Atlas supports Signal and Email as communication channels. Each integration writes incoming messages to the inbox, then spawns a trigger session (persistent, keyed per contact/thread) that can reply directly or delegate complex tasks to subagents via `Agent(...)`.

## Architecture

```
External Channel          Atlas
═══════════════           ═════

Signal message ──▸ signal incoming <sender> <message>
                    │                     (or: signal poll)
                    ├─▸ UPDATE signal.db contacts + messages
                    ├─▸ INSERT INTO atlas inbox (channel=signal, reply_to=sender)
                    │
                    └─▸ trigger.sh signal-chat <payload> <sender>
                          │
                          ├─▸ IPC socket alive? → inject directly into running session
                          │
                          └─▸ No socket? → spawn new claude -p session
                                                │
                                          Trigger session
                                          (persistent, per sender)
                                                │
                                    ┌───────────┴───────────┐
                                    │                       │
                          signal send               Agent(...)
                          (direct CLI call)             (delegate)
                                    │                       │
                                    ▼                       ▼
                            signal-cli send         Subagent worker


Email (IMAP) ──▸ email poll
                    │
                    ├─▸ UPDATE email.db threads + emails
                    ├─▸ INSERT INTO atlas inbox (channel=email, reply_to=thread_id)
                    │
                    └─▸ trigger.sh email-handler <payload> <thread_id>
                          │
                          ├─▸ IPC socket alive? → inject into running session
                          │
                          └─▸ No socket? → spawn new session
                                                │
                                          Trigger session
                                          (persistent, per thread)
                                                │
                                    ┌───────────┴───────────┐
                                    │                       │
                          email reply                Agent(...)
                          (direct CLI call)              (delegate)
                                    │                       │
                                    ▼                       ▼
                            SMTP with threading     Subagent worker
                            headers
```

## IPC Socket Injection

When a message arrives while a trigger session is already running for the same contact/thread, `trigger.sh` injects it directly into the running session via Claude Code's IPC socket:

```
Session running (claude -p --resume <id>)
  → IPC socket exists at /tmp/claudec-<session_id>.sock
  → trigger.sh sends: {"action":"send","text":"<message>","submit":true}
  → Message is queued in the session, processed after current turn
  → No new process, no restart
```

If the socket doesn't exist (session not running), `trigger.sh` spawns a new `claude -p` process as usual.

This works identically for Signal (per contact), Email (per thread), and any future integration.

## Signal Add-on

The Signal Add-on provides the `signal` CLI tool (wrapper for `app/integrations/signal/signal-addon.py`). Handles polling signal-cli, injecting messages, sending, and contact tracking. One SQLite database per phone number.

### Prerequisites

```bash
# In ~/user-extensions.sh:
apt-get install -y signal-cli

# Register your number (one-time, interactive):
signal-cli -a +491701234567 register
signal-cli -a +491701234567 verify 123-456
```

### Setup

**1. Configure** `~/config.yml`:

```yaml
signal:
  number: "+491701234567"
  whitelist: ["+491709876543", "+491701111111"]   # empty = accept all
```

**2. Create trigger** (ask Claude or via web-ui):

```
trigger_create:
  name: "signal-chat"
  type: "webhook"
  session_mode: "persistent"
  channel: "signal"
  description: "Signal messenger conversations"
  prompt: |
    New Signal message received:

    {{payload}}

    The payload contains inbox_message_id and sender. Reply via CLI: signal send.
    Escalate complex tasks by delegating via Agent.
```

**3. Start polling** (add to supervisord or crontab):

```bash
# Continuous (supervisord):
python3 /atlas/app/integrations/signal/signal-addon.py poll

# Cron (every minute):
* * * * *  python3 /atlas/app/integrations/signal/signal-addon.py poll --once
```

### CLI Usage

```bash
# Send a message
signal send +491701234567 "Hi!"

# List known contacts
signal contacts

# Show conversation history
signal history +491701234567

# Reply-pending check (used by the Stop hook): exit 0 if the last message
# from the contact is inbound (unanswered), exit 1 otherwise
signal needs-reply +491701234567

# Poll signal-cli for new messages (background)
signal poll --once
signal poll                                        # continuous

# Inject a message directly (e.g., for testing)
signal incoming +491701234567 "Hello!" --name "Alice"
```

### Signal Database

Each configured number gets its own SQLite database at `~/.index/signal/<number>.db` with WAL mode:

| Table | Purpose |
|-------|---------|
| `contacts` | Known contacts: number, name, message_count, first/last_seen |
| `messages` | All messages (in + out): body, timestamp, contact association |

### Whitelist

If `signal.whitelist` is set, only listed numbers can reach Atlas. Others are silently dropped. Empty list = accept all.

## Email Add-on

The Email Add-on provides the `email` CLI tool (wrapper for `app/integrations/email/email-addon.py`). Handles IMAP polling, SMTP sending/replying, and thread tracking. One SQLite database per account.

### Prerequisites

Python3 with `imaplib` (built-in) and `pyyaml`.

### Setup

**1. Configure** `~/config.yml`:

```yaml
email:
  imap_host: "imap.gmail.com"
  imap_port: 993
  smtp_host: "smtp.gmail.com"
  smtp_port: 587
  username: "atlas@example.com"
  password_file: "/home/agent/secrets/email-password"
  folder: "INBOX"
  whitelist: ["alice@example.com", "example.org"]   # or empty
  mark_read: true

  # Optional: pin folder names for archive/spam/delete/move. Auto-discovered
  # via IMAP SPECIAL-USE (RFC 6154) for Mailcow, Gmail, Outlook, iCloud,
  # Fastmail. Only set if your server uses non-standard names.
  # folders:
  #   archive: "Archive"
  #   junk:    "Junk"          # Gmail: "[Gmail]/Spam"
  #   trash:   "Trash"         # Outlook: "Deleted Items"
  #   sent:    "Sent"
  #   drafts:  "Drafts"
```

**2. Store password**:

```bash
echo "your-app-password" > /home/agent/secrets/email-password
chmod 600 /home/agent/secrets/email-password
```

For Gmail: use an [App Password](https://myaccount.google.com/apppasswords), not your main password.

**3. Create trigger**:

```
trigger_create:
  name: "email-handler"
  type: "webhook"
  session_mode: "persistent"
  channel: "email"
  description: "Email conversations (IMAP)"
  prompt: |
    New email received:

    {{payload}}

    The payload contains inbox_message_id and thread_id. Reply via CLI: email reply.
    Escalate complex tasks by delegating via Agent.
```

**4. Start polling**:

```bash
# Continuous (supervisord) — write to /atlas/workspace/supervisor.d/email-poller.conf:
[program:email-poller]
command=python3 -u /atlas/app/integrations/email/email-addon.py poll
autostart=true
autorestart=true
stdout_logfile=/atlas/logs/email-poller.log
stderr_logfile=/atlas/logs/email-poller-error.log
environment=PYTHONUNBUFFERED=1
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
stderr_logfile_maxbytes=1MB
stderr_logfile_backups=1

# Important: use python3 -u and PYTHONUNBUFFERED=1 to disable stdout buffering.
# Without this, Python buffers ~8KB before writing to the log file, so logs go
# missing entirely if the process is restarted before the buffer flushes.

# Cron (every 2 minutes):
*/2 * * * *  python3 -u /atlas/app/integrations/email/email-addon.py poll --once
```

### CLI Usage

**Composing**

```bash
# Send a new email (--cc / --bcc / --attach are repeatable)
email send alice@example.com "Subject" "Body"
email send alice@example.com "Subject" "Body" --cc bob@x.com --bcc audit@x.com

# Reply to a thread (reply-all by default — auto CCs the thread's CC list)
email reply <thread_id> "Reply body"
email reply <thread_id> "Reply body" --no-cc         # Reply only to sender
email reply <thread_id> "Reply body" --cc new@x.com  # Custom CC list
```

**Inbox triage** — every command accepts a single email id or a thread_id (thread_id applies to all incoming messages in the thread).

```bash
# Focused to-do list: threads with unread messages in INBOX
email inbox

# Generic listing with filters
email threads                          # All threads (any folder, any state)
email threads --folder INBOX           # Threads currently in INBOX
email threads --folder Archive         # Archived threads
email threads --unread                 # Threads with at least one unread msg
email threads --read                   # Threads where every incoming msg is read

# Read state (synced to IMAP \Seen)
email mark-read   <id|thread_id>
email mark-unread <id|thread_id>

# Folder moves (synced via IMAP UID MOVE)
email archive <id|thread_id>           # Move to Archive
email spam    <id|thread_id>           # Move to Junk/Spam
email delete  <id|thread_id>           # Move to Trash (soft delete)
email move    <id|thread_id> <folder>  # Move to a specific folder

# Discover server folders + role mapping
email folders
```

**Reading**

```bash
email thread <thread_id>          # Full thread (Markdown)
email thread <thread_id> --raw    # Raw HTML
email read <email_id>             # Single email by #N from thread view
email read <email_id> --raw       # Raw HTML
```

**Reply-pending check** (used by the Stop hook)

```bash
# Exit 0 if the newest message in the thread is inbound (unanswered), else exit 1
email needs-reply <thread_id>
```

**Polling (background)**

```bash
email poll --once   # one-shot
email poll          # continuous via IMAP IDLE (supervisord)
```

### Folders and read/unread

The addon mirrors the standard IMAP mental model: every incoming message lives in a folder (INBOX, Archive, Junk, Trash, …) and carries a read/unread flag. All triage commands sync changes to the IMAP server via `UID STORE` / `UID MOVE`, so the user's webmail stays in agreement.

Folder name discovery uses IMAP `SPECIAL-USE` (RFC 6154), which Mailcow/Dovecot, Gmail, Outlook, iCloud, and Fastmail all advertise — there's no hard-coded folder list. Use `email folders` to inspect what the connected server reports. Override individual roles via the optional `folders:` config block above when a server uses non-standard names.

The poller uses `BODY.PEEK[]` so it never auto-marks fetched messages as read; the explicit `mark_read: true` config controls whether the server-side `\Seen` flag is set after storage.

### Email Database

Each configured account gets its own SQLite database at `~/.index/email/<username>.db` with WAL mode:

| Table | Purpose |
|-------|---------|
| `threads` | Thread state: subject, last_message_id, references_chain, last_cc, participants, message_count |
| `emails` | All emails (in + out) with `imap_uid`, `folder`, `is_read`, `cc` — every column needed to sync state back to IMAP |
| `state` | Key-value state (e.g., `last_uid` for IMAP polling position) |

Legacy databases are migrated in place on first run: new columns (`imap_uid`, `is_read`, `folder`, `cc`, `last_cc`, `body_html`) are added idempotently and outgoing rows are backfilled to `folder = 'Sent'`.

### Email Thread Tracking

Thread state is tracked in the `threads` table:

```
thread_id        | subject        | last_message_id  | references_chain           | last_sender
abc123_mail.com  | Project Update | <789@mail.com>   | ["<abc@>","<def@>","<789@>"] | alice@example.com
```

**Incoming**: `poll` updates the thread and stores each email in the `emails` table.

**Outgoing**: `reply` reads the thread to construct proper headers:
- `In-Reply-To`: the `last_message_id` (what we're replying to)
- `References`: the accumulated chain (preserves thread in all mail clients)
- `Subject`: `Re: <original subject>`
- `To`: `last_sender` (the person who sent the most recent message)

After sending, `reply` appends its own `Message-ID` to the references chain so subsequent replies stay threaded.

**Thread ID derivation** from email headers:

| Header Present | Thread ID Source |
|----------------|-----------------|
| `References` | First entry (thread root Message-ID) |
| `In-Reply-To` only | That Message-ID |
| Neither | Own `Message-ID` (new thread) |

This means all emails in a thread share the same session key → same persistent trigger session → full conversational context.

### Whitelist

`email.whitelist` accepts full addresses (`alice@example.com`) or domains (`example.org`). Empty = accept all.

## Reply Flow

Trigger sessions reply directly via CLI tools — no intermediate delivery layer:

- **Signal**: `signal send "<number>" "<message>"`
  - Sends via signal-cli, tracks in signal.db
- **Email**: `email reply "<thread_id>" "<body>"`
  - Sends via SMTP with proper threading headers, tracks in email.db
- **Web/Internal**: handled within the trigger session, no CLI reply needed

## Quick Reference

### Enable Signal in 2 Steps

```bash
# 1. Install signal-cli + configure ~/config.yml (signal section)
# 2. Create trigger: "Create a persistent Signal chat trigger" + start polling
```

### Enable Email in 2 Steps

```bash
# 1. Configure ~/config.yml (email section) + store password
# 2. Create trigger: "Create a persistent email handler trigger" + start polling
```

### Direct Usage

```bash
# Signal
signal send +49170123 "Hi!"
signal contacts
signal history +49170123

# Email
email reply <thread_id> "Reply body"
email send alice@x.com "Subject" "Body"
email threads
email thread <thread_id> [--raw]
email read <email_id> [--raw]
```
