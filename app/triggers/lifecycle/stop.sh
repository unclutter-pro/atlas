#!/bin/bash
# Lifecycle policy: the agent wants to end its turn.
# Output: exit 2 with the reason on stdout = keep working; exit 0 with text =
# context for the agent; exit 0 without output = may stop.
#
# The validator session is not handled here: its format gate needs the final
# assistant message, which the backend adapter passes to validator-gate.ts.
set -euo pipefail

LIFECYCLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ "${ATLAS_TRIGGER_CHANNEL:-}" = "validator" ] && exit 0

# --- Kill-switch: ATLAS_TASKS_DISABLE_GATE=1 skips task enforcement ---
if [ "${ATLAS_TASKS_DISABLE_GATE:-0}" = "1" ]; then
  echo "WARNING: ATLAS_TASKS_DISABLE_GATE=1 — task gate disabled, allowing stop" >&2
  exit 0
fi

# --- Task completion gate (trigger sessions) ---
if [ -n "${ATLAS_TRIGGER:-}" ] && [ -n "${ATLAS_TRIGGER_SESSION_KEY:-}" ]; then
  CODE=0
  REASON=$("$LIFECYCLE_DIR/task-session.sh" check 2>/dev/null) || CODE=$?
  if [ "$CODE" -eq 2 ] && [ -n "$REASON" ]; then
    echo "$REASON"
    exit 2
  elif [ "$CODE" -ne 0 ] && [ "$CODE" -ne 2 ]; then
    echo "ERROR: task-session.sh check exited $CODE (expected 0 or 2) — blocking stop instead of treating it as no open work" >&2
    echo "The task gate failed unexpectedly (exit $CODE) instead of confirming that no goals or tasks are open. Blocking to be safe — check manually with \`task list\` and \`task goal list\`."
    exit 2
  fi
fi

# --- Trigger sessions: remind to write a journal if today's entry doesn't exist ---
if [ -n "${ATLAS_TRIGGER:-}" ]; then
  TODAY=$(date +%Y-%m-%d)
  JOURNAL_DIR="$HOME/memory/journal"
  if [ -d "$JOURNAL_DIR" ] && ls "$JOURNAL_DIR/${TODAY}"*.md 1>/dev/null 2>&1; then
    : # Journal already exists for today
  else
    echo "<system-notice>"
    echo "JOURNAL REMINDER: You have not written a journal entry for today ($TODAY)."
    echo "Before ending this session, please write your daily journal to: memory/journal/${TODAY}.md"
    echo "Include: key activities, task results, decisions made, and anything to carry forward."
    echo "</system-notice>"
  fi
fi

exit 0
