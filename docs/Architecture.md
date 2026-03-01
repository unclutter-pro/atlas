# Architecture

Atlas is a single-container system that turns Claude Code into a persistent, event-driven agent. This document provides a high-level component overview. For detailed information, see the focused documentation files.

## System Overview

```
┌─────────────────── Docker Container (supervisord) ────────────────────┐
│                                                                        │
│  ┌─────────┐   ┌──────────┐   ┌──────────┐   ┌───────────────────┐   │
│  │  nginx   │──▸│  web-ui  │   │ inbox-mcp│   │     watcher.sh    │   │
│  │  :8080   │   │  :3000   │   │  (stdio) │   │  (inotifywait)    │   │
│  └─────────┘   └──────────┘   └──────────┘   └───────────────────┘   │
│                      │               │               │                 │
│                      ▼               ▼               ▼                 │
│               ┌──────────────────────────────────────────┐            │
│               │          atlas.db (SQLite)                │            │
│               │  messages │ triggers │ trigger_sessions    │            │
│               └──────────────────────────────────────────┘            │
│                                      │                                 │
│                               touch .wake                              │
│                                      │                                 │
│                                      ▼                                 │
│                          ┌───────────────────┐                         │
│                          │   Claude Code      │                         │
│                          │   (resumed via     │                         │
│                          │    watcher.sh)     │                         │
│                          └───────────────────┘                         │
│                                                                        │
│  ┌────────────┐   ┌────────────┐                                      │
│  │ supercronic│   │    qmd     │                                      │
│  │ (cron)     │   │   :8181    │                                      │
│  └────────────┘   └────────────┘                                      │
└────────────────────────────────────────────────────────────────────────┘
```

## Component Summary

| Component | Port | Purpose | Documentation |
|-----------|------|---------|---------------|
| **nginx** | 8080 | Reverse proxy to web-ui | [web-ui.md](web-ui.md) |
| **web-ui** | 3000 | Hono.js + HTMX dashboard | [web-ui.md](web-ui.md) |
| **inbox-mcp** | stdio | MCP server for inbox/trigger tools | [inbox-mcp.md](inbox-mcp.md) |
| **watcher** | — | inotifywait loop, resumes Claude | [watcher.md](watcher.md) |
| **supercronic** | — | Cron job runner | [Triggers.md](Triggers.md) |
| **qmd** | 8181 | Memory search daemon | [qmd-memory.md](qmd-memory.md) |

## Data Flow

1. **Event arrives** — Cron fires, webhook POSTs, or message sent
2. **Write to inbox** — Event stored in SQLite with `status='pending'`
3. **Wake signal** — `.wake` file touched
4. **Watcher detects** — `inotifywait` sees the change
5. **Resume Claude** — Main session resumes with `get_next_task()`
6. **Process** — Claude claims task, processes, completes
7. **Re-awaken trigger** — If task had trigger, `.wake-<trigger>-<id>` wakes it
8. **Sleep** — Stop hook checks inbox; if empty, session exits

## Session Types

### Worker Session (Ephemeral)
- **Spawned by**: watcher.sh on `.wake` — one fresh session per task
- **Access**: Read/write workspace
- **Tools**: `mcp_inbox__task_complete` only (no task_create, no memory MCP)
- **Working directory**: Task's `path` if set, otherwise `$HOME`
- **Purpose**: Executes a single task; outputs JSON result via `task_complete`
- **Lifecycle**: Exits after completing one task; never resumed between different tasks
- **Review loop**: On rejection, previous session resumed with reviewer feedback (up to 5 iterations)

### Trigger Session (Project Manager)
- **Spawned by**: trigger.sh per event
- **Access**: Full workspace (read/write)
- **Tools**: Trigger tools (task_create, task_get, memory MCP, etc.)
- **Purpose**: Communicates with user, plans work, delegates tasks to workers
- **Continuity**: Persistent sessions per trigger+key; manages memory and journal

See [Triggers.md](Triggers.md) for details.

## Task Types & Parallel Execution

| Task Type | Path Required | Locking | Parallelism |
|-----------|--------------|---------|-------------|
| `normal` | Optional | Path-based (parent/child aware) | Parallel for non-overlapping paths |
| `readonly` | None | None | Always parallel |

Path locks are acquired at `task_create` and released at `task_review_approve` (or force-approve at iteration 5).

## Review Loop

Every completed task goes through a review cycle before the trigger is notified:

```
Worker → task_complete → review_status='pending' → .review-<id> file
Watcher → spawns Reviewer session
Reviewer → task_review_approve → trigger woken, path lock released
         → task_review_reject  → iteration_count++, task reset to pending, worker re-spawned
         → (at iteration 5)   → force-approve with [WARNING] prefix
```

## Filesystem Layout

| Location | Access | Contents |
|----------|--------|----------|
| `/atlas/app/` | Read-only | Core code, hooks, MCP server |
| `/home/atlas/` | Read-write | Memory, system state, config, identity, skills |

See [directory-structure.md](directory-structure.md) for details.

## Hook System

Hooks inject context at lifecycle events:

| Hook | Runs When | Purpose |
|------|-----------|---------|
| session-start.sh | Session starts | Load memory, identity, inbox status |
| stop.sh | After response | Check inbox, continue or sleep |
| pre-compact-*.sh | Before compaction | Prompt memory flush |
| subagent-stop.sh | Subagent finishes | Quality gate |

See [hooks.md](hooks.md) for details.

## Detailed Documentation

- [inbox-mcp.md](inbox-mcp.md) — Database schema, MCP tools, message lifecycle
- [hooks.md](hooks.md) — Lifecycle hook system
- [watcher.md](watcher.md) — Event-driven wake system
- [qmd-memory.md](qmd-memory.md) — Memory and search system
- [web-ui.md](web-ui.md) — Dashboard and API
- [directory-structure.md](directory-structure.md) — Filesystem layout
- [development.md](development.md) — Developer guide
- [Triggers.md](Triggers.md) — Triggers system
- [Integrations.md](Integrations.md) — Signal and Email channels
