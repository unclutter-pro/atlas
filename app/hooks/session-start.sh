#!/bin/bash
# SessionStart Hook: Loads identity + memory into Claude's context
set -euo pipefail

WORKSPACE="$HOME"
IDENTITY="$WORKSPACE/IDENTITY.md"
SOUL="$WORKSPACE/SOUL.md"
MEMORY="$WORKSPACE/memory/MEMORY.md"
MEMORY_DIR="$WORKSPACE/memory"
DB="$WORKSPACE/.index/atlas.db"

# Helper: emit file content wrapped in XML tag
emit_section() {
  local file="$1" tag="$2"
  if [ -f "$file" ]; then
    echo "<${tag}>"
    cat "$file"
    echo "</${tag}>"
    echo ""
  fi
}

# Only emit memory context here (not part of system prompt)
emit_section "$MEMORY" "long-term-memory"

# Show recent journal entries (titles only)
if [ -d "$MEMORY_DIR/journal" ]; then
  JOURNALS=$(ls -1 "$MEMORY_DIR/journal/"*.md 2>/dev/null | grep -E '/[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$' | sort -r | head -7)
  if [ -n "$JOURNALS" ]; then
    echo "<recent-journals>"
    for j in $JOURNALS; do
      FNAME=$(basename "$j" .md)
      LINES=$(wc -l < "$j" 2>/dev/null || echo "0")
      FIRST=$(head -1 "$j" 2>/dev/null | sed 's/^#\+\s*//')
      echo "  $FNAME ($LINES lines) — $FIRST"
    done
    echo "</recent-journals>"
    echo ""
  fi
fi

# Show pending inbox count (for trigger sessions only — workers get tasks directly)
if [ -f "$DB" ] && [ -z "${ATLAS_WORKER_TASK_ID:-}" ]; then
  PENDING=$(sqlite3 "$DB" "SELECT count(*) FROM tasks WHERE status='pending';" 2>/dev/null || echo "0")
  if [ "$PENDING" -gt 0 ]; then
    echo "<inbox-status>"
    echo "You have $PENDING pending task(s). Use get_next_task() to process them."
    echo "</inbox-status>"
    echo ""
  fi
fi
