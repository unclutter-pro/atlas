# Atlas

**Containerized autonomous agent system powered by Claude Code.**

Atlas turns Claude Code into a persistent, event-driven agent that sleeps until needed, processes messages from multiple channels, manages its own memory, and wakes up automatically when new work arrives — no polling, no wasted compute.

## How It Works

```
External Event → Inbox (SQLite) → .wake file touched → inotifywait → Claude resumes
                                                                         ↓
                                                              Process message, write memory
                                                                         ↓
                                                              Stop Hook checks inbox
                                                                         ↓
                                                   More messages? → Continue : Sleep
```

Atlas uses an **inbox-based communication model**: all triggers (cron jobs, webhooks, web chat, internal tasks) write messages to a SQLite inbox. A filesystem watcher detects the wake signal and resumes the Claude session. After processing, a stop hook checks for more pending messages — if none, Claude sleeps until the next event.

## Quick Start

### 1. Build

```bash
git clone https://github.com/mxzinke/atlas.git
cd atlas
docker compose build
```

### 2. Authenticate

Atlas needs Claude Code credentials. Choose one:

**Option A: OAuth (recommended)**
```bash
docker run -it --rm -v $(pwd)/volume:/home/atlas atlas claude login
```

**Option B: API Key**
Uncomment `ANTHROPIC_API_KEY` in `docker-compose.yml`:
```yaml
environment:
  - ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Start

```bash
docker compose up -d
```

The Web-UI is available at **http://localhost:8080**.

### 4. Send a Message

Open the Web-UI chat at `/chat`, or POST directly:
```bash
curl -X POST http://localhost:8080/chat \
  -d "content=Hello Atlas, what can you do?"
```

Claude wakes up, processes the message, and the response appears in the inbox.

## Architecture

Atlas runs entirely in a single Docker container managed by supervisord:

| Component | Port | Purpose |
|-----------|------|---------|
| **nginx** | 8080 | Reverse proxy to web-ui |
| **web-ui** | 3000 | Hono.js + HTMX dashboard |
| **watcher** | — | inotifywait loop, resumes Claude on `.wake` |
| **supercronic** | — | Cron job runner |

See [docs/Architecture.md](docs/Architecture.md) for component overview and [docs/memory.md](docs/memory.md) for memory system.

## Triggers

Atlas supports three trigger types to wake Claude:

| Type | How It Works | Example |
|------|-------------|---------|
| **Cron** | Scheduled via supercronic | `0 9 * * 1-5` — weekdays at 9am |
| **Webhook** | HTTP endpoint receives external POST | GitHub push events, Slack commands |
| **Manual** | Button click in web-ui or MCP tool call | On-demand tasks |

Claude can create triggers itself via MCP tools:
```
"Check my GitHub repos every hour"
→ trigger_create(name: "github-check", type: "cron", schedule: "0 * * * *", prompt: "...")
```

External services send webhooks to `/api/webhook/<name>`:
```bash
curl -X POST http://localhost:8080/api/webhook/deploy-notify \
  -H "X-Webhook-Secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"repo": "myapp", "branch": "main", "status": "success"}'
```

See [docs/Triggers.md](docs/Triggers.md) for the full guide and [docs/watcher.md](docs/watcher.md) for the wake system.

## Directory Structure

```
atlas/
├── app/                          # Core application (read-only in container)
│   ├── hooks/                    # Claude Code lifecycle hooks
│   │   ├── session-start.sh      # Loads identity + memory on wake
│   │   ├── stop.sh               # Checks inbox, continues or sleeps
│   │   ├── pre-compact-auto.sh   # Memory flush before compaction
│   │   └── subagent-stop.sh      # Quality gate for team results
│   ├── atlas-mcp/                # Database module (schema, migrations)
│   ├── web-ui/                   # Hono.js + HTMX dashboard
│   ├── triggers/                 # Trigger runner scripts
│   │   ├── trigger.sh            # Generic trigger runner
│   │   ├── sync-crontab.ts       # Crontab auto-generation from DB
│   │   └── cron/                 # Cron-specific scripts
│   ├── watcher.sh                # inotifywait event loop
│   └── init.sh                   # Container bootstrap
├── docker-compose.yml
├── Dockerfile
└── supervisord.conf
```

**Workspace** (mounted as volume, persists across restarts):
```
workspace/
├── memory/                       # Long-term memory + daily journals
│   ├── MEMORY.md                 # Persistent knowledge base
│   └── YYYY-MM-DD.md             # Daily journal entries
├── inbox/                        # SQLite database + wake file
├── triggers/                     # Custom trigger prompts
├── IDENTITY.md                   # Agent personality
├── SOUL.md                       # Agent soul (core values)
├── config.yml                    # System configuration
└── user-extensions.sh            # Custom package installs
```

See [docs/directory-structure.md](docs/directory-structure.md) for complete layout.

## Configuration

### IDENTITY.md

Defines who Atlas is — personality, language, capabilities, restrictions. Edit via web-ui at `/settings` or directly in the workspace.

### config.yml

System settings for memory search, cleanup behavior, and web-ui. Claude reads this file when needed (not injected into context).

```yaml
memory:
  load_memory_md: true
  load_journal_days: 7

daily_cleanup:
  enabled: true
  max_turns: 5

web_ui:
  port: 8080
  bind: "127.0.0.1"

usage_reporting:
  enabled: true
  webhook_url: "https://app.example.org/api/usage"
  webhook_secret: "your-secret"
  include_tokens: false
```

See [docs/usage-reporting.md](docs/usage-reporting.md) for payload format and integration details.

### user-extensions.sh

Runs on every container start. Use it to install custom tools:
```bash
#!/bin/bash
apt-get install -y signal-cli
pip install some-package
```

## MCP Tools

Claude has access to these tools via the inbox-mcp server:

**Inbox:**
- `inbox_list` — List inbox messages by channel
- `inbox_write` — Create new message (triggers wake)
- `inbox_stats` — Inbox and task statistics

**Channel CLI Tools** (external communication):
- `signal send|contacts|history` — Send Signal messages, list contacts, view history
- `email reply|send|threads|thread` — Reply to email threads, send emails, list threads

**Triggers:**
- `trigger_list` — List all triggers
- `trigger_create` — Create cron/webhook/manual trigger
- `trigger_update` — Modify trigger settings
- `trigger_delete` — Remove trigger

**Memory:**
Memory is handled via specialized sub-agents (`memory-searcher`, `memory-writer`) that use grep, glob, and file reads directly — no external MCP server needed.

See [docs/memory.md](docs/memory.md) for memory system and [docs/hooks.md](docs/hooks.md) for lifecycle hooks.

## Logs

```bash
# All logs
docker compose logs -f

# Specific components
docker compose exec atlas tail -f /atlas/logs/session.log
docker compose exec atlas tail -f /atlas/logs/init.log
```

## Development

```bash
# Rebuild after code changes
docker compose build && docker compose up -d

# Access container shell
docker compose exec atlas bash

# Check service status
docker compose exec atlas supervisorctl status
```

See [docs/development.md](docs/development.md) for more development commands.

## Documentation

- [docs/Architecture.md](docs/Architecture.md) — Component overview
- [docs/hooks.md](docs/hooks.md) — Lifecycle hooks
- [docs/watcher.md](docs/watcher.md) — Event-driven wake system
- [docs/memory.md](docs/memory.md) — Memory and search
- [docs/web-ui.md](docs/web-ui.md) — Dashboard and API
- [docs/directory-structure.md](docs/directory-structure.md) — Filesystem layout
- [docs/development.md](docs/development.md) — Developer guide
- [docs/Triggers.md](docs/Triggers.md) — Triggers guide
- [docs/Integrations.md](docs/Integrations.md) — Signal and Email
- [docs/usage-reporting.md](docs/usage-reporting.md) — Usage reporting webhooks

## License

MIT
