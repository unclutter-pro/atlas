#!/bin/bash
# Claude Code Stop hook: Atlas' stop policy in Claude's hook protocol.
# lifecycle/stop.sh exits 2 with a reason to keep the agent working; Claude
# Code expects {"decision":"block","reason":...} for that.
set -uo pipefail

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIFECYCLE_DIR="$HOOKS_DIR/../../../lifecycle"

# The validator's format gate needs the final message from the transcript.
if [ "${ATLAS_TRIGGER_CHANNEL:-}" = "validator" ]; then
  cat | bun "$HOOKS_DIR/validator-stop-check.ts" 2>/dev/null || true
  exit 0
fi

CODE=0
OUTPUT=$("$LIFECYCLE_DIR/stop.sh" </dev/null) || CODE=$?
if [ "$CODE" -eq 2 ]; then
  jq -n --arg reason "$OUTPUT" '{decision: "block", reason: $reason}'
elif [ -n "$OUTPUT" ]; then
  echo "$OUTPUT"
fi
exit 0
