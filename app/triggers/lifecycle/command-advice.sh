#!/usr/bin/env bash
# Lifecycle policy: before the agent runs a shell command.
# Usage: command-advice.sh "<command>" ["<run_in_background>"] ["<channel>"]
# Output: advice text for the agent, or a block reason. Exit 0 = allow
# (stdout is advice or empty), exit 2 = block (stdout is the reason).
#
# When a command looks like it polls/waits on an event (loop+sleep, a long
# standalone sleep, or a --watch/-w flag), nudge toward the reminder CLI.
# Atlas is event-driven by design ("no polling") — this keeps that contract.
#
# In a live chat session (channel is a messaging channel: signal, whatsapp,
# telegram, web) a foreground blocking wait is worse than brittle: inbound
# messages are only delivered to the agent at the next tool boundary (see
# docs/watcher.md), so the whole wait makes the session deaf to the user.
# There, unless the command is already backgrounded (run_in_background),
# block it instead of just advising.
set -u

cmd="${1:-}"
bg="${2:-false}"
channel="${3:-}"
[ -z "$cmd" ] && exit 0

match=0
# 1) Polling loop: a while/for/until loop that also contains a sleep (grep -q is
#    per-line, so it matches even when the loop spans multiple lines).
if printf '%s' "$cmd" | grep -qE '\b(while|for|until)\b' 2>/dev/null \
   && printf '%s' "$cmd" | grep -qE '\bsleep\b' 2>/dev/null; then
  match=1
fi
# 2) Long standalone wait: sleep >= 60s, or any m/h/d duration (e.g. 5m, 2h).
#    Substring match, so this also catches it inside a loop body or a
#    "cmd1 && sleep 600 && cmd2" chain.
if printf '%s' "$cmd" | grep -qE '\bsleep[[:space:]]+([0-9]{3,}|[6-9][0-9]|[0-9]+(\.[0-9]+)?[mhd])\b' 2>/dev/null; then
  match=1
fi
# 3) gh --watch: blocks until a run/deploy finishes.
if printf '%s' "$cmd" | grep -qE '\bgh\b.*--watch\b' 2>/dev/null; then
  match=1
fi
# 4) kubectl --watch/-w: blocks streaming until interrupted.
if printf '%s' "$cmd" | grep -qE '\bkubectl\b.*(--watch\b|[[:space:]]-w\b)' 2>/dev/null; then
  match=1
fi
# 5) timeout bounding a wait at >= 60s (same duration grammar as sleep above).
if printf '%s' "$cmd" | grep -qE '\btimeout[[:space:]]+([0-9]{3,}|[6-9][0-9]|[0-9]+(\.[0-9]+)?[mhd])\b' 2>/dev/null; then
  match=1
fi

[ "$match" -eq 0 ] && exit 0

ADVICE="This command polls, sleeps, or watches to wait. If you are WAITING ON AN EVENT (CI, deploy, a file landing, an email reply), do NOT poll in a foreground or background shell -- it is brittle and can silently miss the event. Use the reminder CLI so the session is re-woken reliably: reminder add --when-script-ok=<cmd-that-exits-0-when-ready> (event/CI), --when-reply-to=<thread-id> (email reply), or --at=<time> (wall-clock). Ignore this if the wait is just a short in-task pause."

case "$channel" in
  signal | whatsapp | telegram | web)
    if [ "$bg" != "true" ]; then
      echo "Blocked: this is a foreground blocking wait in a live chat session (channel=$channel). Inbound messages are only delivered to you at the next tool boundary, so this command would make you deaf to the user for its whole duration -- they already sent messages into this gap before and had to restart the session. Re-run the same command with run_in_background: true (then keep working and you'll be notified when it finishes), or use 'reminder add --when-script-ok=<cmd> | --when-reply-to=<thread> | --at=<time>' to be woken reliably instead of waiting inline."
      exit 2
    fi
    ;;
esac

echo "$ADVICE"
exit 0
