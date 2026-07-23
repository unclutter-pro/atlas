---
name: reminders
description: Schedule events that fire at a specific time, when an email reply arrives, or when a shell check passes. Use to wake a session without idle polling.
---

# Reminders

Three trigger types — pick the one that matches what you're actually waiting on:

| Trigger | Use when |
|---|---|
| `--at=<time>` | Wall-clock deadline. "Remind me at 14:00", "follow up in 30 minutes". |
| `--when-reply-to=<thread-id>` | Waiting on a human / external system to reply by email. **Most stakeholder loops use this.** |
| `--when-script-ok=<cmd>` | Waiting on an external system you can poll cheaply (deploys, CI builds, file landings, status APIs). |

Each reminder runs a Claude session with the given prompt when it fires. Reminders can be one-shot or recurring; session routing picks up the originating channel automatically.

## CLI Commands

### Add a time-based reminder
```bash
reminder add --title="Standup" --at="2026-03-08 09:00" --prompt="Send the daily standup summary"
reminder add --title="Deploy check" --at="+2h" --prompt="Verify the rollout completed"
reminder add --title="Quick nudge" --at="+30m" --prompt="Ping Max about the proposal"
```

### Add a recurring reminder (still `--at`-based)
```bash
reminder add --title="Build watch" --at="+5h" --recurring=5h --prompt="Review CI status"
```

`--recurring` is only supported with `--at`. See the **Recurring Reminders** section below.

### Wait for an email reply
```bash
# Most common: wait forever for a reply (real humans take days)
reminder add --title="Müller OK" \
  --when-reply-to="thread-abc123" \
  --prompt="Müller hat geantwortet — gleich abarbeiten"

# Restrict to a specific sender on the thread (substring match on the From: address)
reminder add --title="Müller OK" \
  --when-reply-to="thread-abc123" \
  --from="s.mueller@mueller-partner.de" \
  --prompt="Müller hat geantwortet — gleich abarbeiten"

# Safety net: give up after two weeks if nothing arrives
reminder add --title="Müller OK" \
  --when-reply-to="thread-abc123" \
  --timeout="+14d" \
  --prompt="Müller hat geantwortet (oder Timeout) — entscheiden"
```

Use `email threads` to find the right `thread-id`. When a reply arrives, the reminder fires at the next `check` tick (every minute by default).

### Wait for a shell check to pass
```bash
# Default: poll every 60s
reminder add --title="Deploy ready" \
  --when-script-ok="kubectl rollout status deploy/api --timeout=10s" \
  --prompt="Deploy ist live — Tests fahren"

# Slower polling for cheap-but-noisy checks (minimum interval: 60s)
reminder add --title="File landed" \
  --when-script-ok="test -s /shared/output/import.csv" \
  --check-interval="5m" \
  --prompt="Importdatei ist da — verarbeiten"

# With timeout
reminder add --title="CI green" \
  --when-script-ok="gh run view --json conclusion -q '.conclusion==\"success\"'" \
  --check-interval="2m" --timeout="+2h" \
  --prompt="CI ist grün — Release-Notes raus"
```

The command is run under `bash -c`. **Exit-code contract:**

| Exit code | Meaning | Effect |
|---|---|---|
| `0` | condition met | reminder fires |
| `1` | condition not met yet | keep waiting |
| `>1` | broken command (typo, missing binary, config error) | error — logged at check time, rejected at add time |

**Dry-run on `add`:** the command is always executed once when you create the reminder. Exit `>1` or a 30s timeout **rejects the add** with the command's stderr, so you can fix it immediately — a typo'd command no longer waits silently forever. Exit `0` prints a note that the reminder will fire at the next tick (~1 minute); cancel it if that's not intended. This also means the check command must be safe to run at any time — it runs at every tick anyway, so it should be side-effect-free by design.

Write check commands to match the contract: most Unix predicates (`test`, `grep -q`, `jq -e`) naturally exit 0/1. If a tool signals "not ready" with codes above 1, wrap it: `<cmd> || exit 1` — but be aware this also masks real errors from the dry-run.

## Important defaults

- **No default timeout.** Real-world events take days, not hours. If you don't set `--timeout`, the reminder waits forever (until cancelled). Set `--timeout=+14d` or similar only when you genuinely need a safety net.
- **Default `--check-interval` is 60s** for `--when-script-ok`. Minimum is 60s — the check loop is driven by a once-per-minute cron, so faster polling is not possible.
- **`--at` reminders are NOT deduplicated.** Setting two 30-minute timers is a legitimate request.
- **`--when-reply-to` and `--when-script-ok` ARE deduplicated** by the tuple `(trigger config, prompt)`. Re-adding the same reminder returns the existing id — safe to retry in agent loops.

## Time formats for `--at` and `--timeout`

- Full datetime: `"2026-03-08 14:00"` or `"2026-03-08T14:00:00"` (local timezone)
- Time only (today): `"14:00"`
- Relative, single unit: `"+30m"`, `"+2h"`, `"+1d"`, `"+14d"`
- Relative, combined: `"+1d2h30m"`, `"+2h30m"`, `"+90m"` (units in order: d, h, m)

## List, cancel, delete

```bash
reminder list              # pending only
reminder list --all        # include fired/cancelled
reminder list --recurring  # show recurring chains

reminder cancel 5          # by positional id (mark as cancelled, keeps history)
reminder cancel --id=5     # or by flag — equivalent
reminder delete 5          # permanently remove (positional or --id=5)
```

The `list` output includes the trigger type and a human-readable "fires_when" column so you can scan what each reminder is waiting on.

## Timeout semantics

If `--timeout` is set on a `--when-reply-to` or `--when-script-ok` reminder and the trigger condition isn't met by the timeout, the reminder **still fires** — with a `[Timeout: ...]` note appended to the prompt. The point is to let you decide what to do (follow up, escalate, abandon) rather than silently dropping the work.

Without `--timeout`, the reminder waits indefinitely.

## Session routing

By default, reminders fire into the **same session** that created them — Signal reminders wake the Signal session, email reminders wake the email-channel session, web reminders wake the web session.

To force a standalone ephemeral session, add `--new-session`.

## Recurring reminders (`--at` only)

```bash
reminder add --title="Hourly ping" --at="+1h" --recurring=1h \
  --prompt="Log a status update to journal"
```

After each fire the original row is marked `fired` and a new pending row is inserted with a fresh id. Cancel the current pending row to stop the chain.

Recurring reminders are session-bound (do not persist across sessions). For cross-session schedules, use a **cronjob** — see the `triggers` skill.

`--recurring` is **not** supported with `--when-reply-to` or `--when-script-ok` — those are event-driven and shouldn't repeat; set a fresh reminder after each fire if you really need that.

## How it works

- Reminders are stored in `~/.index/atlas.db`, table `reminders`.
- A cron job runs `manage-reminders.ts check` every minute. Each pending reminder is evaluated by its trigger type:
  - `time`: `fire_at <= now`
  - `email_reply`: any inbound email in the configured thread (optionally from the configured sender) created **after** the reminder was set
  - `script_check`: the configured command exits 0 (exit 1 = keep waiting; exit >1 = error, logged and treated as waiting), throttled by `check_interval_seconds`
- When a reminder fires, it routes to the originating session via `trigger.sh`, or spawns an ephemeral session if no context. If the originating trigger has since been deleted or disabled, the reminder falls back to an ephemeral session instead of being dropped.
- If the wake process fails fast (non-zero exit), the reminder is reverted to `pending` and retried on the next tick — up to 3 attempts total (recurring reminders skip the retry; their next occurrence covers it).
- Fired and cancelled reminders older than 30 days are cleaned up by the daily cleanup job.

## Common pitfalls (and how to avoid them)

- **Setting a timeout by reflex.** Don't. Most real-world replies take days. Only add `--timeout` when you genuinely need a fallback path.
- **Polling too fast in `--when-script-ok`.** The check loop runs once per minute, so intervals below 60s are impossible and get rejected. Pick the slowest interval that still reacts fast enough.
- **Treating `--when-reply-to` as a guard against missed emails.** It only fires on emails received **after** the reminder is created. If the reply might already be in the inbox, check directly first.
- **Trying to `--recurring` an event trigger.** Doesn't work — event triggers fire on edges, not intervals. Set a new reminder after each fire if you need that behavior.
