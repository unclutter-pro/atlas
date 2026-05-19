---
name: tasks
description: Task management with the `task` CLI. Use when planning multi-step work, tracking goals with done-conditions, managing dependencies, or gating session exit on completion. Triggers on 'create task', 'track progress', 'plan work', 'open goals', 'what tasks are open', or any work that benefits from structured decomposition.
---

# Atlas Task Management

The `task` CLI manages goals and tasks scoped to the current session (`ATLAS_TRIGGER` + `ATLAS_TRIGGER_SESSION_KEY`). The StopHook blocks exit while active goals or open tasks exist — close them or set a reminder to defer.

## Goal Lifecycle

Goals represent a defined outcome with a prose done-condition. Use them for multi-step work.

```bash
# Create a goal
task goal create --title="Refactor auth module" \
  --done="All auth tests pass, no regressions in CI" \
  --description="Auth module is brittle and hard to test; needs interface redesign" \
  --validate   # optional: triggers isolated quality check on close

# View goals
task goal list            # active goals this session
task goal show 3          # full detail for goal #3

# Close a goal
task goal close 3 --reason="Refactor complete, all 47 tests pass"
# With open tasks: use --cascade-cancel to auto-cancel them
task goal close 3 --reason="Abandoned: scope changed" --cascade-cancel
# Skip validation (logs override row):
task goal close 3 --reason="..." --skip-validation
```

**Statuses**: `active` → `done` | `abandoned` | `validation_exhausted`

## Task Lifecycle

Tasks are concrete units of work, optionally linked to a goal.

```bash
# Add tasks
task add --title="Write unit tests for auth service" --goal=3 --priority=1
task add --title="Update README" --priority=3
task add --title="Deploy to staging" --goal=3 --depends-on=12,13

# Find unblocked work
task ready                          # open tasks with all deps closed

# View and update
task list                           # open + in_progress tasks
task list --status=done,cancelled   # closed tasks
task show 12                        # full detail

# Close or cancel
task close 12 --reason="Tests written, 100% coverage"
task cancel 15 --reason="No longer needed"
```

**Statuses**: `open` → `in_progress` → `done` | `cancelled`
**Priority**: 0=critical, 1=high, 2=normal (default), 3=low, 4=backlog

## Dependencies

```bash
# Task #14 is blocked until #12 and #13 are done/cancelled
task add --title="Final integration test" --depends-on=12,13

task ready   # only shows tasks whose deps are all closed
```

## Validation Gate

When a goal is created with `--validate`, closing it spawns an isolated validator agent that reads the filesystem and checks whether the done-condition is met. The validator returns `pass` (goal closes) or `fail` (error with feedback — refine and retry). After 3 failed validations the goal is marked `validation_exhausted`. Use `--skip-validation` to bypass with an explicit override log.

## Session Scope

All commands default to `(ATLAS_TRIGGER, ATLAS_TRIGGER_SESSION_KEY)`. Use `--all` to inspect across all sessions (debug only).

```bash
task goal list --all   # all goals across all sessions
task list --all        # all tasks across all sessions
```
