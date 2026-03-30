# Atlas

Containerized autonomous agent system powered by Claude Code. Made to enable communication from other tools and optimized heavily for long horizon projects and complicated tasks.

## Goals

- **Event-driven**: No polling, no wasted compute — sleeps until work arrives
- **Multi-channel**: Signal, Email, Web, Webhooks — unified inbox via trigger sessions
- **Autonomous**: Triggers handle events, delegate to agent teammates when needed
- **Persistent**: Memory, identity, and sessions survive restarts of container

## Overview

```
Trigger Event → trigger.sh → trigger-runner (native binary) → Trigger Session (PM role)
                                                                          ↓
                                                         Simple: respond directly via CLI tools
                                                         Complex: TeamCreate + Agent(teammates)
                                                                          ↓
                                                         Teammates work in parallel on non-overlapping paths
```

## Tech Stack

- **Runtime**: Bun (TypeScript, no build)
- **Database**: SQLite (bun:sqlite)
- **Web**: Hono.js + HTMX
- **Process Manager**: supervisord
- **Container**: Ubuntu 24.04



## Documentation

- [docs/Architecture.md](docs/Architecture.md) — Component overview
- [docs/hooks.md](docs/hooks.md) — Lifecycle hooks
- [docs/watcher.md](docs/watcher.md) — Trigger concurrency and IPC injection
- [docs/memory.md](docs/memory.md) — Memory and search
- [docs/web-ui.md](docs/web-ui.md) — Dashboard and API
- [docs/directory-structure.md](docs/directory-structure.md) — Filesystem layout
- [docs/development.md](docs/development.md) — Developer guide
- [docs/Triggers.md](docs/Triggers.md) — Triggers guide
- [docs/Integrations.md](docs/Integrations.md) — Signal and Email
