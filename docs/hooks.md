# Lifecycle Hooks

Claude Code hooks inject context at lifecycle events. Hooks are shell scripts or prompts that execute automatically — their output becomes part of Claude's context.

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

Runs after Claude finishes a response.

### Journal Reminder (Trigger Sessions Only)

For trigger sessions (`ATLAS_TRIGGER` is set), the stop hook checks if a journal file for today exists in `memory/journal/`. If no file matching `YYYY-MM-DD*.md` is found, it outputs a `<system-notice>` reminding the session to write a journal entry before ending.

## task-session.sh

Manages task management context across session lifecycle events. Configured as command-type hooks in `settings.json`. All operations are scoped to `(ATLAS_TRIGGER, ATLAS_TRIGGER_SESSION_KEY)`.

### task-session.sh start (SessionStart hook)

Runs when any Claude Code session starts (trigger sessions only — exits silently if session scope is unset).

- Queries open goals and open tasks for the current session from `atlas.db`
- Outputs a `<task-context>` block listing active goals (title, done-condition, task counts) and open tasks (priority, status)
- Outputs nothing if no goals or tasks exist (no noise)

### task-session.sh prime (PreCompact hook)

Runs before automatic or manual context compaction.

- Outputs the same `<task-context>` block as `start` so compacted context retains task continuity

### task-session.sh check (Stop hook)

Runs after each response as a completion gate.

- **Kill-switch**: if `ATLAS_TASKS_DISABLE_GATE=1` is set, skips enforcement and logs a warning to stderr
- Counts active goals and open tasks (open + in_progress) for the current session
- If any exist: emits `{"decision":"block","reason":"..."}` JSON to block exit until they are closed
- If none: exits silently (allows stop)

## post-compact.sh (PostCompact hook)

Runs after context compaction completes. Re-injects the `<task-context>` block with a hard 2KB limit:
- Always shows all open goals (title + done-condition + open-task-count, no description body)
- Shows up to 30 open tasks (title + priority + status)
- If truncated: appends `"...and N more — use 'task list' for details"`
- If output would exceed 2KB: falls back to just counts: `"N open goal(s), M open task(s) (use 'task list' for details)"`

## pre-compact-auto.sh

Runs before automatic context compaction.

### Trigger Session Mode

Uses channel-specific templates:
- `app/prompts/trigger-{CHANNEL}-pre-compact.md`
- `app/prompts/trigger-pre-compact.md` (fallback)

### Other Sessions

Outputs generic memory flush instructions.

## pre-compact-manual.sh

Runs before manual context compaction (when user runs `/compact`). Same behavior as `pre-compact-auto.sh`.

## SubagentStop (prompt-type hook)

Configured in `settings.json` as a prompt-type hook. Fires in the trigger session when a subagent finishes. Asks the trigger session to evaluate whether the subagent's result is complete and acceptable, or needs rework.

Configured via `generate-settings.ts` — the model used for this review is set by `subagent_review` in `config.yml`.

## Source

- `app/hooks/session-start.sh` — Context loading
- `app/hooks/stop.sh` — Session lifecycle + task gate (calls task-session.sh check)
- `app/hooks/task-session.sh` — Task context management (SessionStart, PreCompact, Stop)
- `app/hooks/post-compact.sh` — PostCompact task context re-injection
- `app/hooks/pre-compact-auto.sh` — Memory flush (auto compaction)
- `app/hooks/pre-compact-manual.sh` — Memory flush (manual compaction)
- `app/hooks/generate-settings.ts` — Generates `~/.claude/settings.json` with hook config
