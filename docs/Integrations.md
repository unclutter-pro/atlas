# Integrations

Atlas supports Signal, Email and Nextcloud Talk as communication channels. Each integration writes incoming messages to the inbox, then spawns a trigger session (persistent, keyed per contact/thread) that can reply directly or delegate complex tasks to subagents via `Agent(...)`.

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

When a message arrives while a trigger session is already running for the same contact/thread, the new trigger-runner hands it to the runner that owns the session over that runner's control socket:

```
Runner active for (trigger, key)
  → control socket at /tmp/.trigger-<name>-<key>.sock (see docs/watcher.md)
  → new runner sends: {"message":"<message>","channel":"signal","sessionKey":"<key>"}
  → Message is queued in the session, processed after current turn
  → No new process, no restart
```

If no runner answers (session not running), the new runner takes the lock and resumes the session itself.

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

## Nextcloud Talk Add-on

The Talk Add-on provides the `talk` CLI tool (wrapper for `app/integrations/talk/talk-addon.py`). Atlas joins Nextcloud Talk as a **webhook bot**: people write to it in conversations like to a colleague, and it answers in the same conversation or thread. It needs no Nextcloud user account (an optional one makes one-to-one chats possible, see `agent_user`); the bot only sees the conversations an admin enabled it in.

### Flow

```
Nextcloud Talk ──POST /api/integrations/talk/webhook──▸ web UI (talk-webhook.ts)
  X-Nextcloud-Talk-Random + -Signature                   ├─ HMAC-SHA256(secret, random + raw body), constant time
                                                         ├─ replay check (random seen before → 409)
                                                         └─ 200 at once, body → talk incoming --stdin
                                                                 │
                                         talk incoming ◂─────────┘
                                           ├─ room allowlist, store message in talk.db
                                           ├─ bots' messages and all reactions (incl. the bot's own 👀) ignored
                                           ├─ user allowlist, addressed? (mention, reply to the bot,
                                           │   one-to-one with agent_user, followed thread)
                                           ├─ INSERT atlas inbox (channel=talk), 👀 reaction on the message
                                           └─ trigger.sh talk-chat <xml-payload> talk/<room>/<thread-id|main>
                                                                 │
                                                       Trigger session (persistent, one per thread)
                                                                 │
                                           talk send "..." ──POST /ocs/v2.php/apps/spreed/api/v1/bot/<room>/message
                                                              (threadId from the session key, 👀 removed)
```

The webhook runs inside the existing web UI process; there is no daemon to supervise. Talk delivers webhooks synchronously inside the request of whoever wrote the message (a user's post, or the bot's own `POST /bot/.../message`), waits at most 5 seconds and never retries. The handler therefore answers before any work starts (about 2 ms), and `talk incoming` runs as its own process without taking locks a running `talk send` holds.

### Setup

Step by step (secret, `occ talk:bot:install`, `occ talk:bot:setup`, trigger, network): [app/defaults/skills/triggers/references/talk-setup.md](../app/defaults/skills/triggers/references/talk-setup.md). In short:

```bash
openssl rand -hex 32 > ~/secrets/talk-bot-secret && chmod 600 ~/secrets/talk-bot-secret

# Nextcloud admin:
occ talk:bot:install --no-setup -f webhook -f response -f reaction \
  "Claudius" "<SECRET>" "https://<atlas-host>/api/integrations/talk/webhook" "Atlas agent"
occ talk:bot:setup <bot-id> <room-token>

# Atlas:
trigger create --name=talk-chat --type=manual --session-mode=persistent --channel=talk
```

Network: Nextcloud must reach the web UI's `POST /api/integrations/talk/webhook` (expose only that path), and Atlas needs outbound HTTPS to `talk.url`.

### Configuration

```yaml
talk:
  url: "https://cloud.example.com"
  bot_name: "Claudius"
  rooms:
    "abc123xy": { mode: mention }
    "k9w2p4zz": { mode: all }
  whitelist: ["alice", "users/bob"]
```

| Key | Default | Meaning |
|-----|---------|---------|
| `url` | (required) | Nextcloud base URL. Env override `TALK_URL`. |
| `secret_file` | `~/secrets/talk-bot-secret` | File with the bot secret. `TALK_BOT_SECRET` env wins. The secret never belongs in `config.yml`. |
| `bot_name` | `agent.name` | Name people `@mention`. Should match the name given to `talk:bot:install`. |
| `agent_user` | `""` | Optional Nextcloud user id of the agent (e.g. `claudius`). One-to-one conversations with this user count as direct chats, and `@"claudius"` mentions (which Talk turns into real mentions) address the bot. |
| `mention_aliases` | `[]` | Further names that count as a mention. |
| `rooms` | `[]` | Allowed room tokens. Empty = every room the bot is enabled in. As a mapping, `mode` per room: `mention` (only addressed messages), `all` (every message), `auto` (one-to-one with `agent_user` = all, otherwise mention). |
| `whitelist` | `[]` | Users who can start sessions: `alice` / `users/alice`, other actor types in full (`federated_users/…`, `guests/…`). Empty = all Nextcloud users, no guests or federated users. `"*"` = everyone. |
| `follow_threads` | `true` | In threads the bot is part of (it was mentioned there or started the thread), follow-ups reach it without a mention. |
| `processing_reaction` | `👀` | Reaction added to a message when a session takes it, removed when the session replies. `""` turns it off. |
| `context_messages` | `10` | Unseen earlier messages of the same conversation/thread passed along with a mention, so "@Claudius what do you think?" has context. |
| `max_message_length` | `4000` | Longer replies are split at line breaks, code blocks stay balanced. Talk's hard limit is 32000 characters (not bytes); above that it answers `413`. |
| `verify_tls` | `true` | TLS verification for calls to Nextcloud. |

### Routing

| Where | Addressed when | Session key |
|-------|----------------|-------------|
| Group conversation, main chat | `@Claudius …`, or a reply quoting the bot | `talk/<room>/main` |
| Thread in a group conversation | `@Claudius …`, a reply to the bot, or any follow-up once the bot is part of the thread | `talk/<room>/<thread-id>` |
| One-to-one conversation with `agent_user` (or `mode: all`) | every message | `talk/<room>/main` or `talk/<room>/<thread-id>` |

Bots are not participants in Talk and can't be mentioned as an entity (they're not in the autocomplete; `@Claudius`, `@"bot-<hash>"` stay plain text), so the add-on matches `@<bot_name>` and aliases as text, case-insensitively (also `@"Claudius"`). Mentions of people arrive as placeholders (`{mention-user1}`) with parameters; the add-on renders them back for the session as `@Bob (bob)` (name, then the id to mention with `@"bob"`) and `@all`. A mention of `agent_user` arrives as such a parameter and addresses the bot.

One-to-one conversations: the webhook has no room type, but Talk sends the name of a one-to-one room as the JSON list of both user ids (`["alice","bob"]`, verified on Talk 25). A bot can't be the other side of a one-to-one conversation, so such a room is always two people; it only counts as a direct chat when one of them is `agent_user`. Otherwise the bot stays quiet unless mentioned. For a personal channel without an agent account, enable the bot in a "Note to self" conversation and set it to `mode: all` under `rooms`. `/new` (after the mention in group rooms) retires the session of that conversation or thread like Signal's `/new`.

Messages that don't address the bot are still stored in `talk.db`: the bot API cannot read history from the server, so this is what `talk history` and the `<context>` block draw on.

### Threads

`talk send --new-thread "<title>" "<text>"` creates a thread. Talk answers the bot API with `201` and `"data": null` (no message id, no thread id), so the thread id is learned from the `thread_created` system message: its id is in `parameters.title.id` as `thread/<id>` and the title in `parameters.title.name` (no `object.threadId`, no `referenceId`). Talk sends this webhook before the bot's `POST` returns. The add-on therefore records a pending thread before sending, matches the system message by room, title and bot actor, and prints the id (in practice it is there when the `POST` returns; the add-on waits up to 15 seconds). Messages in that thread then go to their own session (`talk/<room>/<thread-id>`), with `thread-origin` naming the session that started it.

### CLI Usage

```bash
talk send "Text"                               # trigger session: this conversation/thread
talk send --reply-to 4720 "Text"               # quote a message
talk send --new-thread "Deploy 4.2" "Text"     # start a thread
talk send --thread 4711 "Text" | --main | --room <token>
talk send --silent "Text"                      # no notifications
cat report.md | talk send -                    # long Markdown from stdin
talk react 4720 "👍" [--remove]
talk history [--room <token>] [--thread <id>] [--limit 20]
talk rooms                                     # conversations seen, their mode and allowlist state
talk threads [--room <token>]
talk status                                    # config check + features Nextcloud reports for the bot
talk setup                                     # setup instructions
```

`talk send` refuses messages that contain credentials (private keys, common token formats, the bot secret, or the value of any `*TOKEN*`/`*SECRET*`/`*PASSWORD*` environment variable) and allows at most 20 messages per minute and room.

### Talk Database

`~/.index/talk/talk.db` (WAL mode):

| Table | Purpose |
|-------|---------|
| `rooms` | Conversations seen: name, one-to-one flag, bot actor id and name (from the `Join` webhook) |
| `threads` | Known threads: title, started by the bot, origin session, followed |
| `pending_threads` | Threads the bot asked for, until `thread_created` reports their id |
| `messages` | Inbound (every message of allowed rooms) and outbound messages, delivery and processing-reaction state |

### Security

- Every webhook is checked against the HMAC before anything else; invalid signatures get `401`, a reused random value `409`. Message ids are deduplicated in `talk.db` as a second line.
- The other direction has a lockout: about 10 requests with a wrong signature from one IP within 12 hours make Nextcloud's brute-force protection answer `500` once and then `429`, also for correctly signed requests. `talk` stops after the first `401` instead of retrying. After fixing the secret, a Nextcloud admin lifts the lockout with `occ security:bruteforce:reset <atlas-ip>`.
- Talk sends the bot webhooks for its own reactions (and those of other bots) as `Like`/`Undo` plus a `reaction_revoked` system message; all reactions are ignored. Bots' own messages never come back as `Create`.
- `message_edited` and `message_deleted` system messages don't say which message changed, so edits and deletions don't reach the session.
- Lost webhooks (timeout, Atlas down) are not retried and not visible in `talk:bot:list` (`error_count` stays 0).
- Only allowed rooms and users start sessions. Guests and federated users need an explicit `whitelist` entry.
- The payload escapes all chat text. The channel prompt tells the session that `<context>`, `<quoted>` and file names are data, not instructions, and that destructive actions need an explicit request from the sender.
- Talk is not end-to-end encrypted. Install the bot with `--no-setup` so only admins decide where it reads along.
- Limits of the bot API: no file upload or download, no reading of server-side history, no typing indicator.

## Reply Flow

Trigger sessions reply directly via CLI tools — no intermediate delivery layer:

- **Signal**: `signal send "<number>" "<message>"`
  - Sends via signal-cli, tracks in signal.db
- **Email**: `email reply "<thread_id>" "<body>"`
  - Sends via SMTP with proper threading headers, tracks in email.db
- **Nextcloud Talk**: `talk send "<markdown>"`
  - Posts through the signed bot API into the session's conversation/thread, tracks in talk.db
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

### Enable Nextcloud Talk in 3 Steps

```bash
# 1. Secret in ~/secrets/talk-bot-secret + talk.url in ~/config.yml
# 2. Nextcloud admin: occ talk:bot:install … && occ talk:bot:setup <bot-id> <room-token>
# 3. Create trigger: "Create a persistent Talk chat trigger" (talk-chat, channel talk)
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

# Nextcloud Talk
talk send --room <token> "Hi!"
talk rooms
talk history --room <token>
```
