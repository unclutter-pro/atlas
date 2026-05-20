#!/bin/bash
# manage-tasks.realworld.test.sh — End-to-end integration tests for the Atlas task management system.
#
# Run from the repo root:
#   bash app/triggers/manage-tasks.realworld.test.sh
#
# Requirements:
#   - bun installed and on PATH
#   - SQLite accessible
#   - ATLAS_TRIGGER and ATLAS_TRIGGER_SESSION_KEY will be set by this script
#
# The script uses a dedicated test scope (ATLAS_TRIGGER=test, ATLAS_TRIGGER_SESSION_KEY=integration)
# so it doesn't interfere with real data. All created data is cleaned up at the end.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TASK_CLI="bun $SCRIPT_DIR/manage-tasks.ts"
# Find the hooks directory — prefer /atlas/app/hooks/task-session.sh (in container)
# but fall back to the repo hooks (in dev/CI)
if [ -x "/atlas/app/hooks/task-session.sh" ]; then
  HOOKS_DIR="/atlas/app/hooks"
else
  HOOKS_DIR="$APP_DIR/hooks"
fi

export ATLAS_TRIGGER="test"
export ATLAS_TRIGGER_SESSION_KEY="integration"

# Goal close always runs the validator; for the bulk of the suite we mock-pass it.
# The dedicated validator test section (7) overrides this to also exercise fail.
export ATLAS_VALIDATOR_MOCK="pass:integration-test-default"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASS_COUNT=0
FAIL_COUNT=0
ERRORS=()

pass() {
  echo -e "  ${GREEN}✓${NC} $1"
  ((PASS_COUNT++)) || true
}

fail() {
  echo -e "  ${RED}✗${NC} $1"
  ERRORS+=("$1")
  ((FAIL_COUNT++)) || true
}

assert_contains() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if echo "$actual" | grep -qF "$expected"; then
    pass "$label"
  else
    fail "$label (expected '$expected' in output, got: $actual)"
  fi
}

assert_not_contains() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if echo "$actual" | grep -qF "$expected"; then
    fail "$label (did NOT expect '$expected' in output, got: $actual)"
  else
    pass "$label"
  fi
}

assert_exit_ok() {
  local label="$1"
  if [ "$2" -eq 0 ]; then
    pass "$label"
  else
    fail "$label (expected exit 0, got $2)"
  fi
}

assert_exit_fail() {
  local label="$1"
  if [ "$2" -ne 0 ]; then
    pass "$label"
  else
    fail "$label (expected non-zero exit, got 0)"
  fi
}

echo ""
echo "=== Atlas Task Management — Real-World Integration Tests ==="
echo "Scope: ATLAS_TRIGGER=test, ATLAS_TRIGGER_SESSION_KEY=integration"
echo ""

# ---------------------------------------------------------------------------
# 1. Clean state
# ---------------------------------------------------------------------------

echo "--- 1. Setup: Clean test data ---"

# Delete any leftover test data from previous runs
DB_PATH="${HOME}/.index/atlas.db"
if [ -f "$DB_PATH" ]; then
  sqlite3 "$DB_PATH" "DELETE FROM tasks WHERE trigger_name='test'; DELETE FROM goals WHERE trigger_name='test';" 2>/dev/null || true
  echo "  Cleaned previous test data from atlas.db"
fi

# ---------------------------------------------------------------------------
# 2. Create a goal and add 3 tasks with dependencies
# ---------------------------------------------------------------------------

echo ""
echo "--- 2. Goal + task creation ---"

GOAL_OUT=$($TASK_CLI goal create --title="Integration test goal" --done="All 3 tasks closed and goal done" --description="Automated integration test") 2>&1
assert_contains "goal create succeeds" "Created goal #" "$GOAL_OUT"
GOAL_ID=$(echo "$GOAL_OUT" | grep -oP '#\K\d+' | head -1)
echo "  Created goal #$GOAL_ID"

T1_OUT=$($TASK_CLI add --title="Task 1: first step" --goal="$GOAL_ID" --priority=1) 2>&1
assert_contains "task add 1 succeeds" "Created task #" "$T1_OUT"
T1_ID=$(echo "$T1_OUT" | grep -oP '#\K\d+' | head -1)

T2_OUT=$($TASK_CLI add --title="Task 2: second step" --goal="$GOAL_ID" --depends-on="$T1_ID") 2>&1
assert_contains "task add 2 with dep succeeds" "Created task #" "$T2_OUT"
T2_ID=$(echo "$T2_OUT" | grep -oP '#\K\d+' | head -1)

T3_OUT=$($TASK_CLI add --title="Task 3: final step" --goal="$GOAL_ID" --depends-on="$T2_ID") 2>&1
assert_contains "task add 3 with chained dep succeeds" "Created task #" "$T3_OUT"
T3_ID=$(echo "$T3_OUT" | grep -oP '#\K\d+' | head -1)

echo "  Tasks: #$T1_ID, #$T2_ID, #$T3_ID"

# ---------------------------------------------------------------------------
# 3. List and ready commands
# ---------------------------------------------------------------------------

echo ""
echo "--- 3. List + ready commands ---"

LIST_OUT=$($TASK_CLI list) 2>&1
assert_contains "list shows all 3 tasks" "Task 1" "$LIST_OUT"
assert_contains "list shows task 2" "Task 2" "$LIST_OUT"
assert_contains "list shows task 3" "Task 3" "$LIST_OUT"

READY_OUT=$($TASK_CLI ready) 2>&1
assert_contains "ready shows only T1 (no deps)" "Task 1" "$READY_OUT"
assert_not_contains "ready does not show T2 (blocked by T1)" "Task 2" "$READY_OUT"
assert_not_contains "ready does not show T3 (blocked by T2)" "Task 3" "$READY_OUT"

GOAL_LIST_OUT=$($TASK_CLI goal list) 2>&1
assert_contains "goal list shows the goal" "Integration test goal" "$GOAL_LIST_OUT"

# ---------------------------------------------------------------------------
# 4. Close tasks one by one
# ---------------------------------------------------------------------------

echo ""
echo "--- 4. Sequential task close ---"

$TASK_CLI close "$T1_ID" --reason="Step 1 complete" > /dev/null 2>&1
EXIT_CODE=$?
assert_exit_ok "close T1 succeeds" $EXIT_CODE

READY_AFTER_T1=$($TASK_CLI ready) 2>&1
assert_contains "T2 becomes ready after T1 closed" "Task 2" "$READY_AFTER_T1"
assert_not_contains "T3 still blocked (T2 still open)" "Task 3" "$READY_AFTER_T1"

$TASK_CLI close "$T2_ID" --reason="Step 2 complete" > /dev/null 2>&1
$TASK_CLI close "$T3_ID" --reason="Step 3 complete" > /dev/null 2>&1

FINAL_LIST=$($TASK_CLI list --status=done) 2>&1
assert_contains "T1 shows as done" "Task 1" "$FINAL_LIST"
assert_contains "T2 shows as done" "Task 2" "$FINAL_LIST"
assert_contains "T3 shows as done" "Task 3" "$FINAL_LIST"

# ---------------------------------------------------------------------------
# 5. Goal close
# ---------------------------------------------------------------------------

echo ""
echo "--- 5. Goal close ---"

GOAL_CLOSE_OUT=$($TASK_CLI goal close "$GOAL_ID" --reason="Integration test complete") 2>&1
GOAL_CLOSE_EXIT=$?
assert_exit_ok "goal close succeeds when tasks are done" $GOAL_CLOSE_EXIT
assert_contains "goal close outputs success" "closed" "$GOAL_CLOSE_OUT"

SHOW_OUT=$($TASK_CLI goal show "$GOAL_ID") 2>&1
assert_contains "goal status is done" "done" "$SHOW_OUT"

# ---------------------------------------------------------------------------
# 6. --cascade-cancel test
# ---------------------------------------------------------------------------

echo ""
echo "--- 6. Cascade cancel ---"

export ATLAS_TRIGGER_SESSION_KEY="cascade-test"

# Create a new goal with open tasks
CASCADE_GOAL_OUT=$($TASK_CLI goal create --title="Cascade test goal" --done="Just a test") 2>&1
CASCADE_GOAL_ID=$(echo "$CASCADE_GOAL_OUT" | grep -oP '#\K\d+' | head -1)

$TASK_CLI add --title="Open task A" --goal="$CASCADE_GOAL_ID" > /dev/null 2>&1
$TASK_CLI add --title="Open task B" --goal="$CASCADE_GOAL_ID" > /dev/null 2>&1

# Try close without cascade — should fail
CLOSE_ERR=$($TASK_CLI goal close "$CASCADE_GOAL_ID" --reason="test" 2>&1 || true)
assert_contains "close with open tasks gives error" "open" "$CLOSE_ERR"

# Close with cascade
CASCADE_OUT=$($TASK_CLI goal close "$CASCADE_GOAL_ID" --reason="cascade close test" --cascade-cancel 2>&1)
CASCADE_EXIT=$?
assert_exit_ok "cascade-cancel close succeeds" $CASCADE_EXIT

# Verify tasks are cancelled
CASCADE_TASKS=$($TASK_CLI list --all --status=cancelled 2>&1)
assert_contains "Open task A is now cancelled" "Open task A" "$CASCADE_TASKS"
assert_contains "Open task B is now cancelled" "Open task B" "$CASCADE_TASKS"

export ATLAS_TRIGGER_SESSION_KEY="integration"

# ---------------------------------------------------------------------------
# 7. Validator with ATLAS_VALIDATOR_MOCK
# ---------------------------------------------------------------------------

echo ""
echo "--- 7. Validator mock ---"

export ATLAS_TRIGGER_SESSION_KEY="validator-test"

VALIDATED_GOAL_OUT=$($TASK_CLI goal create --title="Validated goal" --done="All tests pass") 2>&1
VALIDATED_GOAL_ID=$(echo "$VALIDATED_GOAL_OUT" | grep -oP '#\K\d+' | head -1)
assert_contains "goal create mentions validator" "isolated validator" "$VALIDATED_GOAL_OUT"

# Mock: fail
export ATLAS_VALIDATOR_MOCK="fail:Tests are not written yet"
FAIL_EXIT=0
FAIL_CLOSE=$($TASK_CLI goal close "$VALIDATED_GOAL_ID" --reason="I think I'm done" 2>&1) || FAIL_EXIT=$?
assert_exit_fail "validator fail blocks goal close" $FAIL_EXIT
assert_contains "fail output contains feedback" "Tests are not written yet" "$FAIL_CLOSE"

# Verify validation_count incremented
VAL_COUNT=$(sqlite3 "$DB_PATH" "SELECT validation_count FROM goals WHERE id=$VALIDATED_GOAL_ID;" 2>/dev/null)
if [ "$VAL_COUNT" = "1" ]; then
  pass "validation_count incremented to 1"
else
  fail "validation_count should be 1, got: $VAL_COUNT"
fi

# Mock: pass
export ATLAS_VALIDATOR_MOCK="pass:All requirements verified"
PASS_CLOSE=$($TASK_CLI goal close "$VALIDATED_GOAL_ID" --reason="Fixed: tests are written now") 2>&1
PASS_EXIT=$?
assert_exit_ok "validator pass closes goal" $PASS_EXIT
assert_contains "pass output mentions validator" "Validator passed" "$PASS_CLOSE"

# Verify goal is done
VALIDATED_STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM goals WHERE id=$VALIDATED_GOAL_ID;" 2>/dev/null)
if [ "$VALIDATED_STATUS" = "done" ]; then
  pass "goal status is done after validator pass"
else
  fail "goal status should be 'done', got: $VALIDATED_STATUS"
fi

# Restore the global mock for any subsequent goal closes in later sections.
export ATLAS_VALIDATOR_MOCK="pass:integration-test-default"
export ATLAS_TRIGGER_SESSION_KEY="integration"

# ---------------------------------------------------------------------------
# 8. Hook check output
# ---------------------------------------------------------------------------

echo ""
echo "--- 8. Hook check output ---"

export ATLAS_TRIGGER_SESSION_KEY="hook-test"

# Add an open task
$TASK_CLI add --title="Open hook task" > /dev/null 2>&1

# Run task-session.sh check — should output block JSON
CHECK_OUT=$("$HOOKS_DIR/task-session.sh" check 2>/dev/null || echo "HOOK_FAILED")
if echo "$CHECK_OUT" | grep -q '"decision"'; then
  assert_contains "check outputs block JSON with open tasks" '"decision"' "$CHECK_OUT"
  assert_contains "check JSON has block value" 'block' "$CHECK_OUT"
else
  fail "task-session.sh check did not output block JSON (output: $CHECK_OUT)"
fi

# Close the task and re-check
HOOK_TASKS=$($TASK_CLI list --status=open 2>&1)
HOOK_TASK_IDS=$(echo "$HOOK_TASKS" | grep -oP '#\K\d+' | head -5)
for tid in $HOOK_TASK_IDS; do
  $TASK_CLI close "$tid" --reason="cleaning up" > /dev/null 2>&1 || true
done

CHECK_EMPTY=$("$HOOKS_DIR/task-session.sh" check 2>/dev/null || echo "")
if [ -z "$CHECK_EMPTY" ]; then
  pass "check returns empty when no open items"
else
  # May have non-JSON output from warnings — check no 'decision' field
  if echo "$CHECK_EMPTY" | grep -q '"decision"'; then
    fail "check should return empty with no open items (got: $CHECK_EMPTY)"
  else
    pass "check returns no block JSON when no open items"
  fi
fi

export ATLAS_TRIGGER_SESSION_KEY="integration"

# ---------------------------------------------------------------------------
# 9. Kill-switch
# ---------------------------------------------------------------------------

echo ""
echo "--- 9. Kill-switch (ATLAS_TASKS_DISABLE_GATE) ---"

export ATLAS_TRIGGER_SESSION_KEY="killswitch-test"

# Add an open task
$TASK_CLI add --title="Task that should not block" > /dev/null 2>&1

# Without kill-switch — should block
NO_KS_OUT=$(ATLAS_TASKS_DISABLE_GATE=0 "$HOOKS_DIR/task-session.sh" check 2>/dev/null || echo "")
if echo "$NO_KS_OUT" | grep -q '"decision"'; then
  pass "without kill-switch: stop is blocked"
else
  fail "without kill-switch: expected block JSON, got: $NO_KS_OUT"
fi

# With kill-switch — should allow stop (empty output, warning to stderr)
KS_COMBINED=$(ATLAS_TASKS_DISABLE_GATE=1 "$HOOKS_DIR/task-session.sh" check 2>&1 || echo "")
KS_STDOUT=$(ATLAS_TASKS_DISABLE_GATE=1 "$HOOKS_DIR/task-session.sh" check 2>/dev/null || echo "")
if echo "$KS_COMBINED" | grep -q "ATLAS_TASKS_DISABLE_GATE"; then
  pass "kill-switch logs warning"
else
  fail "kill-switch should log warning, got: $KS_COMBINED"
fi
if ! echo "$KS_STDOUT" | grep -q '"decision"'; then
  pass "kill-switch allows stop (no block JSON)"
else
  fail "kill-switch should allow stop, got: $KS_STDOUT"
fi

# Cleanup killswitch test session
KILLSWITCH_TASKS=$($TASK_CLI list --status=open 2>&1)
for tid in $(echo "$KILLSWITCH_TASKS" | grep -oP '#\K\d+' | head -10); do
  $TASK_CLI cancel "$tid" > /dev/null 2>&1 || true
done

export ATLAS_TRIGGER_SESSION_KEY="integration"

# ---------------------------------------------------------------------------
# 10. Session start context output
# ---------------------------------------------------------------------------

echo ""
echo "--- 10. Session start context ---"

export ATLAS_TRIGGER_SESSION_KEY="context-test"

# Add goal and task to have something in context
CONTEXT_GOAL_OUT=$($TASK_CLI goal create --title="Context goal" --done="Done") 2>&1
CONTEXT_GOAL_ID=$(echo "$CONTEXT_GOAL_OUT" | grep -oP '#\K\d+' | head -1)
$TASK_CLI add --title="Context task" --goal="$CONTEXT_GOAL_ID" > /dev/null 2>&1

# Run task-session.sh start
START_OUT=$("$HOOKS_DIR/task-session.sh" start 2>/dev/null || echo "")
assert_contains "start outputs task-context block" "<task-context>" "$START_OUT"
assert_contains "start shows open goals" "Context goal" "$START_OUT"
assert_contains "start shows open tasks" "Context task" "$START_OUT"

# Close and re-check: empty state = no output
$TASK_CLI goal close "$CONTEXT_GOAL_ID" --reason="done" --cascade-cancel > /dev/null 2>&1

EMPTY_START=$("$HOOKS_DIR/task-session.sh" start 2>/dev/null || echo "SILENCE")
if [ "$EMPTY_START" = "SILENCE" ] || [ -z "$EMPTY_START" ]; then
  pass "start outputs nothing when no open items"
else
  # Some output is OK as long as it doesn't contain task-context
  if ! echo "$EMPTY_START" | grep -q "<task-context>"; then
    pass "start outputs no task-context when no open items"
  else
    fail "start should output nothing for empty state, got: $EMPTY_START"
  fi
fi

export ATLAS_TRIGGER_SESSION_KEY="integration"

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

echo ""
echo "--- Cleanup ---"

if [ -f "$DB_PATH" ]; then
  sqlite3 "$DB_PATH" "DELETE FROM tasks WHERE trigger_name='test'; DELETE FROM goals WHERE trigger_name='test';" 2>/dev/null || true
  echo "  Cleaned test data from atlas.db"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "=== Results ==="
echo -e "  ${GREEN}Passed: $PASS_COUNT${NC}"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "  ${RED}Failed: $FAIL_COUNT${NC}"
  echo ""
  echo "Failures:"
  for err in "${ERRORS[@]}"; do
    echo -e "  ${RED}✗${NC} $err"
  done
  echo ""
  exit 1
else
  echo -e "  All tests passed!"
  echo ""
fi
