#!/usr/bin/env bash
# Claude Code PreToolUse(Bash) hook: Atlas' command advice (lifecycle/command-advice.sh) as additionalContext, or permissionDecision:"deny" when it blocks a foreground wait in a live chat session. Fails open to allow on any error.
set -u

LIFECYCLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../lifecycle" 2>/dev/null && pwd)" || exit 0
input=$(cat 2>/dev/null) || exit 0
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0
[ -z "$cmd" ] && exit 0
bg=$(printf '%s' "$input" | jq -r '.tool_input.run_in_background // false' 2>/dev/null) || bg=false
# agent_id is set only inside a subagent/teammate, never the main session.
agent_id=$(printf '%s' "$input" | jq -r '.agent_id // ""' 2>/dev/null) || agent_id=""
is_subagent=false
[ -n "$agent_id" ] && is_subagent=true

CODE=0
msg=$("$LIFECYCLE_DIR/command-advice.sh" "$cmd" "$bg" "${ATLAS_TRIGGER_CHANNEL:-}" "$is_subagent" 2>/dev/null) || CODE=$?
[ -z "$msg" ] && exit 0

if [ "$CODE" -eq 2 ]; then
  DECISION=$(jq -n --arg reason "$msg" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}' 2>&1) || {
    echo "ERROR: jq failed to render the deny decision ($DECISION) — denying with a fixed reason instead" >&2
    DECISION='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked: foreground blocking wait in a live chat session. Re-run with run_in_background: true, or use the reminder CLI instead."}}'
  }
  echo "$DECISION"
  exit 0
fi

jq -n --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$m}}' 2>/dev/null || true
exit 0
