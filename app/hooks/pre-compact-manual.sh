#!/bin/bash
# PreCompact (manual) Hook: Same as auto but with emphasis on thoroughness
# For trigger sessions: uses channel-specific templates
# For main session: uses generic memory flush instructions
set -euo pipefail

TODAY=$(date +%Y-%m-%d)
PROMPT_DIR="/atlas/app/prompts"

# Helper: resolve channel-specific template with fallback
resolve_template() {
  local suffix="$1"
  for candidate in "$PROMPT_DIR/trigger-${CHANNEL}-${suffix}.md" "$PROMPT_DIR/trigger-${suffix}.md"; do
    if [ -f "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done
}

# --- Trigger session: channel-specific compaction ---
if [ -n "${ATLAS_TRIGGER:-}" ]; then
  CHANNEL="${ATLAS_TRIGGER_CHANNEL:-internal}"
  TRIGGER_NAME="$ATLAS_TRIGGER"

  # Phase 1: Pre-compaction — save state to memory (be thorough)
  PRE_COMPACT=$(resolve_template "pre-compact")
  if [ -n "$PRE_COMPACT" ]; then
    echo "<system-notice>"
    echo "Manual compaction requested. Be thorough — detailed context will be lost."
    echo ""
    sed -e "s|{{trigger_name}}|${TRIGGER_NAME}|g" \
        -e "s|{{channel}}|${CHANNEL}|g" \
        -e "s|{{today}}|${TODAY}|g" \
        "$PRE_COMPACT"
    echo "(Journal file: memory/journal/${TODAY}.md)"
    echo "</system-notice>"
  fi

  echo ""

  # Phase 2: Post-compaction context — should survive compaction
  COMPACT=$(resolve_template "compact")
  if [ -n "$COMPACT" ]; then
    echo "<system-reminder>"
    sed -e "s|{{trigger_name}}|${TRIGGER_NAME}|g" \
        -e "s|{{channel}}|${CHANNEL}|g" \
        "$COMPACT"
    echo "</system-reminder>"
  fi

  # Phase 3: Task context injection for continuity after compaction
  /atlas/app/hooks/task-session.sh prime 2>/dev/null || true

  exit 0
fi

# --- Main session: generic memory flush ---

echo "<system-notice>"
cat << EOF
Manual compaction requested. Consolidate ALL important findings:

1. Write lasting facts, decisions, and preferences to memory/MEMORY.md
2. Write task results and context to memory/journal/${TODAY}.md
3. If a project topic is relevant, create/update memory/projects/
4. If managing a team or coordinating agents, save current task state, decisions, and progress
5. Save any in-flight coordination context that would be lost after compaction

Be thorough — detailed context will be lost after compaction.
EOF
echo "</system-notice>"
