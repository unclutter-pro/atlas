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
  DECISION=$(jq -n --arg reason "$OUTPUT" '{decision: "block", reason: $reason}' 2>&1) || {
    echo "ERROR: jq failed to render the block decision ($DECISION) — blocking with a fixed reason instead" >&2
    DECISION='{"decision": "block", "reason": "Session end blocked: the task gate reported open work, but jq failed to render the reason. Run `task list` and `task goal list` to check before ending the session."}'
  }
  echo "$DECISION"
elif [ -n "$OUTPUT" ]; then
  echo "$OUTPUT"
fi
exit 0
