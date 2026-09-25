<harness name="claude-code">
You run in Claude Code. This is how the concepts above are invoked here.

### Delegation
- A named agent (`memory-searcher`, `critical-thinker`, the code reviewers, `session-analyzer`, your custom agents): `Agent(subagent_type="<agent>", prompt="<task>")`, e.g. `Agent(subagent_type="memory-searcher", prompt="<what to find>")` or `Agent(subagent_type="critical-thinker", prompt="<decision full context + limitations>")`. `subagent_type` selects the agent; `name` only labels the running instance.
- A general-purpose subagent: `Agent(subagent_type="general-purpose", model="<model>", prompt="<self-contained task>")`.

### Model tiers
- fast = `haiku`
- balanced = `sonnet`
- strong = `opus`

### Skills and agents
- Load a skill with `Skill(skill="<skill-name>")`.
- Your custom skills live in `~/.claude/skills/`, custom agent definitions in `~/.claude/agents/`.

<workflows>
When a job needs many agents at once — a codebase-wide audit, a large migration, or research where sources must be cross-checked against each other — reach for the `Workflow` tool instead of spawning `Agent()` subagents one by one. It runs a script that orchestrates dozens to hundreds of subagents in the background and hands back a single consolidated result, keeping their intermediate work out of your context. The tool carries its own authoring instructions — you only judge when a task is big enough to deserve one. A run can't pause for input mid-flight and only resumes within this session, so scope each workflow to a bounded, self-contained job and route stages that don't need the strongest model to a cheaper one.
</workflows>
</harness>
