# Architecture

Atlas is a single-container system that turns Claude Code into a persistent, event-driven agent. This document provides a high-level component overview.

## System Overview

```
┌─────────────────── Docker Container (supervisord) ────────────────────┐
│                                                                        │
│  ┌─────────┐   ┌──────────┐                                          │
│  │  nginx   │──▸│  web-ui  │                                          │
│  │  :8080   │   │  :3000   │                                          │
│  └─────────┘   └──────────┘                                          │
│                      │                                                 │
│                      ▼                                                 │
│               ┌──────────────────────────────────────────┐            │
│               │          atlas.db (SQLite)                │            │
│               │  triggers │ trigger_sessions              │            │
│               └──────────────────────────────────────────┘            │
│                                                                        │
│  ┌────────────┐                                                        │
│  │ supercronic│                                                        │
│  │ (cron)     │                                                        │
│  └────────────┘                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

## Component Summary

| Component | Port | Purpose | Documentation |
|-----------|------|---------|---------------|
| **nginx** | 8080 | Reverse proxy to web-ui | [web-ui.md](web-ui.md) |
| **web-ui** | 3000 | Hono.js + HTMX dashboard | [web-ui.md](web-ui.md) |
| **supercronic** | — | Cron job runner | [Triggers.md](Triggers.md) |

## Data Flow

1. **Event arrives** — Cron fires, webhook POSTs, or message sent
2. **Trigger session** — `trigger.sh` spawns a Claude session via `trigger-runner` (native binary)
3. **Trigger handles** — Processes the event, responds directly or delegates
4. **Delegation** — For complex work: spawns subagents via `Agent(...)`
5. **Review** — Trigger reviews subagent results before relaying to the user

## Session Types

### Trigger Session (Project Manager)
- **Spawned by**: `trigger.sh` per event via `trigger-runner` (compiled Bun binary)
- **System prompt**: SOUL + IDENTITY + trigger-system-prompt + channel-specific prompt
- **Purpose**: User communication, task planning, memory management, team coordination
- **Lifecycle**: Persistent sessions survive container restarts (resume via SDK) and are auto-recovered when stale (see [watcher.md](watcher.md))

### Subagents
- **Spawned by**: Trigger session via `Agent(subagent_type=..., model=..., prompt=...)`
- **Context**: Stateless — receives all needed context via the prompt
- **Purpose**: Execute focused tasks (implementation, research, review)

See [Triggers.md](Triggers.md) for the full trigger lifecycle.

## Memory System

Memory is stored as plain Markdown files in `~/memory/` with YAML frontmatter and `[[wikilinks]]` for cross-referencing. There is no indexing daemon — retrieval is done directly via grep, glob, and file reads through specialized sub-agents **memory-searcher** which finds information using grep/glob patterns across the memory directory.

See [memory.md](memory.md) for the full memory system documentation.

## Parallel Execution

Subagents can be spawned in parallel via multiple `Agent(...)` calls. Each subagent is stateless and receives all context through its prompt.

## Filesystem Layout

| Location | Access | Contents |
|----------|--------|----------|
| `/atlas/app/` | Read-only | Core code, hooks, MCP server, prompts |
| `/home/agent/` | Read-write | Memory, system state, config, identity, skills |

See [directory-structure.md](directory-structure.md) for details.

## Hook System

Hooks inject context at lifecycle events:

| Hook | Runs When | Purpose |
|------|-----------|---------|
| session-start.sh | Every session starts | Load memory (all sessions) |
| stop.sh | After response | Journal reminder (trigger sessions) |
| pre-compact-*.sh | Before compaction | Prompt memory flush |
| SubagentStop | Subagent finishes | Quality gate (prompt-type review) |
| beads-session.sh start | Every session starts | Load Beads task context, set env |
| beads-session.sh prime | Before compaction | Inject task state for context recovery |
| beads-session.sh check | Stop hook | Gate exit on unclosed claimed tasks |

See [hooks.md](hooks.md) for details.

## Detailed Documentation

- [hooks.md](hooks.md) — Lifecycle hook system
- [memory.md](memory.md) — Memory and search system
- [web-ui.md](web-ui.md) — Dashboard and API
- [directory-structure.md](directory-structure.md) — Filesystem layout
- [development.md](development.md) — Developer guide
- [Triggers.md](Triggers.md) — Triggers system
- [Integrations.md](Integrations.md) — Signal and Email
