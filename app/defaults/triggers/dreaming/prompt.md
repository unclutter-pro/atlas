You are in **dreaming mode** — a nightly cognitive consolidation process. Like REM sleep, your purpose is to process the day's experiences, strengthen important memories, discard noise, and prepare for tomorrow.

This is not a task execution session. Think deeply, reflect, and optimize your knowledge base.

## Phase 1: Session Replay (via Subagents)

First, discover which sessions ran in the last 24 hours:

```bash
python3 /atlas/app/triggers/cron/extract-sessions.py --hours 24 --list
```

This outputs a lightweight index with session file paths. For each **main session** (not subagents), spawn a Haiku subagent to analyze it:

```
Agent(model="haiku", prompt="Read and analyze the Claude Code session at <path>. Extract a structured summary in this exact format:

## Session <id>
**Topics**: (what was worked on, 1 line)
**Decisions**: (architecture/tool/process choices made, bullet list)
**Learnings**: (new patterns, bugs found, workarounds discovered)
**Corrections**: (what the user corrected or pushed back on)
**New entities**: (services, tools, people, projects mentioned for first time)
**Changed facts**: (things that became outdated or were superseded)
**User preferences**: (explicit or implicit preferences expressed)
**Open items**: (unfinished work, pending questions)

Be concise — max 2-3 bullets per category. Skip empty categories. Read the JSONL file directly, focus on user messages and assistant reasoning (thinking blocks). Ignore tool_result content blocks.")
```

Launch subagents **in parallel** for all main sessions (send them all in one message). Wait for all results, then synthesize.

For subagent session files (type=sub), skip individual analysis — they're visible through the main session context.

## Phase 2: Memory Consolidation

Based on the synthesized session summaries:

### 2a. Journal Entry
Write today's journal at `~/memory/journal/{{date}}.md` (or update if it exists). Include:
- What was worked on (high-level summary, not play-by-play)
- Key decisions and their rationale
- Problems encountered and how they were resolved
- Any unfinished work or open questions

### 2b. Knowledge Updates
Update the relevant memory files:
- **New entities** → create `~/memory/entities/<name>.md`
- **New decisions** → create `~/memory/decisions/{{date}}-<slug>.md`
- **New workflows** → create or update `~/memory/workflows/<name>.md`
- **Project changes** → update `~/memory/projects/<project>.md`
- **User preferences** → update `~/IDENTITY.md` (user section) or relevant entity file

### 2c. Skill Creation
If you noticed a recurring pattern across multiple sessions that could be automated:
- Create or update skills in `~/.claude/skills/` following the skills-guide format
- Only create skills for patterns you've seen at least twice

## Phase 3: Memory Hygiene

### 3a. MEMORY.md Maintenance
- Read `~/memory/MEMORY.md` and ensure it stays under **200 lines**
- Remove outdated information
- Move detailed content to appropriate entity/project/workflow files
- Keep it as a concise index with `[[wikilinks]]`

### 3b. Redundancy Cleanup
- Scan entity and project files for duplicate information
- Consolidate overlapping content into single authoritative files
- Ensure facts appear in exactly one place, referenced by wikilinks elsewhere

### 3c. Reference Resolution
- Verify all `[[wikilinks]]` in memory files resolve to existing files
- Remove or fix broken references
- Add missing cross-references between related files

### 3d. Staleness Check
- Check `expires` fields in frontmatter — archive expired entries
- Review `status` fields — mark completed/superseded items accordingly
- Look for information that contradicts what you learned today

### 3e. Frontmatter Validation
- Ensure all memory files have proper YAML frontmatter with at minimum: `type`, `date`, `status`
- Add missing `tags` and `related` fields where appropriate

## Phase 4: External State Verification

Check external resources that were relevant during the day's work. Use your judgment on what to verify — examples:
- Open PRs on GitHub repos that were discussed → `gh pr list --repo <repo> --state open`
- Deployment status of services that were modified
- Any pending issues or tasks → `bd stale` and `bd orphans`
- Beads task hygiene → close tasks that are done, flag stale ones

Update memory files with current state if anything changed.

## Phase 5: Beads Hygiene

Run maintenance on the task tracking system:
```bash
bd stale
bd orphans
bd doctor --check=conventions
```

Close any tasks that are clearly completed based on today's sessions. Flag items that need human attention with `bd human <id>`.

## Rules

- **Never modify journal entries from previous days** — they are historical records
- **Never delete decision files** — only archive them (`status: archived`)
- **Be conservative with skill creation** — only for proven, repeated patterns
- **Prioritize accuracy over completeness** — better to leave a gap than write something wrong
- **Keep changes atomic** — one concept per file update, easy to trace what changed
- Write a brief summary of what you consolidated at the end of the session
