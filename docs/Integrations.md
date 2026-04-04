# Integrations

Atlas supports Signal and Email as communication channels. Each integration writes incoming messages to the inbox, then spawns a trigger session (persistent, keyed per contact/thread) that can reply directly or delegate complex tasks to agent teammates.

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
                            signal-cli send         Agent teammate


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
                            SMTP with threading     Agent teammate
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
    Escalate complex tasks by delegating to an Agent teammate.
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
    Escalate complex tasks by delegating to an Agent teammate.
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

```bash
# Reply to an existing thread (uses proper In-Reply-To + References headers)
email reply <thread_id> "Reply body"

# Send a new email
email send alice@example.com "Subject line" "Body text"

# List tracked threads
email threads

# Show thread detail (participants, message history)
email thread <thread_id>
email thread <thread_id> --raw    # Output raw HTML instead of Markdown

# Read a single email by ID
email read <email_id>
email read <email_id> --raw       # Output raw HTML instead of Markdown

# Poll IMAP for new emails (background)
email poll --once
email poll                       # continuous mode
```

### Email Database

Each configured account gets its own SQLite database at `~/.index/email/<username>.db` with WAL mode:

| Table | Purpose |
|-------|---------|
| `threads` | Thread state: subject, last_message_id, references_chain, participants, message_count |
| `emails` | All emails (in + out): sender, recipient, subject, body, thread association |
| `state` | Key-value state (e.g., `last_uid` for IMAP polling position) |

Legacy JSON thread files (`email-threads/*.json`) and UID state are automatically migrated on first run.

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
