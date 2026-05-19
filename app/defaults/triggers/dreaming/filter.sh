#!/bin/bash
# Skip dreaming if no REAL (non-system) Claude Code sessions ran in the last 24h.
#
# A "system session" is one initiated by a periodic introspection or maintenance
# trigger (dreaming, memory-cleanup, daily-cleanup) — these add no new external
# information and would create a perpetual self-trigger loop if used as activity
# signal.
#
# Real sessions: anything user-driven (chat, email, signal, web, ad-hoc CLI)
# or alert-driven (errors, security scans, cluster events).
#
# Exit 0 = fire, Exit 1 = skip.

LOG=/atlas/logs/trigger-dreaming.log

# Prefer the `sessions` tool — it joins JSONL discovery with trigger_sessions /
# session_metrics to identify which sessions belong to which trigger.
if command -v sessions >/dev/null 2>&1; then
    LIST=$(sessions --hours 24 --list \
        --exclude-trigger dreaming \
        --exclude-trigger memory-cleanup \
        --exclude-trigger daily-cleanup 2>/dev/null)
    # Output rows look like:  "main | <id> | <turns> | <time> | ..."
    # We only consider main sessions (subagents are nested within mains).
    if echo "$LIST" | grep -qE "^main \|"; then
        exit 0
    else
        echo "[$(date)] Dreaming skipped — no non-system sessions in last 24h" >> "$LOG"
        exit 1
    fi
fi

# Fallback (sessions tool unavailable): fall back to raw mtime check.
# We can't distinguish system from real sessions here, so we err on the
# side of firing — but this should not happen in normal Atlas containers.
CLAUDE_DIR="$HOME/.claude/projects"
[ ! -d "$CLAUDE_DIR" ] && exit 1

FOUND=$(find "$CLAUDE_DIR" -maxdepth 2 -name "*.jsonl" -not -path "*/subagents/*" -mmin -1440 2>/dev/null | head -1)
if [ -n "$FOUND" ]; then
    echo "[$(date)] Dreaming proceeding via fallback — sessions tool unavailable" >> "$LOG"
    exit 0
else
    echo "[$(date)] Dreaming skipped — no sessions in last 24h" >> "$LOG"
    exit 1
fi
