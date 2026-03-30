# Trigger Concurrency & Session Lifecycle

## How Triggers Handle Concurrency

Each trigger invocation runs as its own process. Concurrent runs of the same trigger+key pair are prevented by the trigger-runner using a PID-based lock file:

```
/tmp/.trigger-<trigger-name>-<session-key>.flock
```

If a trigger-runner is already active for that key (PID alive), the new invocation waits up to 60s. After acquiring the lock, it re-checks the DB for sessions that appeared while waiting.

## Persistent Session IPC

For persistent triggers, the trigger-runner tries to inject new messages into a running session via the Claude Code IPC socket before spawning a new process:

1. Look up the existing session ID in `trigger_sessions` DB
2. Check if the socket exists at `/tmp/claudec-<session_id>.sock`
3. Check JSONL file activity (mtime) to detect stale sessions
4. Route based on session state (see below)

## Session State Machine

```
Message arrives for persistent trigger
         |
         v
  Session in DB? --no--> Acquire lock --> Start fresh session
         |
        yes
         |
         v
  Socket alive? --no--> Acquire lock --> Resume session (SDK --resume)
         |
        yes
         |
         v
  JSONL active? --yes--> IPC inject message --> done
  (< 30min idle)
         |
         no (stale)
         |
         v
  Kill stale process --> Acquire lock --> Resume with <system-notice>
```

### States

| State | Socket | JSONL Activity | Action |
|-------|--------|---------------|--------|
| **Active** | alive | recent (< 30min) | IPC inject message into running session |
| **Stale** | alive | idle (> 30min) | Kill process, resume session with system notice |
| **Stopped** | gone | — | Resume session normally (e.g. after container restart) |
| **Corrupted** | — | ends with `queue-operation` | Clear session, start fresh |
| **Missing** | — | no JSONL | Start fresh session |

### Stale Recovery

When a session is detected as stale (socket alive but no JSONL writes for 30+ minutes):

1. The owning process is killed via `SIGTERM` (found via `lsof` on the socket)
2. The socket file is cleaned up
3. The session is resumed with a `<system-notice>` prepended to the prompt, telling the session it was idle-terminated and should continue

The stale threshold is configurable via `STALE_SESSION_THRESHOLD` env var (default: 1800 seconds / 30 minutes).

## Timeouts

- **Persistent sessions**: No hard timeout — they can run for hours (teams, complex tasks). Stale detection handles hung sessions.
- **Ephemeral sessions**: `TRIGGER_TIMEOUT` env var (default: 3600s / 1 hour).

## Log Files

- `/atlas/logs/trigger-<name>.log` — Per-trigger session output
