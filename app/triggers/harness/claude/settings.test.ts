import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeBackend } from "./backend.ts";
import { configureClaude, HOOKS_DIR, LIFECYCLE_DIR } from "./settings.ts";

let home: string;
const saved = { skills: process.env.ATLAS_DEFAULT_SKILLS_DIR, agents: process.env.ATLAS_DEFAULT_AGENTS_DIR };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "atlas-claude-settings-"));
  delete process.env.ATLAS_DEFAULT_SKILLS_DIR;
  delete process.env.ATLAS_DEFAULT_AGENTS_DIR;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of [["ATLAS_DEFAULT_SKILLS_DIR", saved.skills], ["ATLAS_DEFAULT_AGENTS_DIR", saved.agents]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const settings = () => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
const commands = (s: any, event: string) => s.hooks[event].flatMap((m: any) => m.hooks.map((h: any) => h.command ?? h.type));

describe("configureClaude", () => {
  test("writes hooks from this adapter's hook directory, permissions and plugins", () => {
    writeFileSync(join(home, "config.yml"), "agent:\n  name: Nova\n  email: nova@example.com\nplugins:\n  enabled:\n    \"x@m\": true\n");
    configureClaude(home);
    const s = settings();
    expect(commands(s, "SessionStart")).toEqual([`${LIFECYCLE_DIR}/session-start.sh`, `${LIFECYCLE_DIR}/task-session.sh start`]);
    expect(commands(s, "PreCompact")).toEqual([`${LIFECYCLE_DIR}/pre-compact.sh auto`, `${LIFECYCLE_DIR}/pre-compact.sh manual`]);
    expect(commands(s, "Stop")).toEqual([`${HOOKS_DIR}/stop.sh`]);
    expect(commands(s, "PreToolUse")).toEqual(["rtk hook claude", `${HOOKS_DIR}/remind-use-reminders.sh`]);
    expect(s.hooks.SubagentStop[0].hooks[0]).toMatchObject({ type: "prompt" });
    expect(s.permissions.deny).toContain(`Write(${home}/.claude/settings.json)`);
    expect(s.enabledPlugins["x@m"]).toBe(true);
    expect(s.attribution.commit).toBe("Co-Authored-By: Nova <nova@example.com>");
  });

  test("every hook command points at a script that exists in the repo", () => {
    configureClaude(home, { hooksDir: import.meta.dir + "/hooks", lifecycleDir: join(import.meta.dir, "../../lifecycle") });
    const all = Object.keys(settings().hooks).flatMap((event) => commands(settings(), event));
    for (const command of all.filter((c: string) => c.startsWith("/"))) {
      expect(existsSync(command.split(" ")[0]!)).toBe(true);
    }
  });

  test("installs default skills and agents from mounted directories", () => {
    const skills = join(home, "mounted-skills");
    const agents = join(home, "mounted-agents");
    mkdirSync(skills);
    mkdirSync(agents);
    writeFileSync(join(skills, "deploy.md"), "# deploy");
    writeFileSync(join(agents, "helper.md"), "# helper");
    process.env.ATLAS_DEFAULT_SKILLS_DIR = skills;
    process.env.ATLAS_DEFAULT_AGENTS_DIR = agents;
    configureClaude(home);
    expect(readFileSync(join(home, ".claude", "skills", "deploy", "SKILL.md"), "utf8")).toBe("# deploy");
    expect(readFileSync(join(home, ".claude", "agents", "helper.md"), "utf8")).toBe("# helper");
  });

  test("migrates legacy ~/skills and ~/agents and removes broken skill symlinks", () => {
    mkdirSync(join(home, "skills", "old-skill"), { recursive: true });
    mkdirSync(join(home, "agents"));
    writeFileSync(join(home, "agents", "old-agent.md"), "x");
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(join(home, "nowhere"), join(home, ".claude", "skills", "dangling"));
    configureClaude(home);
    expect(readdirSync(join(home, ".claude", "skills"))).toEqual(["old-skill"]);
    expect(existsSync(join(home, ".claude", "agents", "old-agent.md"))).toBe(true);
    expect(existsSync(join(home, "skills"))).toBe(false);
    expect(existsSync(join(home, "agents"))).toBe(false);
  });

  test("keeps a legacy entry and its directory when the target already exists", () => {
    mkdirSync(join(home, "skills", "deploy"), { recursive: true });
    writeFileSync(join(home, "skills", "deploy", "SKILL.md"), "legacy version");
    mkdirSync(join(home, ".claude", "skills", "deploy"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "deploy", "SKILL.md"), "current version");
    configureClaude(home);
    expect(existsSync(join(home, "skills", "deploy"))).toBe(true);
    expect(readFileSync(join(home, ".claude", "skills", "deploy", "SKILL.md"), "utf8")).toBe("current version");
  });
});

describe("Claude prompt extension", () => {
  test("carries the invocation syntax the shared prompt leaves out", () => {
    const extension = new ClaudeCodeBackend({ home }).promptExtension;
    for (const needle of ['Agent(subagent_type="memory-searcher"', 'Agent(subagent_type="general-purpose"', 'Skill(skill=', "~/.claude/skills/", "`Workflow` tool", "fast = `haiku`"]) {
      expect(extension).toContain(needle);
    }
  });

  test("shared prompts name concepts, not Claude Code syntax", () => {
    const appDir = join(import.meta.dir, "..", "..", "..");
    const shared = [
      ...readdirSync(join(appDir, "prompts")).map((f) => join(appDir, "prompts", f)),
      join(appDir, "defaults", "triggers", "dreaming", "prompt.md"),
    ];
    for (const file of shared) {
      const text = readFileSync(file, "utf8");
      for (const pattern of [/\bAgent\(/, /\bSkill\(/, /~\/\.claude\//, /subagent_type/]) {
        expect({ file, match: pattern.test(text) }).toEqual({ file, match: false });
      }
    }
  });
});
