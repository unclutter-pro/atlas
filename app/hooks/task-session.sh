#!/bin/bash
# task-session.sh — Atlas task management session hooks.
# Scoped to (ATLAS_TRIGGER, ATLAS_TRIGGER_SESSION_KEY) per session.
#
# Usage (from hooks):
#   task-session.sh start        — Output task-context block for SessionStart
#   task-session.sh prime        — Same as start, for PreCompact context recovery
#   task-session.sh post-compact — Compact context with 2KB hard limit
#   task-session.sh check        — Stop hook: block if open goals or tasks exist
set -euo pipefail

# Resolve the task CLI — works both in container and in dev
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRIGGERS_DIR="$SCRIPT_DIR/../triggers"
TASK_CLI="bun $TRIGGERS_DIR/manage-tasks.ts"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

has_session_scope() {
  [ -n "${ATLAS_TRIGGER:-}" ] && [ -n "${ATLAS_TRIGGER_SESSION_KEY:-}" ]
}

# Count lines starting with '#' in a string; returns 0 on no matches (no exit 1)
count_hash_lines() {
  local input="$1"
  if [ -z "$input" ]; then
    echo "0"
    return 0
  fi
  local count
  count=$(echo "$input" | grep -c '^#' 2>/dev/null) || count=0
  echo "$count"
}

# Build compact task-context block
build_context() {
  local MAX_TASKS=30

  # Get open goals
  local goals_output
  goals_output=$($TASK_CLI goal list 2>/dev/null) || goals_output=""

  # Get open tasks (open + in_progress)
  local tasks_output
  tasks_output=$($TASK_CLI list 2>/dev/null) || tasks_output=""

  local goal_count task_count
  goal_count=$(count_hash_lines "$goals_output")
  task_count=$(count_hash_lines "$tasks_output")

  if [ "$goal_count" -eq 0 ] && [ "$task_count" -eq 0 ]; then
    # Silence — no noise when nothing is open
    return 0
  fi

  echo "<task-context>"

  if [ "$goal_count" -gt 0 ]; then
    echo "Open goals (${goal_count}):"
    while IFS= read -r line; do
      if [[ "$line" == '#'* ]]; then
        echo "  ${line}"
      elif [[ "$line" == "  done-when:"* ]] || [[ "$line" == "  tasks:"* ]]; then
        echo "    ${line#  }"
      fi
    done <<< "$goals_output"
    echo ""
  fi

  if [ "$task_count" -gt 0 ]; then
    local shown=0
    local overflow=0
    echo "Open tasks (${task_count}):"
    while IFS= read -r line; do
      if [[ "$line" == '#'* ]]; then
        if [ "$shown" -lt "$MAX_TASKS" ]; then
          echo "  ${line}"
          shown=$((shown + 1))
        else
          overflow=$((overflow + 1))
        fi
      fi
    done <<< "$tasks_output"
    if [ "$overflow" -gt 0 ]; then
      echo "  ...and ${overflow} more — use 'task list' for details"
    fi
    echo ""
  fi

  echo "Use \`task --help\` for CLI reference."
  echo "</task-context>"
}

# Build compact post-compact context with 2KB hard limit
build_post_compact_context() {
  local MAX_TASKS=30
  local MAX_BYTES=2048

  local goals_output tasks_output
  goals_output=$($TASK_CLI goal list 2>/dev/null) || goals_output=""
  tasks_output=$($TASK_CLI list 2>/dev/null) || tasks_output=""

  local goal_count task_count
  goal_count=$(count_hash_lines "$goals_output")
  task_count=$(count_hash_lines "$tasks_output")

  if [ "$goal_count" -eq 0 ] && [ "$task_count" -eq 0 ]; then
    return 0
  fi

  local full_output=""

  if [ "$goal_count" -gt 0 ]; then
    full_output+="Open goals (${goal_count}):"$'\n'
    while IFS= read -r line; do
      if [[ "$line" == '#'* ]]; then
        full_output+="  ${line}"$'\n'
      elif [[ "$line" == "  done-when:"* ]]; then
        full_output+="    ${line#  }"$'\n'
      fi
    done <<< "$goals_output"
  fi

  if [ "$task_count" -gt 0 ]; then
    local shown=0 overflow=0
    full_output+="Open tasks (${task_count}):"$'\n'
    while IFS= read -r line; do
      if [[ "$line" == '#'* ]]; then
        if [ "$shown" -lt "$MAX_TASKS" ]; then
          full_output+="  ${line}"$'\n'
          shown=$((shown + 1))
        else
          overflow=$((overflow + 1))
        fi
      fi
    done <<< "$tasks_output"
    if [ "$overflow" -gt 0 ]; then
      full_output+="  ...and ${overflow} more — use 'task list' for details"$'\n'
    fi
  fi

  local byte_count
  byte_count=$(echo -n "$full_output" | wc -c)

  if [ "$byte_count" -gt "$MAX_BYTES" ]; then
    # Fallback: just show counts
    echo "<task-context>"
    echo "${goal_count} open goal(s), ${task_count} open task(s) (use 'task list' for details)"
    echo "</task-context>"
    return 0
  fi

  echo "<task-context>"
  echo -n "$full_output"
  echo "Use \`task --help\` for CLI reference."
  echo "</task-context>"
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

case "${1:-help}" in
  start)
    if ! has_session_scope; then
      exit 0
    fi
    build_context || true
    ;;

  prime)
    if ! has_session_scope; then
      exit 0
    fi
    build_context || true
    ;;

  post-compact)
    if ! has_session_scope; then
      exit 0
    fi
    build_post_compact_context || true
    ;;

  check)
    if ! has_session_scope; then
      exit 0
    fi

    # Kill-switch: ATLAS_TASKS_DISABLE_GATE=1 skips enforcement
    if [ "${ATLAS_TASKS_DISABLE_GATE:-0}" = "1" ]; then
      echo "WARNING: ATLAS_TASKS_DISABLE_GATE=1 — task enforcement disabled, allowing stop" >&2
      exit 0
    fi

    # Count open goals and tasks
    goals_output=$($TASK_CLI goal list 2>/dev/null) || goals_output=""
    tasks_output=$($TASK_CLI list 2>/dev/null) || tasks_output=""
    local_goals=$(count_hash_lines "$goals_output")
    local_tasks=$(count_hash_lines "$tasks_output")

    total=$((local_goals + local_tasks))
    if [ "$total" -eq 0 ]; then
      exit 0
    fi

    # Honor a genuine "continue later" deferral: if this session has a pending
    # continuation reminder (event-driven, or a one-shot future timer that
    # routes back into this same session), the open work is legitimately
    # scheduled to resume — allow the session to stop instead of deadlocking.
    # The gate message itself suggests "set a reminder to continue later"; this
    # makes that suggestion actually work. The predicate is tight (see
    # manage-reminders.ts hasPendingContinuation) so a throwaway reminder can't
    # be used to escape the gate.
    REMINDER_CLI="bun $TRIGGERS_DIR/manage-reminders.ts"
    continuation=$($REMINDER_CLI has-continuation 2>/dev/null) || continuation="no"
    if [ "$continuation" = "yes" ]; then
      exit 0
    fi

    # Build block message
    parts=""
    if [ "$local_goals" -gt 0 ]; then
      parts="${local_goals} active goal(s)"
    fi
    if [ "$local_tasks" -gt 0 ]; then
      if [ -n "$parts" ]; then
        parts="${parts} and ${local_tasks} open task(s)"
      else
        parts="${local_tasks} open task(s)"
      fi
    fi

    jq -n --arg parts "$parts" '{
      decision: "block",
      reason: ("You have " + $parts + ". Complete or close them before exiting. Use `task list` and `task goal list` to review, then `task close <id>` / `task goal close <id> --reason=...` to finish up. To defer instead, set a continuation reminder that resumes THIS session — `reminder add --when-reply-to=<thread>` / `--when-script-ok=<cmd>` / `--at=<future-time>` (not --new-session, not --recurring). A pending continuation reminder lets the session stop without false-closing unfinished work.")
    }'
    ;;

  *)
    echo "Usage: task-session.sh {start|prime|post-compact|check}" >&2
    exit 1
    ;;
esac
