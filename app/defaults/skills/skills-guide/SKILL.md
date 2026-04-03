---
name: skills-guide
description: How to create, structure, and maintain skills. Use when creating a new skill, improving an existing one, or deciding whether something should be a skill. Also trigger when recurring workflows, repeated multi-step processes, or consistent procedures are identified that could be captured as a reusable skill.
---

# Skills Guide

Skills are structured knowledge packs that teach the agent how to handle specific domains. They are loaded on demand via progressive disclosure:

1. **Frontmatter** (`name` + `description`) — always in system prompt; determines *when* to activate
2. **SKILL.md body** — loaded on activation; contains core instructions
3. **Linked files** — `references/`, `scripts/`, `assets/` loaded only when needed during execution

## When to Create a Skill

Create a skill when:
- A **recurring complex process** needs consistent, step-by-step instructions (e.g., document generation, API integrations, deployment workflows)
- **Domain-specific knowledge** is required that the agent wouldn't know on its own (e.g., project-specific APIs, internal conventions, tool configurations)
- There are **CLI tools, scripts, or templates** to orchestrate
- The process has **gotchas or edge cases** that cause repeated mistakes without guidance

Do NOT create a skill for:
- One-off procedures → `memory/journal/`
- Simple workflow references or checklists → `memory/workflows/`
- Project-specific notes → `memory/projects/`
- Simple facts or preferences → `memory/MEMORY.md`

**Rule of thumb:** If you'd explain it the same way every time and it involves multiple steps with specific tools — it's a skill. If it's a reference you just look up — it's memory.

## Directory Structure

```
~/skills/<skill-name>/
├── SKILL.md              # Main instructions (required)
├── references/           # Detailed docs, loaded on demand (optional)
│   └── api-errors.md
├── scripts/              # Executable code (optional)
│   └── validate.sh
└── assets/               # Templates, static files (optional)
    └── template.typ
```

Skills live in `~/skills/` and are automatically symlinked to `~/.claude/skills/`. No restart needed — new skills are available immediately.

**Important:** No `README.md` inside skill folders. All docs go in `SKILL.md` or `references/`.

## SKILL.md Format

### Frontmatter (required)

```yaml
---
name: my-skill
description: What it does. Use when [specific triggers]. Covers [key capabilities].
---
```

#### Naming rules

- **Folder name** = `name` field = kebab-case (`my-cool-skill`)
- **`SKILL.md`** must be exactly `SKILL.md` (case-sensitive)
- Names with "claude" or "anthropic" prefix are reserved
- Max 64 characters, lowercase + hyphens only, no leading/trailing/consecutive hyphens

#### Writing the `description`

The description is the most critical part — it's the **only thing the agent sees** before deciding to load your skill. Structure it as:

```
[What it does] + [When to use it] + [Key capabilities]
```

Rules:
- Under 1024 characters, no XML angle brackets (`<` or `>`)
- Use imperative phrasing: "Use when..." not "This skill..."
- Focus on **user intent**, not implementation details
- Include specific trigger phrases users might say
- Mention relevant file types or domains
- Be pushy — list contexts where the skill applies, even non-obvious ones

```yaml
# Good — specific, actionable, with triggers
description: Generate PDFs, DOCX files, and other documents using Typst, Pandoc, and Playwright. Use when creating invoices, reports, letters, or converting between document formats.

# Good — includes implicit triggers
description: Install packages persistently in the container. Use when you need system packages (apt), pip packages, or npm tools, even if the user just says "I need library X."

# Bad — too vague, no triggers
description: Useful information about documents.

# Bad — too technical, no user language
description: Implements the document entity model with hierarchical relationships.
```

### Body — Writing Effective Instructions

#### Start from real expertise

Don't generate generic instructions. Ground skills in **actual experience**:
- Extract patterns from tasks that worked well
- Include corrections you had to make (these become gotchas)
- Use real project artifacts: API specs, runbooks, code review patterns
- Capture the specific tools, flags, and sequences that matter

#### Add what the agent lacks, skip what it knows

Focus on what the agent *wouldn't know without your skill*: project conventions, specific API patterns, non-obvious edge cases, which tool to use when.

```markdown
<!-- Bad — agent knows what PDFs are -->
PDF files are a common file format. To extract text, you need a library...

<!-- Good — jumps to what matters -->
Use pdfplumber for text extraction. For scanned docs, fall back to
pdf2image with pytesseract.
```

**Test:** For each instruction, ask "Would the agent get this wrong without it?" If no, cut it.

#### Structure for scanning

1. **Quick reference table** — tool/command per scenario (if applicable)
2. **Core workflow** — step-by-step with specific commands
3. **Gotchas** — environment-specific facts that defy assumptions
4. **Examples** — common scenarios with input/output
5. **Troubleshooting** — common errors and fixes

#### Keep it lean

- Target **under 500 lines / 5000 tokens** for SKILL.md
- Move detailed reference material to `references/` with clear load triggers
- "Read `references/api-errors.md` if the API returns a non-200 status" > generic "see references/"

### Effective Instruction Patterns

#### Gotchas sections — highest-value content

Concrete corrections to mistakes the agent *will* make without being told:

```markdown
## Gotchas

- The `users` table uses soft deletes — always include `WHERE deleted_at IS NULL`
- User ID is `user_id` in DB, `uid` in auth, `accountId` in billing — same value
- `/health` returns 200 even if DB is down — use `/ready` for full health check
```

Keep gotchas in SKILL.md (not references/) so they're read before the agent hits the issue.

#### Provide defaults, not menus

Pick one recommended approach. Mention alternatives briefly:

```markdown
<!-- Bad — decision paralysis -->
You can use pypdf, pdfplumber, PyMuPDF, or pdf2image...

<!-- Good — clear default -->
Use pdfplumber for text extraction.
For scanned PDFs requiring OCR, use pdf2image with pytesseract instead.
```

#### Validation loops

Have the agent verify its own work:

```markdown
1. Make edits
2. Run: `python scripts/validate.py output/`
3. If validation fails → fix → re-validate
4. Only proceed when validation passes
```

#### Checklists for multi-step workflows

```markdown
## Deployment workflow
- [ ] Step 1: Run tests (`bun test`)
- [ ] Step 2: Build (`bun run build`)
- [ ] Step 3: Validate output (`scripts/validate.sh`)
- [ ] Step 4: Deploy (`scripts/deploy.sh`)
```

#### Calibrate control to fragility

- **Flexible tasks** (code review, analysis): explain *what to look for* and *why*
- **Fragile tasks** (migrations, deployments): prescribe *exact commands*, no deviation

### Reference Files

Each file in `references/` should be:
- **One topic per file** with descriptive filename (`api-endpoints.md`, not `ref1.md`)
- **Self-contained** — makes sense on its own
- **Referenced from SKILL.md** with a clear trigger for when to load it

### Bundling Scripts

When you notice the agent reinventing the same logic across runs, write a tested script in `scripts/`:

- **No interactive prompts** — accept all input via flags/env/stdin
- **Include `--help`** — the agent uses this to learn the interface
- **Helpful error messages** — say what went wrong, what was expected, what to try
- **Structured output** — prefer JSON/CSV over free-form text
- **Idempotent** — agents retry; "create if not exists" > "create and fail on duplicate"

## Iteration

After creating a skill, test it against real tasks. Then refine:

- **Undertriggering?** Add more trigger phrases and keywords to the description
- **Overtriggering?** Be more specific; add negative context ("Do NOT use for...")
- **Instructions ignored?** Move critical rules to the top, use bullet points
- **Agent wastes steps?** Instructions may be too vague or include irrelevant options
- **Repeated mistakes?** Add to gotchas section — this is the most direct improvement path

For rigorous iteration with eval frameworks, benchmarking, and description optimization, use the `skill-creator` skill instead — it provides a full workflow with test cases, grading, and automated description tuning.
