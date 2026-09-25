#!/bin/bash
# Skip dreaming if no REAL (non-system) agent sessions ran in the last 24h.
#
# A "system session" is one initiated by a periodic introspection or maintenance
# trigger (dreaming, memory-cleanup, daily-cleanup) or a quality-gate session
# (validator) — these add no new external information and would create either a
# perpetual self-trigger loop or just noise if used as activity signal.
#
# Real sessions: anything user-driven (chat, email, signal, web, ad-hoc CLI)
# or alert-driven (errors, security scans, cluster events).
#
# Exit 0 = fire, Exit 1 = skip.

LOG=/atlas/logs/trigger-dreaming.log

# `sessions` reads the agent backend's session store and joins it with
# trigger_sessions / session_metrics to tell which sessions belong to which trigger.
if ! command -v sessions >/dev/null 2>&1; then
    # Should not happen in an Atlas container; err on the side of firing.
    echo "[$(date)] Dreaming proceeding — sessions tool unavailable" >> "$LOG"
    exit 0
fi

LIST=$(sessions --hours 24 --list \
    --exclude-trigger dreaming \
    --exclude-trigger memory-cleanup \
    --exclude-trigger daily-cleanup \
    --exclude-trigger validator 2>/dev/null)
# Output rows look like:  "main | <id> | <turns> | <time> | ..."
# We only consider main sessions (subagents are nested within mains).
if echo "$LIST" | grep -qE "^main \|"; then
    exit 0
fi
echo "[$(date)] Dreaming skipped — no non-system sessions in last 24h" >> "$LOG"
exit 1
