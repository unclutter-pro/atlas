/**
 * Claude Code configuration for an Atlas deployment: ~/.claude/settings.json
 * (hooks, permissions, plugins, attribution), the trigger MCP file, and the
 * skill and agent directories. Written from Atlas config by
 * HarnessBackend.configure() at container start and after settings changes.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expandModelName, resolveConfig } from "../../../lib/config.ts";

/** Hook scripts of this adapter, as installed in the image. */
export const HOOKS_DIR = "/atlas/app/triggers/harness/claude/hooks";

const SUBAGENT_STOP_PROMPT = [
  "A subagent has completed their task. Review the result in $ARGUMENTS.",
  "",
  "Evaluate:",
  "1. Was the original task fully completed?",
  "2. Are there obvious errors or gaps?",
  "3. Is the result acceptable or does it need rework?",
  "",
  'Respond with JSON: {"ok": true/false, "reason": "brief explanation"}',
  'Use "ok": false only if the result is clearly incomplete or wrong.',
].join("\n");

/** settings.json content for this deployment. */
export function claudeSettings(home: string, hooksDir = HOOKS_DIR): Record<string, unknown> {
  const config = resolveConfig(home);
  const agentEmail = config.agent?.email;
  // Attribution: the agent's email when configured, otherwise no co-authored-by.
  const commitAttribution = agentEmail ? `Co-Authored-By: ${config.agent.name || "Atlas"} <${agentEmail}>` : "";
  const taskSession = `${hooksDir}/task-session.sh`;

  return {
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    attribution: {
      commit: commitAttribution,
      pr: "",
    },
    enabledPlugins: { ...config.plugins.enabled },
    permissions: {
      allow: ["Bash(*)", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "mcp__*"],
      // Keep in sync with DISALLOWED_BUILTIN_TOOLS in policy.ts (which also hides them).
      deny: [
        "Write(/atlas/app/**)",
        "Edit(/atlas/app/**)",
        "Write(/atlas/logs/**)",
        "Edit(/atlas/logs/**)",
        `Write(${home}/.claude/settings.json)`,
        `Edit(${home}/.claude/settings.json)`,
        "TodoWrite",
        "TaskCreate",
        "TaskUpdate",
        "TaskList",
        "TaskGet",
        "EnterPlanMode",
        "ExitPlanMode",
        "EnterWorktree",
        "AskUserQuestion",
      ],
    },
    hooks: {
      SessionStart: [
        {
          hooks: [
            { type: "command", command: `${hooksDir}/session-start.sh` },
            { type: "command", command: `${taskSession} start` },
          ],
        },
      ],
      // Task completion gate, validator format gate and journal reminder.
      Stop: [{ hooks: [{ type: "command", command: `${hooksDir}/stop.sh` }] }],
      PostCompact: [{ hooks: [{ type: "command", command: `${hooksDir}/post-compact.sh` }] }],
      PreCompact: [
        { matcher: "auto", hooks: [{ type: "command", command: `${hooksDir}/pre-compact-auto.sh` }] },
        { matcher: "manual", hooks: [{ type: "command", command: `${hooksDir}/pre-compact-manual.sh` }] },
      ],
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "rtk hook claude" },
            // Nudge toward the reminder CLI when a Bash command polls/sleeps to
            // wait on an event — Atlas is event-driven ("no polling"). Advisory
            // only: emits additionalContext, never blocks.
            { type: "command", command: `${hooksDir}/remind-use-reminders.sh` },
          ],
        },
      ],
      SubagentStop: [
        {
          hooks: [{ type: "prompt", prompt: SUBAGENT_STOP_PROMPT, model: expandModelName(config.models.subagent_review) }],
        },
      ],
    },
  };
}

/** Copy `*.md` files from a mounted directory (e.g. a ConfigMap) into place. */
function installMarkdown(from: string | undefined, target: (name: string) => string, log: string[], what: string): void {
  if (!from || !existsSync(from)) return;
  for (const file of readdirSync(from)) {
    if (!file.endsWith(".md")) continue;
    const dest = target(basename(file, ".md"));
    mkdirSync(join(dest, ".."), { recursive: true });
    copyFileSync(join(from, file), dest);
    log.push(`Installed default ${what}: ${basename(file, ".md")}`);
  }
}

/** Move entries of a legacy directory into the new one, then remove it. */
function migrateLegacy(from: string, to: string, log: string[], what: string, filter: (name: string) => boolean): void {
  if (!existsSync(from)) return;
  for (const name of readdirSync(from)) {
    if (!filter(name) || existsSync(join(to, name))) continue;
    renameSync(join(from, name), join(to, name));
    log.push(`Migrated ${what}: ${name} → ${to}`);
  }
  rmSync(from, { recursive: true, force: true });
}

/**
 * Skill and agent directories. System defaults live in the image under
 * /etc/claude-code/.claude/ (Dockerfile); user-created ones in ~/.claude/.
 */
function prepareSkillsAndAgents(home: string, log: string[]): void {
  const skills = join(home, ".claude", "skills");
  const agents = join(home, ".claude", "agents");
  mkdirSync(skills, { recursive: true });
  mkdirSync(agents, { recursive: true });

  installMarkdown(process.env.ATLAS_DEFAULT_SKILLS_DIR, (name) => join(skills, name, "SKILL.md"), log, "skill");
  installMarkdown(process.env.ATLAS_DEFAULT_AGENTS_DIR, (name) => join(agents, `${name}.md`), log, "agent");

  // Broken symlinks left from earlier boot cycles.
  for (const name of readdirSync(skills)) {
    const path = join(skills, name);
    try {
      if (lstatSync(path).isSymbolicLink() && !existsSync(path)) {
        rmSync(path, { force: true });
        log.push(`Removed broken skill symlink: ${name}`);
      }
    } catch {}
  }
  // Legacy ~/skills/ and ~/agents/ locations.
  migrateLegacy(join(home, "skills"), skills, log, "skill", (name) => {
    try {
      return statSync(join(home, "skills", name)).isDirectory();
    } catch {
      return false;
    }
  });
  migrateLegacy(join(home, "agents"), agents, log, "agent", (name) => name.endsWith(".md"));
}

/** Write the whole Claude Code configuration; returns a one-line summary per step. */
export function configureClaude(home: string, options: { hooksDir?: string; appDir?: string } = {}): string[] {
  const log: string[] = [];
  const settingsPath = join(home, ".claude", "settings.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const settings = claudeSettings(home, options.hooksDir);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  const config = resolveConfig(home);
  log.push(`Settings written: ${settingsPath} (subagent_review=${expandModelName(config.models.subagent_review)})`);

  // Trigger MCP config from the image's base .mcp.json.
  const mcpBase = join(options.appDir ?? "/atlas/app", ".mcp.json");
  try {
    writeFileSync(join(home, ".mcp-trigger.json"), JSON.stringify(JSON.parse(readFileSync(mcpBase, "utf8")), null, 2) + "\n");
    log.push(`Trigger MCP config generated: ${join(home, ".mcp-trigger.json")}`);
  } catch (err) {
    log.push(`Warning: could not generate trigger MCP config: ${err}`);
  }

  prepareSkillsAndAgents(home, log);
  log.push(`Skills: ${join(home, ".claude", "skills")}, agents: ${join(home, ".claude", "agents")}`);
  return log;
}
