#!/bin/bash
# Stop Hook: Session lifecycle management
# Task completion gate is handled by task-session.sh check.
set -euo pipefail

# Capture the hook payload from stdin (Claude Code passes JSON with
# session_id, transcript_path, stop_hook_active, …). Read it once, up front,
# before anything else might consume stdin. The `timeout` guards against ever
# hanging this hook if stdin is left open — it runs on every session stop, so a
# hang would freeze the session. Fail-open (empty) if there is no payload.
HOOK_INPUT="$(timeout 5 cat 2>/dev/null || true)"
STOP_HOOK_ACTIVE="$(printf '%s' "$HOOK_INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)"

# --- Kill-switch: ATLAS_TASKS_DISABLE_GATE=1 skips task enforcement ---
if [ "${ATLAS_TASKS_DISABLE_GATE:-0}" = "1" ]; then
  echo "WARNING: ATLAS_TASKS_DISABLE_GATE=1 — task gate disabled, allowing stop" >&2
  exit 0
fi

# --- Task completion gate (trigger sessions) ---
if [ -n "${ATLAS_TRIGGER:-}" ] && [ -n "${ATLAS_TRIGGER_SESSION_KEY:-}" ]; then
  CHECK_OUTPUT=$(/atlas/app/hooks/task-session.sh check 2>/dev/null) || true
  if [ -n "$CHECK_OUTPUT" ]; then
    echo "$CHECK_OUTPUT"
    exit 0
  fi
fi

# --- Signal-send guard (interactive chat sessions) ---
# In an interactive Signal session the agent must explicitly run `signal send`
# to deliver its reply — the harness does NOT auto-send the assistant's prose.
# A reply that is composed but never sent leaves the user waiting (the recurring
# "Hello?" / "Und?" nudges). Ground truth lives in the Signal DB: if the last
# message in this conversation is still inbound, no reply has gone out.
#
# We block at most once per turn: the `stop_hook_active` guard means that if the
# agent genuinely has nothing to send (already replied, or the message was just
# an acknowledgement), the immediately following stop is allowed through instead
# of looping forever. `signal needs-reply` exits 0 only when a reply is pending,
# and fails open (non-zero) on any error, so a broken check never traps the agent.
if [ "${ATLAS_TRIGGER_CHANNEL:-}" = "signal" ] \
  && [ -n "${ATLAS_TRIGGER_SESSION_KEY:-}" ] \
  && [ "$STOP_HOOK_ACTIVE" != "true" ]; then
  if /atlas/app/bin/signal needs-reply "$ATLAS_TRIGGER_SESSION_KEY" >/dev/null 2>&1; then
    jq -n '{
      decision: "block",
      reason: "You are in an interactive Signal chat and the last message in this conversation is from the user — you have not sent a reply yet. Signal replies are NOT auto-delivered: you must actually run `signal send \"<number>\" \"<message>\"` for the user to receive anything. If you composed a reply but did not send it, send it now. If no reply is needed (you already answered, or the message was purely an acknowledgement/informational), you may stop — this check fires only once."
    }'
    exit 0
  fi
fi

# --- Trigger sessions: remind to write a journal if today's entry doesn't exist ---
if [ -n "${ATLAS_TRIGGER:-}" ]; then
  TODAY=$(date +%Y-%m-%d)
  JOURNAL_DIR="$HOME/memory/journal"
  if [ -d "$JOURNAL_DIR" ] && ls "$JOURNAL_DIR/${TODAY}"*.md 1>/dev/null 2>&1; then
    : # Journal already exists for today
  else
    echo "<system-notice>"
    echo "JOURNAL REMINDER: You have not written a journal entry for today ($TODAY)."
    echo "Before ending this session, please write your daily journal to: memory/journal/${TODAY}.md"
    echo "Include: key activities, task results, decisions made, and anything to carry forward."
    echo "</system-notice>"
  fi
fi

exit 0
