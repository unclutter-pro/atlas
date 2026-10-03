#!/bin/bash
# Lifecycle policy: before context compaction — memory flush instructions.
# Usage: pre-compact.sh auto|manual   (manual: the user asked for it; be thorough)
# Output: context text for the agent.
# For trigger sessions: channel-specific pre-compact + compact templates.
# For the main session: generic memory flush instructions.
set -euo pipefail

MODE="${1:-auto}"
TODAY=$(date +%Y-%m-%d)
PROMPT_DIR="/atlas/app/prompts"
LIFECYCLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

  # Phase 1: Pre-compaction — save state to memory
  PRE_COMPACT=$(resolve_template "pre-compact")
  if [ -n "$PRE_COMPACT" ]; then
    echo "<system-notice>"
    if [ "$MODE" = "manual" ]; then
      echo "Manual compaction requested. Be thorough — detailed context will be lost."
      echo ""
    fi
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
  "$LIFECYCLE_DIR/task-session.sh" prime 2>/dev/null || true

  exit 0
fi

# --- Main session: generic memory flush ---

echo "<system-notice>"
if [ "$MODE" = "manual" ]; then
cat << EOF
Manual compaction requested. Consolidate ALL important findings:

1. Write lasting facts, decisions, and preferences to memory/MEMORY.md
2. Write task results and context to memory/journal/${TODAY}.md
3. If a project topic is relevant, create/update memory/projects/
4. If managing a team or coordinating agents, save current task state, decisions, and progress
5. Save any in-flight coordination context that would be lost after compaction

Be thorough — detailed context will be lost after compaction.
EOF
else
cat << EOF
Context is about to be compressed. Consolidate important findings:

1. Write lasting facts, decisions, and preferences to memory/MEMORY.md
2. Write task results and daily context to memory/journal/${TODAY}.md
3. If a project topic is relevant, create/update a file in memory/projects/
4. If managing a team or coordinating agents, save current task state, decisions, and progress
5. Save any in-flight coordination context that would be lost after compaction

MEMORY.md is for long-term, timeless information. The journal is for daily details (append-only).
Only write what is truly relevant, no noise. Perform the memory flush now.
EOF
fi
echo "</system-notice>"
