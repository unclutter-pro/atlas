# Lifecycle Hooks

Claude Code hooks inject context at lifecycle events. Hooks are shell scripts or prompts that execute automatically — their output becomes part of Claude's context.

## session-start.sh

Runs when any Claude Code session starts (trigger sessions and agent teammates).

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

## Stop Completion Check (prompt-type hook)

Configured in `settings.json` as a prompt-type hook alongside `stop.sh`. Uses the `subagent_review` model (sonnet) to dynamically evaluate whether the session can safely exit.

The model reviews the conversation for:
1. **Team lifecycle** — Were all teams shut down (shutdown_request + TeamDelete)?
2. **Task completion** — Were all created tasks completed?
3. **Response delivery** — Was a response sent via the channel CLI tool?
4. **Original request** — Was the triggering task fully addressed?

Sessions without teams or external messages (e.g. simple agent workers) pass immediately. This naturally scopes to the current session's teams since the model only sees this session's conversation — parallel sessions' teams are invisible.

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

Configured in `settings.json` as a prompt-type hook. Fires in the trigger session when an agent teammate finishes. Asks the trigger session to evaluate whether the teammate's result is complete and acceptable, or needs rework.

Configured via `generate-settings.ts` — the model used for this review is set by `subagent_review` in `config.yml`.

## Source

- `app/hooks/session-start.sh` — Context loading
- `app/hooks/stop.sh` — Session lifecycle
- `app/hooks/pre-compact-auto.sh` — Memory flush (auto compaction)
- `app/hooks/pre-compact-manual.sh` — Memory flush (manual compaction)
- `app/hooks/generate-settings.ts` — Generates `~/.claude/settings.json` with hook config
