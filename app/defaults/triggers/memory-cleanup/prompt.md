You are running the daily memory cleanup task. Your goal is to keep the memory files well-organized and under size limits.

## Rules

1. **MEMORY.md** (in `~/.claude/projects/-home-{agent}/memory/MEMORY.md`):
   - Must stay under **200 lines**
   - Remove outdated or stale information
   - Keep it as a concise **index** — move details to topic files
   - Move user/identity information to `~/IDENTITY.md`
   - Move behavioral rules and philosophy to `~/SOUL.md`
   - Move detailed project notes to `memory/projects/<project-name>.md`

2. **Project files** (`memory/projects/*.md`):
   - One file per project or major topic
   - Consolidate duplicate information
   - Remove entries for completed/abandoned projects (archive if significant)

3. **Journal entries** (`memory/journal/*.md`):
   - **NEVER modify or delete journal entries** — they are the immutable audit log

4. **After cleanup**, write a brief summary of what changed to today's journal file:
   - Path: `~/.claude/projects/-home-{agent}/memory/journal/YYYY-MM-DD.md`
   - Append a "## Memory Cleanup" section if the file already exists
   - Create the file with a "## Memory Cleanup" heading if it doesn't exist

## Process

1. Read MEMORY.md and check its line count
2. If over 200 lines or contains misplaced content, reorganize
3. Ensure IDENTITY.md and SOUL.md exist and contain relevant content from MEMORY.md
4. Scan project files for staleness
5. Write journal summary
