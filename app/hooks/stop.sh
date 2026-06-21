#!/bin/bash
# Stop Hook: Session lifecycle management
# Task completion gate is handled by task-session.sh check.
set -euo pipefail

# --- Validator format gate (channel=validator) ---
# The goal-validator must end its turn with a parseable JSON verdict. If it
# answers in prose, block the stop and reprompt so the same session corrects
# itself. Handled first and in isolation — the validator has no tasks/journal,
# so the gates below must not run for it.
if [ "${ATLAS_TRIGGER_CHANNEL:-}" = "validator" ]; then
  cat | bun /atlas/app/hooks/validator-stop-check.ts 2>/dev/null || true
  exit 0
fi

# --- Kill-switch: ATLAS_TASKS_DISABLE_GATE=1 skips task enforcement ---
if [ "${ATLAS_TASKS_DISABLE_GATE:-0}" = "1" ]; then
  echo "WARNING: ATLAS_TASKS_DISABLE_GATE=1 — task gate disabled, allowing stop" >&2
  exit 0
fi

# --- Task completion gate (trigger sessions) ---
if [ -n "${ATLAS_TRIGGER:-}" ] && [ -n "${ATLAS_TRIGGER_SESSION_KEY:-}" ]; then
  CHECK_OUTPUT=$(/atlas/app/hooks/task-session.sh check 2>/dev/null) || true
  if [ -n "$CHECK_OUTPUT" ]; then
    echo "$CHECK_OUTPUT"
    exit 0
  fi
fi

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
