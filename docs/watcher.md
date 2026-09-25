# Trigger Concurrency & Session Lifecycle

## How Triggers Handle Concurrency

Each trigger invocation runs as its own process. Concurrent runs of the same trigger+key pair are prevented by the trigger-runner using a PID-based lock file:

```
/tmp/.trigger-<trigger-name>-<session-key>.flock
```

If a trigger-runner is already active for that key (PID alive), the new invocation waits up to 60s. After acquiring the lock, it re-checks the DB for sessions that appeared while waiting.

## Persistent Session IPC

For persistent triggers, the trigger-runner tries to hand new messages to the runner that already owns the session before spawning a new process:

1. Look up the existing session ID in `trigger_sessions` DB
2. Check JSONL file activity (mtime) to detect stale sessions
3. If the session is live, send the message to that runner's control socket, `/tmp/.trigger-<name>-<key>.sock`; it is processed after the current turn
4. Otherwise acquire the lock and resume (see below)

A running runner listens on that control socket and holds the lock file `/tmp/.trigger-<name>-<key>.flock` with its PID. `app/lib/trigger-socket.ts` builds both paths: characters other than letters, digits and `_` in the key become `_` plus a short hash of the original key (so `a-b` and `a_b` never share a runner), and long keys are hashed. The runner uses them to accept messages between turns. The web-ui uses them to interrupt a chat turn ("Stop turn") and to check whether a chat's runner is still alive, and the kill switch uses the PID to stop runners.

Processes that cannot import `trigger-socket.ts` (the Python channel addons) use `trigger-runner --inject <trigger> <key> "<message>" [--channel <channel>]`. It exits 0 when the live runner accepted the message, 2 when no runner is alive (the caller may resume the session itself) and 3 when a runner is alive but unreachable. Signal and WhatsApp `/new` use it to hand the farewell prompt to a running session instead of resuming the same session in a second process.

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
| **Missing** | — | no JSONL | Start fresh session |

### Stale Recovery

A session is stale when a live runner holds its lock but neither the session transcript nor any of its subagent transcripts (`<session-id>/subagents/*.jsonl`) was written for 30+ minutes. Subagents write to their own files while the parent waits, so their activity keeps the session alive.

1. The runner holding the lock gets `SIGTERM` (it releases its lock and the SDK stops the Claude CLI). After 10 seconds, the runner and its child processes get `SIGKILL`.
2. The session is resumed with a `<system-notice>` prepended to the prompt, telling the session it was idle-terminated and should continue.

An old transcript without a live runner is normal (runners exit after `TRIGGER_IDLE_TIMEOUT`, default 5 minutes). It resumes without a notice.

A failed resume (error result with 0 turns) clears the stored session and retries with a fresh one, so a transcript the CLI cannot resume never blocks the chat.

The stale threshold is configurable via `STALE_SESSION_THRESHOLD` env var (default: 1800 seconds / 30 minutes).

## Timeouts

- **Persistent sessions**: No hard timeout — they can run for hours (teams, complex tasks). Stale detection handles hung sessions.
- **Ephemeral sessions**: `TRIGGER_TIMEOUT` env var (default: 3600s / 1 hour).

## Log Files

- `/atlas/logs/trigger-<name>.log` — Per-trigger session output
