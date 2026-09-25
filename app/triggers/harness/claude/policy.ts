/**
 * Built-in Claude Code tools we never want a trigger session to see or use.
 *
 * settings.json `permissions.deny` only blocks execution — the model is still
 * told the tool exists, which leaks into the system prompt. `disallowedTools`
 * on the SDK query options removes the tool from the disclosure entirely.
 *
 * Keep in sync with the deny list in settings.ts (this directory).
 */
export const DISALLOWED_BUILTIN_TOOLS = [
  // Cron management — exposed via dedicated trigger commands, not LLM tools
  "CronCreate",
  "CronDelete",
  "CronList",
  // Scheduling - we have reminder cli for that
  "ScheduleWakeup",
  // Plan mode is a Claude Code interactive UX concept; trigger sessions are headless
  "EnterPlanMode",
  "ExitPlanMode",
  // Worktrees are managed by the harness, not by the agent
  "EnterWorktree",
  "ExitWorktree",
  // Atlas tracks tasks via its own CLI, never via Claude Code's built-ins
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  // No interactive user-question loop in trigger sessions
  "AskUserQuestion",
  // Teams feature disabled — agent runs without teammate coordination
  "TeamCreate",
  "TeamDelete",
  "SendMessage",
];

/**
 * Tools disallowed for the validator session.
 * The validator is read-only — it may inspect files but must not write anything,
 * spawn agents, or access task/goal/reminder state.
 */
export const DISALLOWED_VALIDATOR_TOOLS = [
  ...DISALLOWED_BUILTIN_TOOLS,
  // Write tools — validator is strictly read-only
  "Edit",
  "Write",
  "NotebookEdit",
  // MCP tools — no external access
  "mcp__*",
  // Agent spawning
  "Agent",
];


export const NATIVE_TOOLS = {
  "files.read": ["Read", "Glob", "Grep"],
  "files.write": ["Write", "Edit", "NotebookEdit"],
  "process.exec": ["Bash"],
  "network.fetch": ["WebFetch"],
};
