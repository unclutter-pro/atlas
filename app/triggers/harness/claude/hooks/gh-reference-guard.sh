#!/usr/bin/env bash
# Claude Code PreToolUse(Bash) hook: Atlas' gh-reference-guard (lifecycle/gh-reference-guard.ts)
# as permissionDecision:"deny" when a gh command would post a reference to a private repo into
# a public one. Silent otherwise. Fails open to allow on any error.
set -u

LIFECYCLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../lifecycle" 2>/dev/null && pwd)" || exit 0
input=$(cat 2>/dev/null) || exit 0
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0
[ -z "$cmd" ] && exit 0
cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null) || cwd=""
[ -z "$cwd" ] && cwd="$PWD"

CODE=0
msg=$(bun "$LIFECYCLE_DIR/gh-reference-guard.ts" "$cmd" "$cwd" 2>/dev/null) || CODE=$?
[ "$CODE" -ne 2 ] && exit 0
[ -z "$msg" ] && exit 0

DECISION=$(jq -n --arg reason "$msg" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}' 2>&1) || {
  echo "ERROR: jq failed to render the deny decision ($DECISION) — denying with a fixed reason instead" >&2
  DECISION='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked: this command would post a reference to a private repo into a public repo. Drop the reference or describe it generically instead. If the referenced repo is actually public, prefix the command with GH_REF_GUARD_OK=1."}}'
}
echo "$DECISION"
exit 0
