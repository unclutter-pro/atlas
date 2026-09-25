# Directory Structure

Atlas uses three main filesystem locations with different access patterns.

## /atlas/app/ (Read-Only)

Core application code. Copied into the container image at build time. Not modified at runtime.

```
app/
├── bin/                        # CLI wrappers
│   ├── email                  # Email CLI wrapper
│   ├── reminder               # Reminder CLI wrapper
│   ├── signal                 # Signal CLI wrapper
│   ├── trigger                # Trigger management CLI wrapper
│   └── webhook-listener       # Webhook listener CLI wrapper
├── defaults/                   # Default configs seeded on first run
│   ├── config.yml             # Default configuration
│   ├── crontab                # Default cron entries
│   ├── IDENTITY.md            # Default agent identity (with placeholders)
│   ├── SOUL.md                # Default agent soul
│   ├── agents/                # Default agent specs (symlinked into .claude/agents/)
│   └── skills/                # System skills (symlinked into .claude/skills/)
├── lib/                        # Shared libraries (DB, config, auth)
│   ├── db.ts                  # Database initialization, schema, migrations
│   ├── trigger-socket.ts      # Runner control socket and lock paths, message injection
│   └── web-ui-notify.ts       # Runner → web-ui chat pings (~/.index/web-ui.sock)
├── web-ui/                     # Dashboard (compiled to a single binary)
│   ├── server.ts              # Bun.serve entrypoint
│   ├── ui-api/                # /ui/api/* JSON endpoints (core.ts, one module per area, shared/)
│   │   └── chat/              # Chat service, live hub, SSE, /api/v1 chat adapter, STT
│   ├── frontend/              # React app, bundled by Bun (areas.ts, shell/, components/, pages/<area>/)
│   ├── dev/seed.ts            # Seeds an isolated HOME with fixture data for local development
│   └── index.ts               # Hono app: /api/v1, /api/webhook, /healthz
├── triggers/                   # Trigger runner scripts
│   ├── trigger.sh             # Thin wrapper: delegates to trigger-runner binary
│   ├── trigger-runner.ts      # Trigger runner (compiled to native binary at build time)
│   ├── manage.ts              # Trigger management CLI
│   ├── sync-crontab.ts        # Crontab auto-generation from DB
│   ├── sessions.ts            # `sessions` CLI: extraction and retention via the session store
│   ├── harness/               # Agent backends (docs/harness-interface.md)
│   │   ├── configure.ts       # Writes the configured backend's settings (init.sh, web-ui)
│   │   └── claude/            # Claude Code adapter
│   │       ├── hooks/         # Claude Code lifecycle hooks (docs/hooks.md)
│   │       ├── settings.ts    # ~/.claude/settings.json, skill and agent directories
│   │       └── prompt.md      # Claude-specific system prompt section
│   └── cron/                  # Cron-specific scripts
├── prompts/                    # Prompt templates
│   ├── trigger-system-prompt.md           # Core trigger session system prompt
│   ├── trigger-inject.md                  # Generic IPC injection template (fallback)
│   ├── trigger-channel-*.md               # Channel-specific system prompt additions
│   ├── trigger-channel-*-inject.md        # Channel-specific IPC injection templates
│   ├── trigger-channel-*-farewell.md      # Channel-specific session-end prompts
│   └── trigger-pre-compact.md             # Pre-compaction memory flush prompt
├── nginx.conf                  # nginx reverse proxy config
├── entrypoint.sh               # Container entrypoint (permission fix + supervisord)
└── init.sh                     # Container startup script
```

## /home/agent/ (Read-Write)

Persistent home directory. Mounted as a Docker volume (`./home:/home/agent`). Contains all user data.

```
home/
├── .claude/                    # Claude Code configuration
│   ├── settings.json          # Hooks config (written by the Claude adapter's configure())
│   ├── skills/                # Merged skill directory (per-skill symlinks)
│   │   └── <skill-name> →     # Symlinks to system or user skills
│   └── agents/                # Merged agent directory (per-agent symlinks)
│       └── <agent-name>.md →  # Symlinks to system or user agent specs
├── .atlas-mcp/                 # User MCP config (loaded by trigger sessions)
│   └── user.json              # User MCP servers (Playwright, custom tools)
├── .index/                     # System state
│   ├── atlas.db               # SQLite database (WAL mode)
│   ├── .trigger-<name>.flock  # Per-trigger flock file (concurrency control)
│   └── signal/, email/        # Channel-specific databases
├── memory/                     # Long-term memory (agent-organized; see docs/memory.md)
│   ├── MEMORY.md              # Index — map of what exists and where
│   ├── journal/               # Daily journal entries (fixed layout)
│   │   └── YYYY-MM-DD.md
│   ├── entities/              # Services, platforms, people, companies
│   ├── decisions/             # Key decisions with rationale
│   ├── workflows/             # Learned procedures and playbooks
│   ├── projects/              # Project-specific notes
│   ├── responsibilities/      # Recurring ownership themes
│   └── notes/                 # Free-form; folders below MEMORY.md are conventions,
│                              # and the agent may add or reshape them
├── projects/                   # Working directories
├── triggers/                   # Custom trigger prompts
│   └── <trigger-name>/
│       ├── prompt.md          # Prompt fallback if DB prompt is empty
│       └── .prompt.shipped.md # Last shipped default (upgrade tracking; dreaming)
├── mcps/                       # User-installed MCP servers
├── secrets/                    # API keys, credentials (denylist)
├── bin/                        # User scripts
├── supervisor.d/               # Supervisord config overrides
├── IDENTITY.md                 # Agent personality
├── SOUL.md                     # Agent soul (core values)
├── config.yml                  # System configuration
├── crontab                     # Generated crontab (managed by sync-crontab.ts)
└── user-extensions.sh          # Custom package installs (runs on container start)
```

## Key Files Reference

| Path | Description |
|------|-------------|
| `app/triggers/trigger-runner` | Native binary: trigger session launcher (injects system prompt, model, MCP) |
| `app/triggers/trigger.sh` | Thin shell wrapper: delegates to trigger-runner binary |
| `app/triggers/harness/claude/hooks/session-start.sh` | Loads memory context on session start |
| `app/triggers/harness/claude/hooks/stop.sh` | Task gate, validator gate, journal reminder |
| `app/lib/atlas-db.ts` | Database initialization, schema, migrations |
| `app/web-ui/server.ts` | Dashboard server entrypoint (Bun.serve + React) |
| `app/web-ui/index.ts` | Hono routes: `/api/v1`, webhook receiver, `/healthz` |
| `app/defaults/agents/` | System agent specs (developer, reviewer, etc.) |
| `app/defaults/skills/` | System skills (symlinked into `.claude/skills/`) |
| `/home/agent/.index/atlas.db` | SQLite database (messages, triggers, sessions) |
| `/home/agent/memory/MEMORY.md` | Long-term memory storage |
| `/home/agent/IDENTITY.md` | Agent identity/personality |
| `/home/agent/config.yml` | Runtime configuration |
