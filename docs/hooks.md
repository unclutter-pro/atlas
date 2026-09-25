# Lifecycle Hooks

Atlas reacts to session lifecycle events: it loads memory and task context when a session starts, flushes memory before context compaction, keeps the agent working while tasks are open, reminds it of the journal, and nudges it away from polling.

That logic is Atlas **lifecycle policy** in `app/triggers/lifecycle/`, independent of the agent backend. Its contract:

- **Context events** (session start, before/after compaction, before a shell command): context text for the agent on stdout, or nothing.
- **Stop** (the agent wants to end its turn): exit 2 with the reason on stdout keeps the agent working; exit 0 with text adds context; exit 0 without output allows the stop.

A backend adapter maps its native hook mechanism onto these scripts. For Claude Code, `HarnessBackend.configure()` (`app/triggers/harness/claude/settings.ts`, run by `app/triggers/harness/configure.ts` at container start and after config changes) registers them in `~/.claude/settings.json`:

| Claude Code hook | Registered command |
|---|---|
| SessionStart | `lifecycle/session-start.sh`, `lifecycle/task-session.sh start` |
| PreCompact (auto / manual) | `lifecycle/pre-compact.sh auto` / `manual` |
| PostCompact | `lifecycle/post-compact.sh` |
| Stop | `harness/claude/hooks/stop.sh` → `lifecycle/stop.sh`; exit 2 becomes `{"decision":"block","reason":...}`. Validator sessions: `validator-stop-check.ts` → `lifecycle/validator-gate.ts` |
| PreToolUse (Bash) | `rtk hook claude`, `harness/claude/hooks/remind-use-reminders.sh` → `lifecycle/command-advice.sh`, returned as `additionalContext` |
| SubagentStop | prompt-type review (below) |

Context scripts are registered directly because Claude Code's contract for them is the same (stdout becomes context). Stop and PreToolUse need the small protocol wrappers in `harness/claude/hooks/`.

## session-start.sh

Runs when any Claude Code session starts (trigger sessions and subagents).

Outputs XML-wrapped sections:

1. **Long-term memory** — Full `memory/MEMORY.md` content:
   ```xml
   <long-term-memory>
   (content of MEMORY.md)
   </long-term-memory>
   ```

2. **Recent journals** — List of recent journal files (last 7 days):
   ```xml
   <recent-journals>
     2026-02-24 (45 lines) — Daily standup and project updates
     2026-02-23 (12 lines) — Code review session
   </recent-journals>
   ```

## stop.sh

Runs when the agent wants to end its turn: the task gate (`task-session.sh check`, unless `ATLAS_TASKS_DISABLE_GATE=1`), then the journal reminder. Validator sessions are left to the validator gate.

### Validator Format Gate (Validator Session Only)

When `ATLAS_TRIGGER_CHANNEL=validator` (the isolated goal-close validator session), only the validator gate (`validator-gate.ts`) applies — the validator has no tasks or journal to gate. It needs the final assistant message, which the backend adapter supplies: Claude's `validator-stop-check.ts` reads it from the transcript Claude Code hands to the Stop hook.

The validator must end its turn with exactly one parseable JSON verdict (`{"verdict":"pass"|"fail","feedback":"..."}`). If the final assistant message is not parseable (prose, code fences, extra keys), the gate sends a format correction back so the **same** validator session continues and the model corrects its formatting — instead of the close orchestrator recording an unusable "no parseable output" result and burning a validation attempt. Parseability is checked with the same `parseValidatorOutput` the orchestrator uses, so the two never disagree. The loop is bounded: the adapter counts corrections already in the session (each carries a stable marker), and after three the gate fails open. It also fails open if the transcript or hook input is unreadable.

### Journal Reminder (Trigger Sessions Only)

For trigger sessions (`ATLAS_TRIGGER` is set), the stop hook checks if a journal file for today exists in `memory/journal/`. If no file matching `YYYY-MM-DD*.md` is found, it outputs a `<system-notice>` reminding the session to write a journal entry before ending.

## task-session.sh

Manages task management context across session lifecycle events. All operations are scoped to `(ATLAS_TRIGGER, ATLAS_TRIGGER_SESSION_KEY)`.

### task-session.sh start (session start)

Runs when a session starts (trigger sessions only — exits silently if session scope is unset).

- Queries open goals and open tasks for the current session from `atlas.db`
- Outputs a `<task-context>` block listing active goals (title, done-condition, task counts) and open tasks (priority, status)
- Outputs nothing if no goals or tasks exist (no noise)

### task-session.sh prime (before compaction)

Runs before automatic or manual context compaction.

- Outputs the same `<task-context>` block as `start` so compacted context retains task continuity

### task-session.sh check (stop gate)

Runs after each response as a completion gate.

- **Kill-switch**: if `ATLAS_TASKS_DISABLE_GATE=1` is set, skips enforcement and logs a warning to stderr
- Counts active goals and open tasks (open + in_progress) for the current session
- If any exist but the session has a **pending continuation reminder** (`reminder has-continuation` → exit 0), exits silently: the open work is legitimately deferred to a future wake of this session, so the gate must not deadlock. A continuation reminder is one that is pending, scoped to this exact session (`trigger_name` + `session_key`), and a genuine forward deferral: **recurring** (re-fires into this session for long-term monitoring), **event-driven** (`email_reply` / `script_check`), or a **one-shot `time`** reminder whose `fire_at` is in the future. A `--new-session` (NULL-scope) reminder or a past-due one-shot does **not** count. Recurring reminders are permitted, but each re-wake prompt explicitly warns that they are recurring and must not be used as a permanent gate bypass — the session is told to make real progress and cancel the reminder when done.
- Else if any exist: exits 2 with the block reason on stdout, so the agent keeps working until they are closed (the reason explains how to defer with a continuation reminder)
- If none: exits silently (allows stop)

## post-compact.sh (after compaction)

Runs after context compaction completes. Re-injects the `<task-context>` block with a hard 2KB limit:
- Always shows all open goals (title + done-condition + open-task-count, no description body)
- Shows up to 30 open tasks (title + priority + status)
- If truncated: appends `"...and N more — use 'task list' for details"`
- If output would exceed 2KB: falls back to just counts: `"N open goal(s), M open task(s) (use 'task list' for details)"`

## pre-compact.sh auto|manual

Runs before context compaction; `manual` when the user asked for it (`/compact`), which adds an emphasis on thoroughness.

### Trigger Session Mode

Uses channel-specific templates:
- `app/prompts/trigger-{CHANNEL}-pre-compact.md`
- `app/prompts/trigger-pre-compact.md` (fallback)

### Other Sessions

Outputs generic memory flush instructions.

## command-advice.sh

Runs before the agent executes a shell command (the command is the first argument). When it looks like polling (a loop with `sleep`, or a sleep of a minute or more), it advises the `reminder` CLI instead — Atlas is event-driven. Advisory only, never blocks.

## SubagentStop (prompt-type hook)

Claude Code only: configured in `settings.json` as a prompt-type hook. Fires in the trigger session when a subagent finishes. Asks the trigger session to evaluate whether the subagent's result is complete and acceptable, or needs rework.

Configured in `settings.ts` — the model used for this review is set by `subagent_review` in `config.yml`.

## Source

Lifecycle policy, `app/triggers/lifecycle/`:

- `session-start.sh` — Memory context
- `task-session.sh` — Task context (`start`, `prime`, `post-compact`) and the task gate (`check`)
- `pre-compact.sh` — Memory flush before compaction (`auto` / `manual`)
- `post-compact.sh` — Task context after compaction
- `stop.sh` — Stop policy: task gate and journal reminder
- `validator-gate.ts` — Validator JSON-verdict gate
- `command-advice.sh` — Advice against polling

Claude Code adapter, `app/triggers/harness/claude/`:

- `hooks/stop.sh` — Stop hook: runs `lifecycle/stop.sh`, translates exit 2 into Claude's block decision
- `hooks/validator-stop-check.ts` — Stop hook for the validator: final message and prior corrections from the transcript → `validator-gate.ts`
- `hooks/remind-use-reminders.sh` — PreToolUse (Bash) hook: `lifecycle/command-advice.sh` as `additionalContext`
- `settings.ts` — Writes `~/.claude/settings.json` with the hook registrations, permissions and plugins
