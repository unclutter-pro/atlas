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

# --- Reply-send guard (interactive reply channels: Signal, Email) ---
# On these channels the agent must explicitly run a send command to deliver its
# reply — the harness does NOT auto-deliver the assistant's prose. A reply that
# is composed but never sent leaves the correspondent waiting (the recurring
# Signal "Hello?" / "Und?" nudges; the same applies to email threads).
#
# Ground truth lives in each channel's own DB: `<channel> needs-reply <key>`
# exits 0 only when the newest message in the conversation is still inbound
# (i.e. no reply went out this turn), and fails open (non-zero) on any error.
# We then block ONCE — a single reminder. The `stop_hook_active` guard means
# that if no reply is actually needed (already answered, triaged/archived, or a
# pure acknowledgement), the immediately following stop is allowed through
# instead of looping. There are legitimate no-reply cases, so this never hard-
# gates: it just makes sure "composed but not sent" can't pass silently.
REPLY_BIN=""
REPLY_NOUN=""
REPLY_HINT=""
case "${ATLAS_TRIGGER_CHANNEL:-}" in
  signal) REPLY_BIN="/atlas/app/bin/signal" ; REPLY_NOUN="Signal chat"   ; REPLY_HINT='signal send "<number>" "<message>"' ;;
  email)  REPLY_BIN="/atlas/app/bin/email"  ; REPLY_NOUN="email thread"  ; REPLY_HINT='email reply "<thread-id>" "<message>"' ;;
esac
if [ -n "$REPLY_BIN" ] \
  && [ -n "${ATLAS_TRIGGER_SESSION_KEY:-}" ] \
  && [ "$STOP_HOOK_ACTIVE" != "true" ]; then
  if "$REPLY_BIN" needs-reply "$ATLAS_TRIGGER_SESSION_KEY" >/dev/null 2>&1; then
    jq -n --arg noun "$REPLY_NOUN" --arg hint "$REPLY_HINT" '{
      decision: "block",
      reason: ("You are handling an interactive " + $noun + " and the newest message in this conversation is from the other person — you have not sent a reply this turn. The user only sees what you actually deliver with `" + $hint + "`; the prose in your turn is NOT delivered to them. If you have a reply ready, send it now. If no reply is needed — you already answered, you triaged/archived the thread, or it was a pure acknowledgement — you may stop; this reminder fires only once.")
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
