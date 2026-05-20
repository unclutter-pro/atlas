#!/bin/bash
# PostCompact Hook: Re-inject task context after context compaction.
# Outputs a compact <task-context> block with a hard 2KB limit.
set -euo pipefail

if [ -n "${ATLAS_TRIGGER:-}" ] && [ -n "${ATLAS_TRIGGER_SESSION_KEY:-}" ]; then
  /atlas/app/hooks/task-session.sh post-compact 2>/dev/null || true
fi

exit 0
