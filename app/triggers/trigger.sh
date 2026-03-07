#!/bin/bash
# Trigger runner: spawns own Claude session per trigger (read-only, filter/escalation)
# Usage: trigger.sh <trigger-name> [payload] [session-key]
#
# Session key determines WHICH session to resume for persistent triggers:
#   - Email: thread ID       → trigger.sh email-handler '{"body":"..."}' 'thread-4821'
#   - Signal: sender number  → trigger.sh signal-chat '{"msg":"Hi"}' '+49170123456'
#   - Webhook: event group   → trigger.sh deploy-hook '{"ref":"main"}' 'repo-myapp'
#   - No key + persistent    → uses "_default" (one global session per trigger)
#   - Ephemeral triggers     → key is ignored, always a new session
#
# For persistent sessions: if the session is already running (IPC socket alive),
# the message is injected directly into the running session via the Claude Code
# IPC socket. No new process is spawned — the message arrives mid-run.
set -euo pipefail

TRIGGER_NAME="${1:?Usage: trigger.sh <trigger-name> [payload] [session-key]}"
DB="$HOME/.index/atlas.db"
WORKSPACE="$HOME"
PROMPT_DIR="/atlas/app/prompts"
LOG="/atlas/logs/trigger-${TRIGGER_NAME}.log"
CLAUDE_JSON="$HOME/.claude.json"

if [ ! -f "$DB" ]; then
  echo "[$(date)] ERROR: Database not found: $DB" >&2
  exit 1
fi

# Disable remote MCP connectors that hang on startup
disable_remote_mcp() {
  [ -f "$CLAUDE_JSON" ] || return 0
  local TMP
  TMP=$(mktemp "${CLAUDE_JSON}.XXXXXX")
  jq '.cachedGrowthBookFeatures.tengu_claudeai_mcp_connectors = false' \
    "$CLAUDE_JSON" > "$TMP" && mv "$TMP" "$CLAUDE_JSON" || rm -f "$TMP"
}

# Safe template substitution using Python (no sed injection risk from payload content)
safe_replace() {
  python3 -c "
import sys
template = sys.stdin.read()
for i in range(1, len(sys.argv), 2):
    template = template.replace(sys.argv[i], sys.argv[i+1])
print(template, end='')
" "$@"
}

# Read trigger from DB
ROW=$(sqlite3 -json "$DB" \
  "SELECT id, name, type, channel, prompt, session_mode, enabled FROM triggers WHERE name='${TRIGGER_NAME//\'/\'\'}' LIMIT 1" 2>/dev/null || echo "[]")

if [ "$ROW" = "[]" ] || [ -z "$ROW" ]; then
  echo "[$(date)] Trigger not found: $TRIGGER_NAME" >&2
  exit 1
fi

ENABLED=$(echo "$ROW" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())[0]['enabled'])" 2>/dev/null || echo "0")
if [ "$ENABLED" != "1" ]; then
  echo "[$(date)] Trigger disabled: $TRIGGER_NAME"
  exit 0
fi

CHANNEL=$(echo "$ROW" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())[0]['channel'])" 2>/dev/null || echo "internal")
PROMPT=$(echo "$ROW" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())[0]['prompt'])" 2>/dev/null || echo "")
SESSION_MODE=$(echo "$ROW" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())[0]['session_mode'] or 'ephemeral')" 2>/dev/null || echo "ephemeral")

# Session key: 3rd argument, defaults to "_default" for persistent triggers
SESSION_KEY="${3:-_default}"

# Fallback: load prompt from workspace file
if [ -z "$PROMPT" ]; then
  PROMPT_FILE="$WORKSPACE/triggers/${TRIGGER_NAME}/prompt.md"
  if [ -f "$PROMPT_FILE" ]; then
    PROMPT=$(cat "$PROMPT_FILE")
  else
    PROMPT="Trigger '${TRIGGER_NAME}' was fired."
  fi
fi

# Optional: second argument is payload (for webhook relay)
PAYLOAD="${2:-}"
# Substitute all placeholders (consistent with IPC inject path)
PROMPT=$(echo -n "$PROMPT" | safe_replace \
  "{{payload}}"      "${PAYLOAD}" \
  "{{sender}}"       "$SESSION_KEY" \
  "{{channel}}"      "$CHANNEL" \
  "{{trigger_name}}" "$TRIGGER_NAME")

# Update trigger stats
sqlite3 "$DB" "UPDATE triggers SET last_run = datetime('now'), run_count = run_count + 1 WHERE name = '${TRIGGER_NAME//\'/\'\'}';"

# --- Persistent session: try IPC socket injection first ---
if [ "$SESSION_MODE" = "persistent" ]; then
  EXISTING_SESSION=$(sqlite3 "$DB" \
    "SELECT session_id FROM trigger_sessions WHERE trigger_name='${TRIGGER_NAME//\'/\'\'}' AND session_key='${SESSION_KEY//\'/\'\'}' LIMIT 1;" 2>/dev/null || echo "")

  if [ -n "$EXISTING_SESSION" ]; then
    # Guard: if the session JSONL ends with a queue-operation entry, the container was
    # killed mid-IPC-inject. Resuming such a session hangs indefinitely — clear it.
    JSONL_PATH=$(python3 -c "
import os, glob
candidates = glob.glob(os.path.expanduser('~/.claude/projects/*/sessions/${EXISTING_SESSION}.jsonl'))
print(candidates[0] if candidates else '')
" 2>/dev/null)
    if [ -n "$JSONL_PATH" ] && [ -f "$JSONL_PATH" ]; then
      LAST_TYPE=$(tail -1 "$JSONL_PATH" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('type',''))" 2>/dev/null || echo "")
      if [ "$LAST_TYPE" = "queue-operation" ]; then
        echo "[$(date)] Corrupted session $EXISTING_SESSION (ended mid-IPC-inject) — clearing, will start fresh" | tee -a "$LOG"
        sqlite3 "$DB" "DELETE FROM trigger_sessions WHERE trigger_name='${TRIGGER_NAME//\'/\'\'}' AND session_key='${SESSION_KEY//\'/\'\'}';" 2>/dev/null || true
        EXISTING_SESSION=""
      fi
    fi
  fi

  if [ -n "$EXISTING_SESSION" ]; then
    SOCKET="/tmp/claudec-${EXISTING_SESSION}.sock"

    if [ -S "$SOCKET" ]; then
      # Session is running — inject message directly via IPC socket
      # Load channel-specific inject template
      INJECT_TEMPLATE=""
      for candidate in "$PROMPT_DIR/trigger-${CHANNEL}-inject.md" "$PROMPT_DIR/trigger-inject.md"; do
        if [ -f "$candidate" ]; then
          INJECT_TEMPLATE="$candidate"
          break
        fi
      done

      if [ -n "$INJECT_TEMPLATE" ]; then
        INJECT_MSG=$(safe_replace "{{trigger_name}}" "$TRIGGER_NAME" \
                                  "{{channel}}" "$CHANNEL" \
                                  "{{sender}}" "$SESSION_KEY" \
                                  "{{payload}}" "${PAYLOAD:-$PROMPT}" \
                                  < "$INJECT_TEMPLATE")
      else
        INJECT_MSG="New message arrived:

${PAYLOAD:-$PROMPT}

Process this message using the channel CLI tools (signal send / email reply) as appropriate."
      fi

      if echo "$INJECT_MSG" | timeout 10 python3 -c "
import socket, json, sys
msg = sys.stdin.read()
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(5)
s.connect(sys.argv[1])
s.sendall(json.dumps({'action': 'send', 'text': msg, 'submit': True}).encode() + b'\n')
s.close()
" "$SOCKET" 2>/dev/null; then
        echo "[$(date)] Injected into running session $EXISTING_SESSION (key=$SESSION_KEY)" | tee -a "$LOG"
        exit 0
      fi
      # Socket exists but connection failed — session is stale, fall through to spawn
      echo "[$(date)] Stale socket for $EXISTING_SESSION, spawning new session" | tee -a "$LOG"
    fi
  fi
fi

# --- Acquire lock before spawning to prevent duplicate sessions ---
# Only the spawn/resume path needs locking. IPC injection (above) is lock-free.
FLOCK_FILE="/tmp/.trigger-${TRIGGER_NAME}-${SESSION_KEY//[^a-zA-Z0-9_]/_}.flock"
exec {LOCK_FD}>"$FLOCK_FILE"
if ! flock -w 60 "$LOCK_FD"; then
  echo "[$(date)] Trigger $TRIGGER_NAME (key=$SESSION_KEY) locked — skipping spawn" | tee -a "$LOG"
  exit 0
fi

# Re-check IPC socket after acquiring lock (first instance may have started the session)
if [ "$SESSION_MODE" = "persistent" ] && [ -n "${EXISTING_SESSION:-}" ]; then
  SOCKET="/tmp/claudec-${EXISTING_SESSION}.sock"
  if [ -S "$SOCKET" ]; then
    INJECT_MSG="${PAYLOAD:-$PROMPT}"
    if [ -n "${INJECT_TEMPLATE:-}" ]; then
      INJECT_MSG=$(safe_replace "{{trigger_name}}" "$TRIGGER_NAME" \
                                "{{channel}}" "$CHANNEL" \
                                "{{sender}}" "$SESSION_KEY" \
                                "{{payload}}" "${PAYLOAD:-$PROMPT}" \
                                < "$INJECT_TEMPLATE")
    fi
    if echo "$INJECT_MSG" | timeout 10 python3 -c "
import socket, json, sys
msg = sys.stdin.read()
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(5)
s.connect(sys.argv[1])
s.sendall(json.dumps({'action': 'send', 'text': msg, 'submit': True}).encode() + b'\n')
s.close()
" "$SOCKET" 2>/dev/null; then
      echo "[$(date)] Injected into session after lock wait $EXISTING_SESSION (key=$SESSION_KEY)" | tee -a "$LOG"
      exit 0
    fi
  fi
fi

echo "[$(date)] Trigger firing: $TRIGGER_NAME (mode=$SESSION_MODE, key=$SESSION_KEY, channel=$CHANNEL)" | tee -a "$LOG"

TRIGGER_START=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Track this run in trigger_runs for crash recovery
RUN_ID=$(sqlite3 "$DB" "INSERT INTO trigger_runs (trigger_name, session_key, session_mode, payload) \
  VALUES ('${TRIGGER_NAME//\'/\'\'}', '${SESSION_KEY//\'/\'\'}', '${SESSION_MODE//\'/\'\'}', '$(echo "$PAYLOAD" | sed "s/'/''/g")'); \
  SELECT last_insert_rowid();" 2>/dev/null || echo "")

# Build Claude command
disable_remote_mcp
CLAUDE_BASE_ARGS=(-p --dangerously-skip-permissions)
CLAUDE_ARGS=("${CLAUDE_BASE_ARGS[@]}")

if [ "$SESSION_MODE" = "persistent" ] && [ -n "${EXISTING_SESSION:-}" ]; then
  CLAUDE_ARGS+=(--resume "$EXISTING_SESSION")
  echo "[$(date)] Resuming session for key=$SESSION_KEY: $EXISTING_SESSION" | tee -a "$LOG"
elif [ "$SESSION_MODE" = "persistent" ]; then
  echo "[$(date)] New persistent session for key=$SESSION_KEY" | tee -a "$LOG"
fi

# Spawn trigger's own Claude session
# ATLAS_TRIGGER env var tells hooks this is a trigger session (read-only)
# claude-atlas wrapper injects system prompt based on --mode trigger
# Use --output-format json to reliably capture the session ID (avoids race with concurrent triggers)
TRIGGER_OUT=$(mktemp /tmp/trigger-out-XXXXXX.json)

# Unset CLAUDECODE so spawning a trigger session while a worker is running doesn't fail
# with "Claude Code cannot be launched inside another Claude Code session"
# Timeout: 5 minutes to prevent stuck sessions from holding the flock indefinitely
TRIGGER_TIMEOUT="${TRIGGER_TIMEOUT:-300}"
TRIGGER_EXIT=0
timeout "$TRIGGER_TIMEOUT" env \
  ATLAS_TRIGGER="$TRIGGER_NAME" ATLAS_TRIGGER_CHANNEL="$CHANNEL" ATLAS_TRIGGER_SESSION_KEY="$SESSION_KEY" \
  -u CLAUDECODE \
  claude-atlas --mode trigger "${CLAUDE_ARGS[@]}" --output-format json "$PROMPT" < /dev/null > "$TRIGGER_OUT" 2>>"$LOG" || TRIGGER_EXIT=$?

# Handle timeout (exit code 124) — kill stale session and retry fresh
if [ "$TRIGGER_EXIT" -eq 124 ]; then
  echo "[$(date)] TIMEOUT after ${TRIGGER_TIMEOUT}s for session ${EXISTING_SESSION:-new} — clearing and retrying" | tee -a "$LOG"
  if [ -n "${EXISTING_SESSION:-}" ]; then
    sqlite3 "$DB" "DELETE FROM trigger_sessions WHERE trigger_name='${TRIGGER_NAME//\'/\'\'}' AND session_key='${SESSION_KEY//\'/\'\'}';" 2>/dev/null || true
    rm -f "/tmp/claudec-${EXISTING_SESSION}.sock"
  fi
  TRIGGER_EXIT=0
  timeout "$TRIGGER_TIMEOUT" env \
    ATLAS_TRIGGER="$TRIGGER_NAME" ATLAS_TRIGGER_CHANNEL="$CHANNEL" ATLAS_TRIGGER_SESSION_KEY="$SESSION_KEY" \
    -u CLAUDECODE \
    claude-atlas --mode trigger "${CLAUDE_BASE_ARGS[@]}" --output-format json "$PROMPT" < /dev/null > "$TRIGGER_OUT" 2>>"$LOG" || TRIGGER_EXIT=$?
fi

# If resume failed (non-timeout), retry as fresh session (stale/corrupted session that wasn't caught above)
if [ "$TRIGGER_EXIT" -ne 0 ] && [ "$TRIGGER_EXIT" -ne 124 ] && [ -n "${EXISTING_SESSION:-}" ]; then
  echo "[$(date)] Resume failed (exit=$TRIGGER_EXIT) for session $EXISTING_SESSION — retrying as fresh session" | tee -a "$LOG"
  sqlite3 "$DB" "DELETE FROM trigger_sessions WHERE trigger_name='${TRIGGER_NAME//\'/\'\'}' AND session_key='${SESSION_KEY//\'/\'\'}';" 2>/dev/null || true
  TRIGGER_EXIT=0
  timeout "$TRIGGER_TIMEOUT" env \
    ATLAS_TRIGGER="$TRIGGER_NAME" ATLAS_TRIGGER_CHANNEL="$CHANNEL" ATLAS_TRIGGER_SESSION_KEY="$SESSION_KEY" \
    -u CLAUDECODE \
    claude-atlas --mode trigger "${CLAUDE_BASE_ARGS[@]}" --output-format json "$PROMPT" < /dev/null > "$TRIGGER_OUT" 2>>"$LOG" || TRIGGER_EXIT=$?
fi

# Log the text result from JSON output
python3 -c "
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    print(data.get('result', ''))
except: pass
" "$TRIGGER_OUT" >> "$LOG"

# For persistent sessions: extract session ID from structured output (race-free)
if [ "$SESSION_MODE" = "persistent" ]; then
  NEW_SESSION_ID=$(python3 -c "
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    print(data.get('session_id', ''))
except: print('')
" "$TRIGGER_OUT" 2>/dev/null)

  if [ -n "$NEW_SESSION_ID" ]; then
    sqlite3 "$DB" "INSERT INTO trigger_sessions (trigger_name, session_key, session_id) \
      VALUES ('${TRIGGER_NAME//\'/\'\'}', '${SESSION_KEY//\'/\'\'}', '${NEW_SESSION_ID//\'/\'\'}') \
      ON CONFLICT(trigger_name, session_key) DO UPDATE SET session_id='${NEW_SESSION_ID//\'/\'\'}', updated_at=datetime('now');"
    echo "[$(date)] Saved session for key=$SESSION_KEY: $NEW_SESSION_ID" | tee -a "$LOG"
  fi
fi

TRIGGER_END=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
python3 - "$TRIGGER_OUT" "$TRIGGER_NAME" "$TRIGGER_START" "$TRIGGER_END" "$TRIGGER_EXIT" << 'PYEOF'
import json, sys, sqlite3, os
f, tname, started, ended, exit_code = sys.argv[1:]
try:
    d = json.load(open(f))
except:
    d = {}
usage = d.get('usage') or {}
db_path = os.environ.get('HOME', '') + '/.index/atlas.db'
conn = sqlite3.connect(db_path)
conn.execute('''INSERT OR IGNORE INTO session_metrics
  (session_type, session_id, trigger_name, started_at, ended_at,
   duration_ms, input_tokens, output_tokens, cache_read_tokens,
   cache_creation_tokens, cost_usd, num_turns, is_error)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
    'trigger',
    d.get('session_id', '') or '',
    tname,
    started, ended,
    int(d.get('duration_ms') or 0),
    int(usage.get('input_tokens') or 0),
    int(usage.get('output_tokens') or 0),
    int(usage.get('cache_read_input_tokens') or 0),
    int(usage.get('cache_creation_input_tokens') or 0),
    float(d.get('total_cost_usd') or d.get('cost_usd') or 0),
    int(d.get('num_turns') or 0),
    1 if str(exit_code) != '0' else 0,
))
conn.commit()
conn.close()
PYEOF

# Mark run as completed + record session_id
if [ -n "${RUN_ID:-}" ]; then
  RUN_SESSION_ID=$(python3 -c "
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    print(data.get('session_id', ''))
except: print('')
" "$TRIGGER_OUT" 2>/dev/null)
  sqlite3 "$DB" "UPDATE trigger_runs SET session_id='${RUN_SESSION_ID//\'/\'\'}', completed_at=datetime('now') WHERE id=$RUN_ID;" 2>/dev/null || true
fi

rm -f "$TRIGGER_OUT"

echo "[$(date)] Trigger done: $TRIGGER_NAME (key=$SESSION_KEY)" | tee -a "$LOG"
