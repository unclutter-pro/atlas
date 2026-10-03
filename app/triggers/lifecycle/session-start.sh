#!/bin/bash
# SessionStart Hook: Loads identity + memory into Claude's context
set -euo pipefail

WORKSPACE="$HOME"
MEMORY="$WORKSPACE/memory/MEMORY.md"
MEMORY_DIR="$WORKSPACE/memory"

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

# Emit long-term memory
emit_section "$MEMORY" "long-term-memory"

# Show recent journal entries (titles only)
if [ -d "$MEMORY_DIR/journal" ]; then
  JOURNALS=$(ls -1 "$MEMORY_DIR/journal/"*.md 2>/dev/null | grep -E '/[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$' | sort -r | head -7 || true)
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
