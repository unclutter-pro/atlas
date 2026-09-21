---
name: triggers
description: How to create and manage triggers via the CLI. Use for durable cron schedules, incoming webhooks, manual jobs, or messaging integration setup. Use reminders for one-shot follow-ups.
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
Escalate anything urgent by delegating via Agent.
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
REF=$(cat | jq -r '(.body // .).ref // empty')
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

### Authentication

For relay webhooks, set a secret with `trigger create --type=webhook --secret=...` and configure the sender's `X-Webhook-Secret` header. Atlas verifies it before executing the trigger. Keep the secret out of prompt files and logs.

For GitHub HMAC signatures, use the direct HTTPS endpoint `/api/webhook/<name>` behind the deployment's ingress and set the trigger secret to GitHub's webhook secret. The HTTP handler verifies `X-Hub-Signature-256` against the original request bytes. The SSE relay supplies parsed JSON, so it cannot verify that signature and rejects signed events on secret-protected triggers. Do not reconstruct a request body with `jq` for HMAC verification.

`filter.sh` is for business predicates after authentication, not for reimplementing signatures. It runs once in the trigger runner. Relay payloads have `body`, `headers`, `query`, and `timestamp`; direct HTTP JSON payloads are the body itself. For a GitHub branch filter supporting both routes, use `jq -r '(.body // .).ref // empty'`.

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

## Messaging integration setup

Read only the setup guide for the requested integration:

- [Signal](references/signal-setup.md): signal-cli registration, daemon and listener.
- [WhatsApp](references/whatsapp-setup.md): device pairing and daemon.
- [Telegram](references/telegram-setup.md): bot token and polling daemon.
- [Email](references/email-setup.md): IMAP/SMTP configuration and provisioning checks.

For ordinary email operations, use the `email` skill. For a one-shot follow-up or waiting on a reply/CI, use `reminders`; use cron triggers for durable recurring schedules.

## Crontab Structure

The crontab at `~/crontab` has two sections:

- **Static** (above `# === AUTO-GENERATED TRIGGERS`): Manual cron entries (e.g. email polling)
- **Dynamic** (below the marker): Auto-generated from enabled cron triggers

Never edit below the marker — those entries are managed by `sync-crontab.ts`. Poller entries and custom cron jobs go above it.

## Delegation Pattern

Trigger sessions act as project managers:

1. **Simple events**: Handle directly with CLI tools (`signal send`, `email reply`) or MCP actions
2. **Complex events**: Delegate to subagents via `Agent(...)`

```
# Quick task — lightweight subagent
Agent(subagent_type="general-purpose", model="haiku", prompt="Summarize the last 5 GitHub issues in repo X")

# Heavier task — sonnet subagent with full context
Agent(subagent_type="general-purpose", model="sonnet", prompt="<self-contained task description with acceptance criteria>")
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
