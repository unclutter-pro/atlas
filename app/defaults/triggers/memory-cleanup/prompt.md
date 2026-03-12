You are running the daily memory cleanup task. Your goal is to keep the memory files well-organized and under size limits.

## Rules

1. **MEMORY.md** (in `~/.claude/projects/-home-{agent}/memory/MEMORY.md`):
   - Must stay under **200 lines**
   - Remove outdated or stale information
   - Keep it as a concise **index** — infrastructure, projects, scripts, known limitations, workflow
   - **User/identity details belong in `~/IDENTITY.md`** — move them there, NOT in MEMORY.md
   - **Behavioral rules belong in `~/SOUL.md`** — only fundamental behavior shaping, not preferences
   - Move detailed project notes to `memory/projects/<project-name>.md`

2. **Project files** (`memory/projects/*.md`):
   - One file per project or major topic
   - Consolidate duplicate information
   - Remove entries for completed/abandoned projects (archive if significant)

3. **Journal entries** (`memory/journal/*.md`):
   - **NEVER modify or delete journal entries** — they are the immutable audit log

## Process

1. Read MEMORY.md and check its line count
2. If over 200 lines or contains misplaced content, reorganize
3. Ensure IDENTITY.md and SOUL.md exist and contain relevant content from MEMORY.md
4. Scan project files for staleness
