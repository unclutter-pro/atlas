/**
 * Atlas lifecycle policy contracts (backend-neutral) and the Claude Code
 * protocol wrappers around them.
 *
 * Policy: context text on stdout; stop gates exit 2 with the reason on stdout.
 * Claude wrappers: Stop → {"decision":"block","reason":...};
 * PreToolUse → {"hookSpecificOutput":{"additionalContext":...}}.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORRECTION_REASON, MAX_REPROMPTS, validatorGate } from "./validator-gate.ts";

let root: string;
let home: string;
let lifecycle: string;
let hooks: string;

// A copy of lifecycle/ and the Claude hooks in their repo layout, so the
// task gate can be stubbed without touching the task database.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "atlas-lifecycle-"));
  home = join(root, "home");
  lifecycle = join(root, "triggers", "lifecycle");
  hooks = join(root, "triggers", "harness", "claude", "hooks");
  mkdirSync(home);
  cpSync(import.meta.dir, lifecycle, { recursive: true });
  cpSync(join(import.meta.dir, "..", "harness", "claude", "hooks"), hooks, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function stubTaskGate(reason: string | null) {
  const script = join(lifecycle, "task-session.sh");
  writeFileSync(script, reason === null ? "#!/bin/bash\nexit 0\n" : `#!/bin/bash\n[ "$1" = check ] && { echo "${reason}"; exit 2; }\nexit 0\n`);
  chmodSync(script, 0o755);
}

function run(cmd: string[], env: Record<string, string> = {}, stdin = "") {
  const proc = Bun.spawnSync(cmd, {
    env: { PATH: process.env.PATH!, HOME: home, ...env },
    stdin: new TextEncoder().encode(stdin),
  });
  return { code: proc.exitCode, out: proc.stdout.toString().trim() };
}

const trigger = { ATLAS_TRIGGER: "signal-chat", ATLAS_TRIGGER_SESSION_KEY: "+49" };

describe("stop policy", () => {
  test("blocks with the task gate's reason (exit 2)", () => {
    stubTaskGate("You have 1 open task(s).");
    expect(run([join(lifecycle, "stop.sh")], trigger)).toEqual({ code: 2, out: "You have 1 open task(s)." });
  });

  test("the kill switch skips the task gate", () => {
    stubTaskGate("You have 1 open task(s).");
    const r = run([join(lifecycle, "stop.sh")], { ...trigger, ATLAS_TASKS_DISABLE_GATE: "1" });
    expect(r).toEqual({ code: 0, out: "" });
  });

  test("reminds trigger sessions to write today's journal, until it exists", () => {
    stubTaskGate(null);
    const first = run([join(lifecycle, "stop.sh")], trigger);
    expect(first.code).toBe(0);
    expect(first.out).toContain("JOURNAL REMINDER");
    const today = new Date().toLocaleDateString("sv-SE");
    mkdirSync(join(home, "memory", "journal"), { recursive: true });
    writeFileSync(join(home, "memory", "journal", `${today}.md`), "# day");
    expect(run([join(lifecycle, "stop.sh")], trigger)).toEqual({ code: 0, out: "" });
  });

  test("leaves the validator session to the validator gate", () => {
    stubTaskGate("You have 1 open task(s).");
    expect(run([join(lifecycle, "stop.sh")], { ...trigger, ATLAS_TRIGGER_CHANNEL: "validator" })).toEqual({ code: 0, out: "" });
  });
});

describe("Claude Stop hook", () => {
  test("turns a policy block into Claude's decision JSON", () => {
    stubTaskGate("You have 2 open task(s).");
    const r = run([join(hooks, "stop.sh")], trigger, "{}");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ decision: "block", reason: "You have 2 open task(s)." });
  });

  test("passes context text through and allows the stop", () => {
    stubTaskGate(null);
    const r = run([join(hooks, "stop.sh")], trigger, "{}");
    expect(r.code).toBe(0);
    expect(r.out).toContain("JOURNAL REMINDER");
  });
});

describe("command advice", () => {
  test("advises the reminder CLI for polling commands only", () => {
    expect(run([join(lifecycle, "command-advice.sh"), "while true; do curl x; sleep 30; done"]).out).toContain("reminder add");
    expect(run([join(lifecycle, "command-advice.sh"), "sleep 5m"]).out).toContain("reminder add");
    expect(run([join(lifecycle, "command-advice.sh"), "sleep 2 && ls"]).out).toBe("");
    expect(run([join(lifecycle, "command-advice.sh"), "git status"]).out).toBe("");
  });

  test("the Claude PreToolUse hook wraps it as additionalContext", () => {
    const hook = join(hooks, "remind-use-reminders.sh");
    const poll = run([hook], {}, JSON.stringify({ tool_input: { command: "sleep 600" } }));
    expect(JSON.parse(poll.out).hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse" });
    expect(JSON.parse(poll.out).hookSpecificOutput.additionalContext).toContain("reminder add");
    expect(run([hook], {}, JSON.stringify({ tool_input: { command: "ls" } }))).toEqual({ code: 0, out: "" });
    expect(run([hook], {}, "not json")).toEqual({ code: 0, out: "" });
  });
});

describe("compaction and session start", () => {
  test("pre-compact asks for a memory flush, more thoroughly when manual", () => {
    const auto = run([join(lifecycle, "pre-compact.sh"), "auto"]);
    const manual = run([join(lifecycle, "pre-compact.sh"), "manual"]);
    expect(auto.out).toContain("Context is about to be compressed.");
    expect(manual.out).toContain("Manual compaction requested. Consolidate ALL important findings:");
  });

  test("session start emits long-term memory", () => {
    mkdirSync(join(home, "memory"), { recursive: true });
    writeFileSync(join(home, "memory", "MEMORY.md"), "remember this\n");
    expect(run([join(lifecycle, "session-start.sh")]).out).toContain("<long-term-memory>\nremember this\n</long-term-memory>");
  });
});

describe("validatorGate", () => {
  test("allows a parseable verdict or an empty turn, corrects anything else a bounded number of times", () => {
    expect(validatorGate('{"verdict": "pass", "feedback": "ok"}', 0)).toBeNull();
    expect(validatorGate("", 0)).toBeNull();
    expect(validatorGate("I think it passes.", 0)).toBe(CORRECTION_REASON);
    expect(validatorGate("I think it passes.", MAX_REPROMPTS)).toBeNull();
  });
});
