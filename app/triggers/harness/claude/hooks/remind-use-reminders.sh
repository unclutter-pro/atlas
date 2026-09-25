#!/usr/bin/env bash
# Claude Code PreToolUse(Bash) hook: Atlas' command advice (lifecycle/
# command-advice.sh) as hookSpecificOutput.additionalContext.
# Strictly non-blocking: always exits 0, even on internal error, so it can
# never break a Bash tool call.
set -u

LIFECYCLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../lifecycle" 2>/dev/null && pwd)" || exit 0
input=$(cat 2>/dev/null) || exit 0
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0
[ -z "$cmd" ] && exit 0

msg=$("$LIFECYCLE_DIR/command-advice.sh" "$cmd" 2>/dev/null) || exit 0
[ -z "$msg" ] && exit 0

jq -n --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$m}}' 2>/dev/null || true
exit 0
