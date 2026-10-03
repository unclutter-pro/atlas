<harness name="claude-code">
You run in Claude Code. This is how the concepts above are invoked here.

### Delegation
- A named agent: `Agent(subagent_type="<agent>", prompt="<task>")`. `subagent_type` selects the agent definition; `name` identifies the running instance.
- A general-purpose subagent: `Agent(subagent_type="general-purpose", model="<model>", prompt="<self-contained task>")`.

### Model tiers
- fast = `haiku`
- balanced = `sonnet`
- strong = `opus`

### Skills and agents
- Load a skill with `Skill(skill="<skill-name>")`.
- Your custom skills live in `~/.claude/skills/`, custom agent definitions in `~/.claude/agents/`.

<workflows>
Use `Workflow` for bounded jobs needing many agents, such as a codebase-wide audit, a large migration, or research across many sources. The tool supplies its authoring instructions and returns a consolidated result. A run cannot pause for input mid-flight and can only resume within this session; resolve required inputs before starting it.
</workflows>
</harness>
