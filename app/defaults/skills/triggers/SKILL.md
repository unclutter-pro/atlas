---
name: triggers
description: How to create and manage triggers via the CLI. Covers cron, webhook, manual, Signal, WhatsApp and Email integration.
---

# Triggers

Triggers are autonomous agent sessions that fire on events — scheduled (cron), HTTP (webhook), or on-demand (manual). Each trigger runs its own Claude session that can handle the event directly or escalate to the main session.

## Trigger Types

### Cron
Scheduled execution using standard cron syntax.

| Schedule | Meaning |
|----------|---------|
| `*/15 * * * *` | Every 15 minutes |
| `0 * * * *` | Every hour |
| `0 9 * * 1-5` | Weekdays at 9:00 |
| `0 6 * * *` | Daily at 6:00 |

### Webhook
Webhooks connect external services to the agent via a self-hosted relay (smee.io). No ports need to be opened — the agent connects outbound via SSE.

**How it works:**
1. `trigger create --type=webhook` generates a unique channel and returns the relay URL
2. Register that URL with your external service (GitHub, Stripe, etc.)
3. The webhook SSE listener connects outbound and fires triggers when events arrive

- Payload replaces `{{payload}}` in the prompt file
- Optional authentication via `X-Webhook-Secret` header or middleware filter
- Relay URL configurable in `config.yml` (default: `webhooks.unclutter.pro`)

### Manual
No schedule, no endpoint. Fired via the web-ui "Run" button or by request.

## Session Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| `ephemeral` | New session per run | Cron jobs, one-off webhooks |
| `persistent` | Resume by session key | Signal/WhatsApp contacts, email threads |

Persistent triggers maintain separate sessions per key (e.g., per contact, per thread). If no key is provided, a single default session is used per trigger.

## CLI Commands

| Command | Use |
|---------|-----|
| `trigger create ...` | Create trigger |
| `trigger update ...` | Update trigger fields |
| `trigger delete --name=foo` | Delete trigger |
| `trigger enable --name=foo` | Enable trigger |
| `trigger disable --name=foo` | Disable trigger |
| `trigger list` | List all triggers |

## Creating Triggers

### Cron Trigger

```bash
trigger create \
  --name=daily-report \
  --type=cron \
  --schedule="0 9 * * *" \
  --description="Daily morning report" \
  --channel=internal
```

Then create the prompt file at `~/triggers/daily-report/prompt.md`.

After creation, the crontab is synced automatically — supercronic picks it up. **Nothing else needed.**

### Webhook Trigger

```bash
trigger create \
  --name=deploy-hook \
  --type=webhook \
  --secret=my-secret-token \
  --description="Post-deploy notification"
```

Output:
```
Created trigger 'deploy-hook' (webhook)
Webhook URL: https://webhooks.unclutter.pro/deploy-hook-a1b2c3d4e5f6
Channel ID: deploy-hook-a1b2c3d4e5f6
Register this URL with your webhook provider
```

Prompt file: `~/triggers/deploy-hook/prompt.md`
Use `{{payload}}` in prompt for the webhook body.

The SSE listener picks up new webhook triggers automatically (within 60s). The relay URL is returned by the CLI — register it with your external service.

### Manual Trigger

```bash
trigger create \
  --name=weekly-report \
  --type=manual \
  --description="Generate weekly summary"
```

Fired via the web-ui dashboard "Run" button.

## Prompt Files

Each trigger's prompt lives at:
```
~/triggers/<name>/prompt.md
```

The `trigger create` command creates the directory automatically. Write the full trigger instruction in this file. If the `prompt` field in DB is empty (default after CLI create), this file is used automatically.

Example `~/triggers/daily-report/prompt.md`:
```
Check the inbox for any unread messages and summarize activity from the past 24 hours.
Escalate anything urgent by delegating to an Agent teammate.
```

## Middleware Filter Scripts

Any trigger can have an optional filter script that decides whether to fire. Place a `filter.sh` in the trigger directory:

```
~/triggers/<name>/filter.sh
```

The filter receives the event payload as JSON on stdin. Exit 0 = fire, non-zero = skip.

**Works for ALL trigger types** — webhooks, cron, manual.

### Examples

**Only fire on GitHub push to main:**
```bash
#!/bin/bash
# ~/triggers/github-deploy/filter.sh
REF=$(cat | jq -r '.body.ref // empty')
[ "$REF" = "refs/heads/main" ] && exit 0
exit 1
```

**Only fire on weekdays:**
```bash
#!/bin/bash
# ~/triggers/daily-report/filter.sh
DOW=$(date +%u)  # 1=Monday, 7=Sunday
[ "$DOW" -le 5 ] && exit 0
exit 1
```

**Validate webhook signature (e.g. GitHub):**
```bash
#!/bin/bash
# ~/triggers/github-hook/filter.sh
INPUT=$(cat)
SIG=$(echo "$INPUT" | jq -r '.headers["x-hub-signature-256"] // empty')
BODY=$(echo "$INPUT" | jq -r '.body | tostring')
SECRET="your-webhook-secret"
EXPECTED="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)"
[ "$SIG" = "$EXPECTED" ] && exit 0
exit 1
```

## Webhook Relay Configuration

Configure the relay base URL in `~/config.yml`:

```yaml
webhook:
  relay_url: "https://webhooks.unclutter.pro"
```

Default: `webhooks.unclutter.pro` (community-hosted instance).

### Starting the Webhook Listener

Add to `~/supervisor.d/webhook-listener.conf`:
```ini
[program:webhook-listener]
command=/atlas/app/bin/webhook-listener
autostart=true
autorestart=true
stdout_logfile=/atlas/logs/webhook-sse.log
stderr_logfile=/atlas/logs/webhook-sse-error.log
```

Then: `supervisorctl reread && supervisorctl update`

The listener auto-discovers webhook triggers from the DB and reconnects on failure. It reconciles every 60 seconds to pick up new/removed/disabled triggers.

## Adding Custom Background Services

Some integrations need a persistent background process instead of a cron job — for example, a messaging listener that reacts instantly rather than polling every minute.

The agent supports this via `~/supervisor.d/`. Any `.conf` file placed there is picked up by supervisord. Services can be added or removed without rebuilding the container.

**Add a service** — create `~/supervisor.d/myservice.conf`:
```ini
[program:myservice]
command=/path/to/command --args
autostart=true
autorestart=true
stdout_logfile=/atlas/logs/myservice.log
stderr_logfile=/atlas/logs/myservice-error.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
stderr_logfile_maxbytes=1MB
stderr_logfile_backups=1
```

**Python processes** — avoid stdout buffering by wrapping in a shell script that sets `PYTHONUNBUFFERED=1` and uses `python3 -u`. Without this, Python buffers ~8KB before writing to disk; if the process restarts before the buffer flushes, all recent logs are silently lost. The built-in `email` and `signal` bin wrappers already handle this.

Then reload:
```bash
supervisorctl reread && supervisorctl update
```

Manage it normally after that:
```bash
supervisorctl start myservice
supervisorctl stop myservice
supervisorctl status myservice
```

---

## Signal Integration Setup

Signal uses `signal-cli` in **daemon mode** — a persistent process that pushes messages in real-time via a UNIX socket. This is lower-latency and more reliable than cron polling.

**Install signal-cli** (add to `workspace/user-extensions.sh` so it survives rebuilds):
```bash
SIGNAL_VERSION="0.13.10"  # check https://github.com/AsamK/signal-cli/releases for latest
ARCH=$(dpkg --print-architecture)
curl -fsSL "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_VERSION}/signal-cli-${SIGNAL_VERSION}-Linux-${ARCH}.tar.gz" \
  | tar -xz -C /usr/local
ln -sf /usr/local/signal-cli-${SIGNAL_VERSION}/bin/signal-cli /usr/local/bin/signal-cli
```

**One-time registration** (run once manually inside the container, not in user-extensions.sh):
```bash
signal-cli -a +491701234567 register
# If a captcha is required:
#   1. Visit https://signalcaptchas.org/registration/generate and complete it
#   2. Copy the URL (format: signalcaptcha://<token>)
#   3. Re-run: signal-cli -a +491701234567 register --captcha <token>
signal-cli -a +491701234567 verify 123-456  # code from SMS
```

**Step 1: Configure `workspace/config.yml`**

```yaml
signal:
  number: "+491701234567"
  whitelist: []   # empty = accept all contacts
```

**Step 2: Create the trigger**

```bash
trigger create \
  --name=signal-chat \
  --type=webhook \
  --session-mode=persistent \
  --channel=signal \
  --description="Signal messenger conversations"
```

Write `~/triggers/signal-chat/prompt.md`:
```
<message from="{{sender}}">
{{payload}}
</message>

Please respond directly using `signal send "{{sender}}" "..."`.
```

**Step 3: Add supervisor services**

Create `~/supervisor.d/signal.conf` (replace number with your own):
```ini
[program:signal-daemon]
command=signal-cli -a +491701234567 daemon --socket /tmp/signal.sock
autostart=true
autorestart=true
stdout_logfile=/atlas/logs/signal-daemon.log
stderr_logfile=/atlas/logs/signal-daemon-error.log

[program:signal-listen]
command=/atlas/app/bin/signal listen
autostart=true
autorestart=true
stdout_logfile=/atlas/logs/signal-listen.log
stderr_logfile=/atlas/logs/signal-listen-error.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
stderr_logfile_maxbytes=1MB
stderr_logfile_backups=1
```

Activate:
```bash
supervisorctl reread && supervisorctl update
```

The listener connects to the socket and calls `signal incoming` for each message, which stores it in the inbox and fires the trigger. Each sender gets their own persistent session automatically.

**CLI tools available in trigger sessions:**

```bash
signal send +491701234567 "Hello!"
signal contacts
signal history +491701234567
```

## WhatsApp Integration Setup

WhatsApp uses [Baileys](https://github.com/WhiskeySockets/Baileys) — an unofficial WhatsApp Web API that connects via WebSocket. A single daemon process handles both incoming messages and outgoing sends.

> **Warning:** Baileys is unofficial. WhatsApp can ban accounts using third-party clients. Use a **dedicated phone number**, not your main one. Avoid bulk messaging.

**Step 1: Configure `workspace/config.yml`** (optional)

```yaml
whatsapp:
  whitelist: []   # empty = accept all; or ["+491701234567", "+491709876543"]
  history_turns: 20
```

No phone number config needed — Baileys derives it from the linked device session.

**Step 2: Create the trigger**

The `whatsapp-chat` trigger is auto-created by `init.sh`. If it's missing:

```bash
trigger create \
  --name=whatsapp-chat \
  --type=webhook \
  --session-mode=persistent \
  --channel=whatsapp \
  --description="WhatsApp messenger conversations"
```

Write `~/triggers/whatsapp-chat/prompt.md`:
```
<message from="{{sender}}">
{{payload}}
</message>

Please respond directly using `whatsapp send "{{sender}}" "..."`.
```

**Step 3: Add supervisor service**

Create `~/supervisor.d/whatsapp.conf`:
```ini
[program:whatsapp-daemon]
command=bun run /atlas/app/integrations/whatsapp/whatsapp-daemon.ts
autostart=true
autorestart=true
stdout_logfile=/atlas/logs/whatsapp-daemon.log
stderr_logfile=/atlas/logs/whatsapp-daemon-error.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
stderr_logfile_maxbytes=1MB
stderr_logfile_backups=1
```

Activate:
```bash
supervisorctl reread && supervisorctl update
```

**Step 4: Pair via QR code**

On first start, the daemon generates a QR code and saves it as an image:

```bash
# Check status and get QR code path
whatsapp status
# → Status: waiting_for_scan
# → QR Code: ~/.local/share/whatsapp/qr-code.png
```

**Send the QR code image directly to the user** via their current channel (Signal, email, dashboard). Tell them:
"Öffne WhatsApp → Einstellungen → Verknüpfte Geräte → Gerät hinzufügen, und scanne den QR-Code."

The QR code expires after ~60 seconds — the daemon auto-generates a new one if it times out.

Auth credentials persist to `~/.local/share/whatsapp/auth/` — subsequent restarts reconnect automatically. If the linked device is revoked (phone offline 14+ days), delete the auth directory and re-scan.

**Architecture:**

Unlike Signal (which needs two processes — signal-cli daemon + listener), WhatsApp uses a **single daemon** (`whatsapp-daemon.ts`) that:

1. Connects to WhatsApp via Baileys WebSocket
2. Listens for incoming messages → spawns `whatsapp incoming` per message
3. Exposes a UNIX socket (`/tmp/whatsapp.sock`) for outgoing sends (JSON-RPC, same protocol as signal-cli)

Voice messages are automatically downloaded and transcribed via the same STT pipeline as Signal. Outgoing messages are rate-limited (1.5s between sends) to reduce ban risk.

**CLI tools available in trigger sessions:**

```bash
whatsapp send "+491701234567" "Hello!"
whatsapp send "+491701234567" "See attached" --attach /path/to/file.pdf
whatsapp contacts
whatsapp history "+491701234567"
```

**Data storage:**

| Item | Location |
|------|----------|
| Auth credentials | `~/.local/share/whatsapp/auth/` |
| Downloaded attachments | `~/.local/share/whatsapp/attachments/` |
| Contact/message DB | `~/.index/whatsapp/whatsapp.db` |
| Daemon logs | `/atlas/logs/whatsapp-daemon.log` |
| Send socket | `/tmp/whatsapp.sock` |

## Telegram Integration Setup

Telegram uses a **Bot API** approach — simpler than Signal/WhatsApp but NOT end-to-end encrypted.

**Step 1: Create a bot via BotFather**

Guide the user through this (or do it for them if they share the token):
1. Open Telegram → search @BotFather → send `/newbot`
2. Choose a name and username (must end with "bot")
3. Copy the token — share it via a **secure channel** (NOT Telegram itself)

**Step 2: Configure `~/config.yml`**

```yaml
telegram:
  bot_token: "123456:ABC-DEF..."
```

**Step 3: Create the trigger**

```bash
trigger create \
  --name=telegram-chat \
  --type=manual \
  --session-mode=persistent \
  --channel=telegram \
  --enabled
```

Write `~/triggers/telegram-chat/prompt.md`:
```markdown
{{payload}}

Please respond directly using `telegram send "{{sender}}" "..."`.
```

**Step 4: Add supervisor service**

Create `~/supervisor.d/telegram.conf`:
```ini
[program:telegram-daemon]
command=python3 -u /atlas/app/integrations/telegram/telegram-daemon.py
autostart=true
autorestart=true
stdout_logfile=/atlas/logs/telegram-daemon.log
stderr_logfile=/atlas/logs/telegram-daemon-error.log
stdout_logfile_maxbytes=10MB
stderr_logfile_maxbytes=1MB
```

Then: `supervisorctl reread && supervisorctl update`

**Security note:** Telegram bots are NOT end-to-end encrypted. Never share passwords, API keys, or sensitive data via Telegram. Recommend Signal or Dashboard chat for sensitive information.

**CLI tools:**

```bash
telegram send "<chat_id>" "Hello!"
telegram send "<chat_id>" "See attached" --attach /path/to/file.pdf
telegram contacts
telegram history "<chat_id>"
telegram status
telegram setup   # Print setup instructions
```

**Data storage:**

| Item | Location |
|------|----------|
| Contact/message DB | `~/.index/telegram/telegram.db` |
| Downloaded attachments | `~/.local/share/telegram/attachments/` |
| Daemon logs | `/atlas/logs/telegram-daemon.log` |

## Email Integration Setup

**Step 1: Configure `workspace/config.yml`**

```yaml
email:
  imap_host: "imap.gmail.com"
  imap_port: 993
  smtp_host: "smtp.gmail.com"
  smtp_port: 587
  username: "atlas@example.com"
  password_file: "/home/atlas/secrets/email-password"
  folder: "INBOX"
  whitelist: []   # empty = accept all; or ["alice@example.com", "example.org"]
  mark_read: true
```

**Step 2: Store password**

```bash
echo "your-app-password" > /home/atlas/secrets/email-password
chmod 600 /home/atlas/secrets/email-password
```

For Gmail: use an App Password, not your main password.

**Step 3: Create the trigger**

```bash
trigger create \
  --name=email-handler \
  --type=webhook \
  --session-mode=persistent \
  --channel=email \
  --description="Email conversations (IMAP)"
```

Then write `~/triggers/email-handler/prompt.md`:
```
New email received:

{{payload}}

The payload contains inbox_message_id and thread_id.
Reply directly via CLI: email reply <thread_id> "message"
Escalate complex tasks by delegating to an Agent teammate.
```

**Step 4: Add polling**

Option A — supervisord (recommended):

Create `~/supervisor.d/email-poller.conf`:
```ini
[program:email-poller]
command=/atlas/app/bin/email poll
autostart=true
autorestart=true
stdout_logfile=/atlas/logs/email-poller.log
stderr_logfile=/atlas/logs/email-poller-error.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
stderr_logfile_maxbytes=1MB
stderr_logfile_backups=1
```

Then: `supervisorctl reread && supervisorctl update`

Option B — crontab:

Edit `~/crontab` and add **above** the marker:
```
*/2 * * * *  email poll --once
```

Thread tracking uses `In-Reply-To`/`References` headers — replies in the same thread share one persistent session.

**CLI tools available in trigger sessions:**

```bash
email reply <thread_id> "Reply body"
email send recipient@example.com "Subject" "Body text"
email threads
email thread <thread_id>
```

## Crontab Structure

The crontab at `~/crontab` has two sections:

- **Static** (above `# === AUTO-GENERATED TRIGGERS`): Manual cron entries (e.g. email polling)
- **Dynamic** (below the marker): Auto-generated from enabled cron triggers

Never edit below the marker — those entries are managed by `sync-crontab.ts`. Poller entries and custom cron jobs go above it.

## Delegation Pattern

Trigger sessions act as project managers:

1. **Simple events**: Handle directly with CLI tools (`signal send`, `email reply`) or MCP actions
2. **Complex events**: Delegate to agent teammates via `Agent(...)` or `TeamCreate` + `Agent(...)`

```
# Quick task — single agent
Agent(subagent_type="general-purpose", model="sonnet", prompt="Review critical issue #42 from GitHub")

# Complex multi-step work — agent team
TeamCreate(team_name="deploy-review")
Agent(team_name="deploy-review", name="developer", model="sonnet", prompt="...")
TeamDelete()
```

See the trigger session's system prompt for the full delegation guidelines.

## Managing Triggers

```bash
# List all triggers
trigger list

# List only cron triggers
trigger list --type=cron

# Disable a trigger
trigger disable --name=github-issues

# Enable a trigger
trigger enable --name=github-issues

# Change schedule
trigger update --name=daily-report --schedule="0 8 * * *"

# Delete a trigger
trigger delete --name=old-hook
```
