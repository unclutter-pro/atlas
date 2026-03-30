#!/bin/bash
# Stop Hook: Session lifecycle management
# Completion check is handled by the prompt hook in settings.json (sonnet model)
set -euo pipefail

# --- 1. Trigger sessions: remind to write a journal if today's entry doesn't exist ---
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
