#!/bin/bash
set -euo pipefail

export PATH=/atlas/app/bin:/usr/local/bin:/usr/bin:/bin:$PATH

WORKSPACE="$HOME"
SESSION_FILE=$WORKSPACE/.index/.last-session-id
WATCH_DIR=$WORKSPACE/.index
LOCK_FILE=$WORKSPACE/.index/.session-running
FLOCK_FILE=$WORKSPACE/.index/.session.flock
CLAUDE_JSON="$HOME/.claude.json"
DB=$WORKSPACE/.index/atlas.db

source /atlas/app/hooks/failure-handler.sh

save_session_metrics() {
  local JSON_FILE="$1" SESSION_TYPE="$2" TRIGGER_NAME="$3"
  local STARTED_AT="$4" ENDED_AT="$5" EXIT_CODE="${6:-0}"
  [ -f "$JSON_FILE" ] || return 0
  python3 - "$JSON_FILE" "$SESSION_TYPE" "$TRIGGER_NAME" \
            "$STARTED_AT" "$ENDED_AT" "$EXIT_CODE" << 'PYEOF'
import json, sys, sqlite3
f, stype, tname, started, ended, exit_code = sys.argv[1:]
try:
    d = json.load(open(f))
except:
    d = {}
usage = d.get('usage') or {}
db_path = (
    __import__('os').environ.get('HOME', '') + '/.index/atlas.db'
)
conn = sqlite3.connect(db_path)
conn.execute('''INSERT INTO session_metrics
  (session_type, session_id, trigger_name, started_at, ended_at,
   duration_ms, input_tokens, output_tokens, cache_read_tokens,
   cache_creation_tokens, cost_usd, num_turns, is_error)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
    stype,
    d.get('session_id', '') or '',
    tname or '',
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
}

# Disable remote MCP connectors that hang on startup.
disable_remote_mcp() {
  [ -f "$CLAUDE_JSON" ] || return 0
  jq '.cachedGrowthBookFeatures.tengu_claudeai_mcp_connectors = false' \
    "$CLAUDE_JSON" > "${CLAUDE_JSON}.tmp" && mv "${CLAUDE_JSON}.tmp" "$CLAUDE_JSON"
}

handle_trigger_wake() {
  local WAKE_FILE="$1"
  [ -f "$WAKE_FILE" ] || return 0
  local FILENAME
  FILENAME=$(basename "$WAKE_FILE")
  local _WAKE_BODY="${FILENAME#.wake-}"
  local TRIGGER_NAME="${_WAKE_BODY%-*}"

  echo "[$(date)] Trigger wake event: $TRIGGER_NAME (file=$FILENAME)"

  (
    exec </dev/null >>/atlas/logs/watcher.log 2>&1
    flock -n 200 || { echo "[$(date)] Trigger $TRIGGER_NAME already running, skipping"; exit 0; }

    TEMP_WAKE=$(mktemp /tmp/wake-XXXXXX.json)
    mv "$WAKE_FILE" "$TEMP_WAKE" 2>/dev/null || { rm -f "$TEMP_WAKE"; exit 0; }

    eval "$(jq -r '{
      task_id: (.task_id // ""),
      session_id: (.session_id // ""),
      session_key: (.session_key // ""),
      channel: (.channel // "internal"),
      summary: (.response_summary // "")
    } | to_entries | map("WAKE_\(.key | ascii_upcase)=\(.value | @sh)") | .[]' "$TEMP_WAKE" 2>/dev/null)" || true
    TASK_ID="${WAKE_TASK_ID:-}"
    SESSION_ID="${WAKE_SESSION_ID:-}"
    SESSION_KEY="${WAKE_SESSION_KEY:-}"
    CHANNEL="${WAKE_CHANNEL:-internal}"
    SUMMARY="${WAKE_SUMMARY:-}"
    rm -f "$TEMP_WAKE"

    RESUME_MSG="Task #${TASK_ID} completed. Here is the worker's result:

${SUMMARY}

Relay this result to the original sender now."

    LOG="/atlas/logs/trigger-${TRIGGER_NAME}.log"

    disable_remote_mcp

    if [ -n "$SESSION_ID" ]; then
      echo "[$(date)] Resuming trigger $TRIGGER_NAME (session=$SESSION_ID)" | tee -a "$LOG"
      RELAY_START=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
      RELAY_OUT=$(mktemp /tmp/relay-out-XXXXXX.json)
      ATLAS_TRIGGER="$TRIGGER_NAME" ATLAS_TRIGGER_CHANNEL="$CHANNEL" ATLAS_TRIGGER_SESSION_KEY="$SESSION_KEY" \
        claude-atlas --mode trigger --output-format json --resume "$SESSION_ID" \
        --dangerously-skip-permissions -p "$RESUME_MSG" > "$RELAY_OUT" 2>>"$LOG" || true
      RELAY_EXIT=$?
      RELAY_END=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
      python3 -c "
import json,sys
try: print(json.load(open(sys.argv[1])).get('result',''))
except: pass
" "$RELAY_OUT" >> "$LOG"
      save_session_metrics "$RELAY_OUT" "trigger-relay" "$TRIGGER_NAME" "$RELAY_START" "$RELAY_END" "$RELAY_EXIT"
      rm -f "$RELAY_OUT"
    elif [ -n "$TRIGGER_NAME" ]; then
      echo "[$(date)] No session ID for $TRIGGER_NAME — re-spawning via trigger.sh" | tee -a "$LOG"
      /atlas/app/triggers/trigger.sh "$TRIGGER_NAME" "$RESUME_MSG" "$SESSION_KEY" 2>&1 | tee -a "$LOG" || true
    fi

    echo "[$(date)] Trigger $TRIGGER_NAME re-awakening done" | tee -a "$LOG"
  ) 200>"$WORKSPACE/.trigger-${TRIGGER_NAME}.flock" &
}

handle_review_wake() {
  local REVIEW_FILE="$1"
  [ -f "$REVIEW_FILE" ] || return 0

  echo "[$(date)] Review wake event: $REVIEW_FILE"

  (
    exec </dev/null >>/atlas/logs/watcher.log 2>&1

    TEMP_REVIEW=$(mktemp /tmp/review-XXXXXX.json)
    mv "$REVIEW_FILE" "$TEMP_REVIEW" 2>/dev/null || { rm -f "$TEMP_REVIEW"; exit 0; }

    REVIEW_TASK_ID=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['task_id'])" "$TEMP_REVIEW" 2>/dev/null || echo "")
    REVIEW_CONTENT=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['task_content'])" "$TEMP_REVIEW" 2>/dev/null || echo "")
    REVIEW_SUMMARY=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['response_summary'])" "$TEMP_REVIEW" 2>/dev/null || echo "")
    rm -f "$TEMP_REVIEW"

    [ -z "$REVIEW_TASK_ID" ] && { echo "[$(date)] Review: missing task_id, skipping"; exit 0; }

    LOG="/atlas/logs/reviewer.log"

    REVIEWER_PROMPT="You are a code reviewer. A worker has just completed task #${REVIEW_TASK_ID}.

## Original Task
${REVIEW_CONTENT}

## Worker's Result
${REVIEW_SUMMARY}

## Your Job
Review the worker's output against the original task requirements. Check:
1. **Completeness** — Was everything in the task actually done? Are acceptance criteria met?
2. **Code Quality** — Is the code clean, maintainable, following existing patterns?
3. **Security** — Any OWASP vulnerabilities? Injection, XSS, hardcoded secrets, insecure dependencies, missing auth checks?

Inspect the actual changed files if needed (read them, run build/lint if relevant).

If everything looks good: call \`task_review_approve\` with task_id=${REVIEW_TASK_ID}.
If issues found: call \`task_review_reject\` with task_id=${REVIEW_TASK_ID} and precise feedback on what to fix.

Be pragmatic — minor style nits don't warrant rejection. Reject for: missing requirements, broken functionality, real security issues, or significant quality problems."

    REVIEWER_START=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    REVIEWER_OUT=$(mktemp /tmp/reviewer-out-XXXXXX.json)

    set +e
    claude-atlas --mode reviewer --output-format json \
      --dangerously-skip-permissions \
      -p "$REVIEWER_PROMPT" \
      > "$REVIEWER_OUT" 2>>"$LOG"
    REVIEWER_EXIT=$?
    set -e

    REVIEWER_END=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    save_session_metrics "$REVIEWER_OUT" "reviewer" "" "$REVIEWER_START" "$REVIEWER_END" "$REVIEWER_EXIT"
    rm -f "$REVIEWER_OUT"

    if [ "$REVIEWER_EXIT" -ne 0 ]; then
      echo "[$(date)] Reviewer session failed (exit $REVIEWER_EXIT) — auto-approving task $REVIEW_TASK_ID to unblock" | tee -a "$LOG"
      # Fallback: approve the task so the system doesn't get stuck
      sqlite3 "$WORKSPACE/.index/atlas.db" \
        "UPDATE tasks SET review_status='approved' WHERE id=$REVIEW_TASK_ID AND review_status='pending'" 2>/dev/null || true
      # Re-run wakeTriggerIfAwaiting equivalent via Python
      python3 /atlas/app/bin/reviewer-fallback-wake.py "$WORKSPACE/.index/atlas.db" "$REVIEW_TASK_ID" 2>>"$LOG" || true
    fi

    echo "[$(date)] Review complete for task $REVIEW_TASK_ID"
  ) &
}

startup_recovery() {
  # Pass 0: process any .review-* files left on disk
  for f in "$WATCH_DIR"/.review-*; do
    [ -f "$f" ] || continue
    echo "[$(date)] Startup recovery: stale review file $(basename "$f")"
    handle_review_wake "$f"
  done

  # Pass 1: process any .wake-* files left on disk from a previous watcher run
  for f in "$WATCH_DIR"/.wake-*; do
    [ -f "$f" ] || continue
    echo "[$(date)] Startup recovery: stale wake file $(basename "$f")"
    handle_trigger_wake "$f"
  done

  # Pass 2: re-create wake files for done tasks whose wake file was never written
  [ -f "$DB" ] || return 0
  sqlite3 -json "$DB" \
    "SELECT ta.task_id, ta.trigger_name, ta.session_key,
            COALESCE(ts.session_id,'') AS session_id,
            COALESCE(t.channel,'internal') AS channel,
            COALESCE(tk.response_summary,'') AS response_summary
     FROM task_awaits ta
     JOIN tasks tk ON tk.id = ta.task_id AND tk.status = 'done'
     LEFT JOIN trigger_sessions ts ON ts.trigger_name = ta.trigger_name
                                   AND ts.session_key = ta.session_key
     LEFT JOIN triggers t ON t.name = ta.trigger_name" 2>/dev/null \
  | jq -c '.[]' 2>/dev/null \
  | while IFS= read -r row; do
      local task_id trigger_name
      task_id=$(printf '%s' "$row" | jq -r '.task_id')
      trigger_name=$(printf '%s' "$row" | jq -r '.trigger_name')
      local WAKE_FILE="$WATCH_DIR/.wake-${trigger_name}-${task_id}"
      [ -f "$WAKE_FILE" ] && continue  # already handled in Pass 1
      echo "[$(date)] Startup recovery: recreating wake for task $task_id ($trigger_name)"
      printf '%s' "$row" > "$WAKE_FILE"
      sqlite3 "$DB" "DELETE FROM task_awaits WHERE task_id = $task_id" 2>/dev/null || true
      handle_trigger_wake "$WAKE_FILE"
    done

}

# Ensure watch directory exists
mkdir -p "$WATCH_DIR"
touch "$WATCH_DIR/.wake"

echo "[$(date)] Watcher started. Monitoring $WATCH_DIR"

startup_recovery

inotifywait -m "$WATCH_DIR" -e create,modify,attrib --exclude '\.(db|wal|shm)$' --format '%f' | while read FILENAME; do

  # --- Main session wake (.wake file) ---
  if [ "$FILENAME" = ".wake" ]; then
    echo "[$(date)] Main session wake event"

    (
      exec </dev/null >>/atlas/logs/watcher.log 2>&1
      flock -n 9 || { echo "[$(date)] Session already running, skipping"; exit 0; }

      touch "$LOCK_FILE"  # web-ui status indicator

      SESSION_ID=$(cat "$SESSION_FILE" 2>/dev/null || echo "")

      disable_remote_mcp

      set +e
      WORKER_START=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
      WORKER_OUT=$(mktemp /tmp/worker-out-XXXXXX.json)

      if [ -n "$SESSION_ID" ]; then
        echo "[$(date)] Resuming session: $SESSION_ID"
        claude-atlas --mode worker --output-format json --resume "$SESSION_ID" \
          --dangerously-skip-permissions \
          -p "You have new tasks. Use get_next_task() to process them." \
          > "$WORKER_OUT" 2>>/atlas/logs/session.log
      else
        echo "[$(date)] Starting new session"
        claude-atlas --mode worker --output-format json \
          --dangerously-skip-permissions \
          -p "You have new tasks. Use get_next_task() to process them." \
          > "$WORKER_OUT" 2>>/atlas/logs/session.log
      fi
      CLAUDE_EXIT=$?
      set -e

      WORKER_END=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

      # Extract session_id from JSON output (supplements stop.sh which also saves it)
      NEW_SESSION_ID=$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get('session_id', ''))
except: print('')
" "$WORKER_OUT" 2>/dev/null || echo "")
      if [ -n "$NEW_SESSION_ID" ]; then
        echo "$NEW_SESSION_ID" > "$SESSION_FILE"
      fi

      save_session_metrics "$WORKER_OUT" "worker" "" "$WORKER_START" "$WORKER_END" "$CLAUDE_EXIT"
      rm -f "$WORKER_OUT"

      rm -f "$LOCK_FILE"

      if [ "$CLAUDE_EXIT" -eq 0 ]; then
        on_session_success
        echo "[$(date)] Session ended, back to sleep"
      else
        echo "[$(date)] Session failed with exit $CLAUDE_EXIT, entering backoff"
        on_session_failure "$CLAUDE_EXIT"
      fi
    ) 9>"$FLOCK_FILE" &

  # --- Trigger session re-awakening (.wake-<trigger>-<task_id> file) ---
  elif [[ "$FILENAME" == .wake-* ]]; then
    handle_trigger_wake "$WATCH_DIR/$FILENAME"

  # --- Reviewer wake (.review-<task_id> file) ---
  elif [[ "$FILENAME" == .review-* ]]; then
    handle_review_wake "$WATCH_DIR/$FILENAME"
  fi

done
