# Memory System

Atlas uses a file-based memory system with plain Markdown files, YAML frontmatter, and `[[wikilinks]]` for cross-referencing. Memory retrieval is done directly via grep, glob, and file reads — no external indexing daemon required.

The structure is deliberately **loose**. Rather than forcing every fact into a fixed taxonomy, the agent organizes its own memory and is given two fixed points to anchor it: the journal and the linking convention. This follows the direction Anthropic recommends for capable models — give the model a notebook and let it decide how to keep it, instead of prescribing a schema it has to satisfy.

## Architecture

Memory lives in `workspace/memory/` as Markdown files. The **memory-searcher** sub-agent (haiku) finds information using grep/glob/read across the memory directory. It operates on the filesystem directly — no MCP server or indexing process is needed.

## The two fixed points

Everything else about the layout is the agent's judgement. These two are not:

**1. The journal** — `journal/<YYYY-MM-DD>.md`, one file per day, written every day.
The record of what actually happened: activities, task results, decisions, open threads. Past entries are never compressed, rewritten, or summarized — they are the raw material every later consolidation draws on.

**2. Frontmatter and links** — every file carries YAML frontmatter and uses `[[wikilinks]]` to reference related files. Links are what make memory navigable; a fact nothing links to is a fact that won't be found again.

## Directory Structure

`MEMORY.md` holds only what every session needs: a few top-tier rules linking to their details. It is the first thing every session reads, so it stays short. Everything else is found by searching the tree.

Below it, these folders are created by default and cover most cases, but they are **conventions, not constraints**:

```
~/memory/
├── MEMORY.md              — Top-tier rules every session needs
├── journal/               — Daily session logs (fixed; never compressed)
│   └── YYYY-MM-DD.md
├── entities/              — Services, platforms, people, companies
├── decisions/             — Key decisions with rationale
├── workflows/             — Learned procedures, playbooks, patterns
├── projects/              — Project-specific notes and architecture
├── responsibilities/      — Recurring ownership themes that outlive a session
└── notes/                 — Free-form; anything that doesn't fit yet
```

The agent may create new folders, split a file that outgrew its topic, or merge several thin files into one. A well-named file in a sensible place beats a forced fit in the "correct" one. Because of this, tooling must **discover** the structure rather than assume it — `memory-searcher` searches the whole tree and only relies on `MEMORY.md` and `journal/` being where they are.

## Frontmatter Format

```yaml
---
type: entity | decision | workflow | journal | project | note | ...
date: YYYY-MM-DD
tags: [infrastructure, mapstudio, ...]
related: ["[[other-file]]", "[[another-file]]"]
status: active | completed | superseded | archived
expires: YYYY-MM-DD             # optional
valid_from: YYYY-MM-DD          # optional — since when this has been true
invalidated: YYYY-MM-DD         # optional — when it stopped being true
superseded_by: "[[new-file]]"   # optional — what replaced it
---
```

`type` is free-form; unfamiliar values are valid.

## Bi-temporal facts

Facts change. Atlas records *when* they changed rather than overwriting them, so history stays answerable and contradictions resolve deterministically instead of by guessing which file looks newer.

When something recorded earlier is no longer true:

1. The old record is marked — `status: superseded`, `invalidated: <date>`, `superseded_by: "[[new-file]]"`
2. The current truth is written in its own file
3. The two are linked

Only the *claim* is invalidated, never the *reasoning* behind the original decision. Decision files are never deleted — they are archived or superseded.

This makes two different questions answerable from the same store:

| Question | Answer comes from |
|---|---|
| "What's our current setup?" | active records (superseded ones filtered out) |
| "What did we use before, and when did we switch?" | the superseded chain, via `invalidated` / `superseded_by` |

`memory-searcher` reports the current truth by default, follows `superseded_by` links to find it, and switches to the historical record when the question is explicitly about the past. When two active files contradict each other and neither is marked, it reports both and flags the conflict rather than silently picking one.

## Retrieval Strategy

The memory-searcher agent uses a layered approach:

1. **MEMORY.md first** — the index often points directly to the right file
2. **Filename search** — glob across the whole tree (`~/memory/**/*signal*.md`), not a single folder
3. **Content search** — grep across memory for keywords, dates, or patterns
4. **Frontmatter filtering** — grep on `type:`, `status:`, `tags:` to narrow results
5. **Currency check** — grep matched files for `invalidated:` / `superseded_by:` and follow the chain
6. **Wikilink traversal** — follow `[[wikilinks]]` in `related:` to find connected info
7. **Full file reads** — read complete files once identified

This is more reliable than semantic search for structured data and gives deterministic results.

## Writing Strategy

Information is routed by what it *is*, not by which folder it must occupy:

- **New service/tool/person** → `entities/`
- **Decision with rationale** → `decisions/`
- **Repeatable process** → `workflows/`
- **Project update** → `projects/`
- **Recurring ownership theme** → `responsibilities/`
- **Doesn't fit any of these** → `notes/`, or a new file where it belongs

Each fact lives in exactly one authoritative place and is `[[wikilinked]]` from everywhere else — duplication is how a memory starts contradicting itself.

The journal is always written by the team lead, never by sub-agents.

## Nightly consolidation (dreaming)

The `dreaming` trigger runs at 03:00 and is where raw session history becomes durable knowledge. It replays the last 24h of sessions through `session-analyzer` subagents (haiku, in parallel), then does the synthesis itself:

- **Cross-session and cross-day patterns** — a problem hit twice is knowledge; hit once it's an anecdote
- **User corrections** — the highest-signal moments, marking where the agent's model of the world was wrong
- **Supersession** — folding today's truth into memory without destroying yesterday's record
- **Hygiene** — index size, broken links, redundancy, staleness, contradictions

Because the synthesis is the step where reasoning depth pays off — and it runs once a day, offline, with no user waiting — it is routed to a stronger model than other cron jobs via `model_key='dreaming'` → `models.dreaming`.

Playbook-style files are extended by **appending** dated lines rather than being rewritten each night. Repeated summarization erodes the detail that made them useful; additive deltas preserve it.

See [Triggers.md](Triggers.md) for the trigger lifecycle.

## Configuration

```yaml
memory:
  load_memory_md: true         # Load full MEMORY.md on session start
  load_journal_days: 7         # Show recent journal entry titles on start

models:
  dreaming: opus               # Nightly consolidation — deep cross-session synthesis
```

## Usage in Sessions

Claude uses memory-searcher automatically for recall:

```
"What did we decide about the auth system last week?"
→ memory-searcher: Grep(pattern="auth", path="~/memory/")
→ Found in decisions/2026-02-20-auth-system.md: "Decided to use JWT with refresh tokens..."
→ Currency: current (no invalidated/superseded_by marker)
```
