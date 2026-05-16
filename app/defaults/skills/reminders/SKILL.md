---
name: reminders
description: Schedule one-time reminder events. Use when you need to be reminded about something at a specific time.
---

# Reminders

Schedule events that fire at a specific time. Each reminder runs a Claude session with the given prompt when the time arrives. Reminders can be one-shot (fire once) or recurring (fire repeatedly until cancelled).

## CLI Commands

### Add a reminder
```bash
reminder add --title="Team standup" --at="2026-03-08 09:00" --prompt="Send Max the daily standup summary via Signal"
reminder add --title="Deploy check" --at="+2h" --prompt="Check if the deployment succeeded"
reminder add --title="Quick note" --at="+30m" --prompt="Remind Max about the meeting"
```

### Add a recurring reminder
```bash
reminder add --title="Check builds" --at="+5h" --recurring=5h --prompt="Review the CI pipeline status"
reminder add --title="Hourly ping" --at="+1h" --recurring=1h --prompt="Log a status update to journal"
```

`--recurring` fires the reminder repeatedly on the given interval until explicitly cancelled. See the **Recurring Reminders** section below.

### Time formats for --at
- Full datetime: `"2026-03-08 14:00"` or `"2026-03-08T14:00:00"` (local timezone)
- Time only (today): `"14:00"`
- Relative: `"+30m"`, `"+2h"`, `"+1d"`

### Interval formats for --recurring (no leading +)
- `"30m"` — every 30 minutes
- `"2h"` — every 2 hours
- `"1d"` — every day
- Minimum: `"1m"` (60 seconds)

### List reminders
```bash
reminder list              # pending only (all types)
reminder list --all        # include fired/cancelled
reminder list --recurring  # show only recurring reminders
```

### Cancel/delete a reminder
```bash
reminder cancel --id=5  # mark as cancelled (keeps history)
reminder delete --id=5  # permanently remove
```

## Session Routing

By default, reminders fire into the **same session** that created them. This means:
- A reminder set from a **Signal** session will wake up the Signal session for that contact
- A reminder set from a **web chat** session will wake up the web chat session
- A reminder set from a **cron job** will resume that cron trigger's session

This ensures the firing session has full conversation context and can respond via the right channel.

To force a **standalone ephemeral session** instead (no session context), use `--new-session`:
```bash
reminder add --title="Independent task" --at="+1h" --prompt="Do something" --new-session
```

## Recurring Reminders

Recurring reminders fire on a repeating interval into the **same session that created them**, until explicitly cancelled.

### How it works

1. When a recurring reminder fires, the original row is marked `fired` (kept as an audit record).
2. A **new pending row** is inserted for the next fire, inheriting all fields and the same `trigger_name`/`session_key`.
3. This means the **row id changes after each fire**. Use `reminder list` to find the current pending id.
4. Cancel the current pending row to stop the chain: `reminder cancel --id=<current-id>`

### Session lifetime

Recurring reminders are **session-bound** — they do not persist across sessions. When the originating session ends (idle timeout), any future check will find no active session to resume into, and the reminder will be gracefully archived. They are not cronjobs.

### Compaction safety

Even if Claude Code assigns a new session_id after compaction or resume, the trigger-runner looks up sessions by `(trigger_name, session_key)`, not by session_id. Recurring reminders therefore survive compaction transparently.

### Restrictions

- `--recurring` requires an active trigger session (`ATLAS_TRIGGER` must be set). It cannot be used from a standalone script context.
- `--recurring` is incompatible with `--new-session`.
- `--persist` is not supported. For cross-session schedules, use a **cronjob** — see `cron --help` or the `triggers` skill.

### Example

```bash
# Every 5 hours, check the CI build status
reminder add \
  --title="Check builds" \
  --at="+5h" \
  --recurring=5h \
  --prompt="Check CI pipeline status and report any failures to journal"

# Output:
# Reminder #42 scheduled: "Check builds"
#   Fire at: 5/16/2026, 8:00:00 PM
#   Channel: internal
#   Session: signal/max (will resume originating session)
#   Recurring: every 5h. Will run until cancelled. Use 'reminder cancel --id=<id>' to stop.
#   Note: after each fire a new pending row is created with a fresh id — use 'reminder list' to find the current one.

# Stop it later:
reminder list --recurring      # find the current pending id
reminder cancel --id=47        # cancel current pending row (stops the chain)
```

## How It Works

- Reminders are stored in the SQLite database (`~/.index/atlas.db`) in the `reminders` table
- A cron job checks for due reminders every minute: `* * * * * bun /atlas/app/triggers/manage-reminders.ts check`
- When a reminder fires, it routes to the originating session via `trigger.sh` (or spawns an ephemeral session if no context)
- Fired and cancelled reminders older than 30 days are automatically cleaned up by the daily cleanup job

## Notes

- The `--at` time is stored in UTC internally; it is displayed in local time when listing
- One-shot reminders fire exactly once — use `--recurring` for repeating events within a session, or cronjobs for cross-session schedules
- The `--channel` flag (default: `internal`) sets the `ATLAS_TRIGGER_CHANNEL` environment variable for the spawned session
- Session context (`trigger_name`, `session_key`) is captured automatically from the environment when a reminder is created
