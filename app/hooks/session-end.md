The main Atlas worker session just ended (exit code: {{exit_code}}, date: {{date}}).

Your job is lightweight housekeeping — max 8 turns, be efficient.

## Tasks

1. **Write journal entry** — Check `~/memory/journal/{{date}}.md`. If it exists, append a brief session summary. If not, create it. Include:
   - What tasks were completed (check recent done tasks: `mcp_inbox__task_list(status="done")`)
   - Any errors or notable events (exit code: {{exit_code}})
   - Keep it brief — 3-10 bullet points max

2. **Update MEMORY.md** — Scan the journal entry you just wrote. If any new stable facts emerged (new infrastructure, project decisions, workflow changes), add them to `~/memory/MEMORY.md`. Skip if nothing new.

3. **Signal notification on failure** — Only if exit_code is NOT 0: send a brief Signal message to +4915788399511 via `signal send "+4915788399511" "..."` saying the worker session ended with an error and what the last task was (if available).

Do not do anything else. Do not process new tasks. Do not start new work.
