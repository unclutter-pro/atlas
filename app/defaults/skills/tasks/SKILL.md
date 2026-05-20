---
name: tasks
description: Task management with the `task` CLI. Use when planning multi-step work, tracking goals with done-conditions, managing dependencies, or gating session exit on completion. Triggers on 'create task', 'track progress', 'plan work', 'open goals', 'what tasks are open', or any work that benefits from structured decomposition.
---

# Task Management

Use `task` for goals (longer-running outcomes with measurable done-conditions) and tasks (concrete steps). The session can't end while goals or open tasks remain — close them with a thorough `--reason`, or set a `reminder` to continue later.

## Goals

```bash
task goal create \
  --title="Lift mapstudio.ai organic traffic to 1k clicks/day" \
  --done="GSC: ≥1000 average daily clicks over a 7-day window for organic search, top-10 ranking for 'tile map studio'" \
  --description="Strategy: technical SEO audit (Core Web Vitals, sitemap, structured data) first, then content gaps for top-5 commercial intents. Priorities: real measurable traffic over vanity rankings; user prefers iterative shipping over big-bang."

task goal list                         # active goals this session
task goal show 3
task goal close 3 --reason="<thorough explanation of why the done-condition is genuinely met, with concrete evidence — short reasons are rejected>"
task goal close 3 --reason="..." --cascade-cancel   # also cancels still-open tasks
```

A goal's `--description` carries the *strategy + user priorities* (broader context for a re-spawned session); `--done` is the *measurable acceptance criteria*. Write both for any goal worth opening.

When closing a goal, provide an **extensive `--reason`** — explain why the done-condition is actually met, with concrete evidence. Short reasons get rejected.

## Tasks

```bash
task add --title="Run Lighthouse audit on /maps and /pricing" --goal=3 --priority=1
task add --title="Fix Largest Contentful Paint on /maps" --goal=3 --depends-on=12
task add --title="Draft 'tile map studio' landing page copy" --goal=3 --priority=2

task ready                          # tasks with no open deps
task list                           # open + in_progress
task list --status=done,cancelled
task show 12
task close 12 --reason="LCP now 1.8s on 4G profile, was 3.4s"
task cancel 15 --reason="Subsumed by #18"
```

**Statuses**: tasks `open → in_progress → done | cancelled`; goals `active → done | abandoned | validation_exhausted`.
**Priority**: 0=critical, 1=high, 2=normal (default), 3=low, 4=backlog.

## Session scope

Everything scopes to the current session automatically. Use `--all` only when debugging across sessions.
