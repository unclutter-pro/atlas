You are running the daily memory cleanup task. Your goal is to keep the memory files well-organized, properly structured, and under size limits.

## Memory Structure (Obsidian-Style)

All memory files use YAML frontmatter (`type`, `date`, `tags`, `related`, `status`, `expires`) and `[[wikilinks]]` for cross-referencing.

```
~/memory/
├── MEMORY.md          — High-level index (max 200 lines)
├── entities/          — Services, platforms, people, companies
├── decisions/         — Key decisions with rationale
├── workflows/         — Learned procedures and playbooks
├── journal/           — Daily session logs (never modify!)
└── projects/          — Project-specific notes
```

## Rules

1. **MEMORY.md** (`~/memory/MEMORY.md`):
   - Must stay under **200 lines**
   - Remove outdated or stale information
   - Keep it as a concise **index** — infrastructure, projects, scripts, known limitations, workflow
   - **Identity details (both agent AND user) belong in `~/IDENTITY.md`** — move them there, NOT in MEMORY.md
   - **Behavioral rules belong in `~/SOUL.md`** — only fundamental behavior shaping, not preferences
   - Move detailed project notes to `~/memory/projects/<project-name>.md`
   - Move service/tool details to `~/memory/entities/<name>.md`

2. **Entity files** (`~/memory/entities/*.md`):
   - One file per service, platform, tool, or person
   - Must have frontmatter with `type: entity`, `status`, `tags`
   - Remove or archive entities that are no longer in use

3. **Decision files** (`~/memory/decisions/*.md`):
   - Check `status` field — mark completed/superseded decisions accordingly
   - Check `expires` field — if expired, set `status: archived`
   - Decisions should never be deleted, only archived

4. **Workflow files** (`~/memory/workflows/*.md`):
   - Validate procedures are still accurate
   - Consolidate duplicate workflows

5. **Project files** (`~/memory/projects/*.md`):
   - One file per project or major topic
   - Must have frontmatter with `type: project`, `status`, `tags`
   - Consolidate duplicate information
   - Set `status: archived` for completed/abandoned projects

6. **Journal entries** (`~/memory/journal/*.md`):
   - Daily logs for context recovery — always keep full details
   - Do NOT compress, summarize, or shorten journal entries
   - Ensure all journal files have frontmatter with `type: journal` and `date`

## Process

1. Read MEMORY.md and check its line count — reorganize if over 200 lines
2. Scan all memory files for missing or malformed frontmatter — fix where needed
3. Check `expires` fields across all files — archive expired entries
4. Verify `[[wikilinks]]` resolve to existing files — remove broken links
5. Scan entity and project files for staleness or duplication
6. Ensure IDENTITY.md and SOUL.md exist and contain relevant content
7. Run `qmd update` after making changes to reindex
