#!/usr/bin/env bash
# PreToolUse(Bash) advisory: when a command looks like it polls/waits on an
# event (loop+sleep, or a long standalone sleep), nudge toward the reminder CLI.
# Atlas is event-driven by design ("no polling") — this keeps that contract.
#
# Strictly non-blocking: emits hookSpecificOutput.additionalContext and always
# exits 0, even on internal error, so it can never break a Bash tool call.
set -u

input=$(cat 2>/dev/null) || exit 0
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0
[ -z "$cmd" ] && exit 0

match=0
# 1) Polling loop: a while/for/until loop that also contains a sleep (grep -q is
#    per-line, so it matches even when the loop spans multiple lines).
if printf '%s' "$cmd" | grep -qE '\b(while|for|until)\b' 2>/dev/null \
   && printf '%s' "$cmd" | grep -qE '\bsleep\b' 2>/dev/null; then
  match=1
fi
# 2) Long standalone wait: sleep >= 60s, or any m/h/d duration (e.g. 5m, 2h).
if printf '%s' "$cmd" | grep -qE '\bsleep[[:space:]]+([0-9]{3,}|[6-9][0-9]|[0-9]+(\.[0-9]+)?[mhd])\b' 2>/dev/null; then
  match=1
fi

[ "$match" -eq 0 ] && exit 0

msg="This command polls/sleeps to wait. If you are WAITING ON AN EVENT (CI, deploy, a file landing, an email reply), do NOT poll in a background shell -- it is brittle and can silently miss the event. Use the reminder CLI so the session is re-woken reliably: reminder add --when-script-ok=<cmd-that-exits-0-when-ready> (event/CI), --when-reply-to=<thread-id> (email reply), or --at=<time> (wall-clock). Ignore this if the sleep is just a short in-task pause."

jq -n --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$m}}' 2>/dev/null || true
exit 0
