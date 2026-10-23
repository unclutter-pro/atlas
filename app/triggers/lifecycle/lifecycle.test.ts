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

// Simulates a crash inside task-session.sh: neither "nothing open" (0) nor
// "block" (2) — an exit code the gate was never meant to produce.
function stubTaskGateCrash(code: number) {
  const script = join(lifecycle, "task-session.sh");
  writeFileSync(script, `#!/bin/bash\n[ "$1" = check ] && exit ${code}\nexit 0\n`);
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

  test("blocks instead of allowing stop when task-session.sh check crashes with an unexpected exit code", () => {
    stubTaskGateCrash(3);
    const r = run([join(lifecycle, "stop.sh")], trigger);
    expect(r.code).toBe(2);
    expect(r.out).toContain("exit 3");
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

  test("still blocks if jq is unavailable to render the decision JSON", () => {
    stubTaskGate("You have 1 open task(s).");
    // A PATH with no jq on it at all.
    const binDir = join(root, "bin-no-jq");
    mkdirSync(binDir);
    for (const bin of ["bash", "cat", "date", "ls", "grep", "sed", "bun", "dirname"]) {
      const real = Bun.spawnSync(["which", bin]).stdout.toString().trim();
      if (real) writeFileSync(join(binDir, bin), `#!/bin/bash\nexec ${real} "$@"\n`), chmodSync(join(binDir, bin), 0o755);
    }
    const r = run([join(hooks, "stop.sh")], { ...trigger, PATH: binDir }, "{}");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).decision).toBe("block");
  });

  test("still blocks if jq itself fails", () => {
    stubTaskGate("You have 1 open task(s).");
    const binDir = join(root, "bin-broken-jq");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "jq"), "#!/bin/bash\nexit 1\n");
    chmodSync(join(binDir, "jq"), 0o755);
    const r = run([join(hooks, "stop.sh")], { ...trigger, PATH: `${binDir}:${process.env.PATH}` }, "{}");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).decision).toBe("block");
  });
});

describe("command advice", () => {
  const a = (...args: string[]) => run([join(lifecycle, "command-advice.sh"), ...args]);

  test("advises the reminder CLI for polling commands only", () => {
    expect(a("while true; do curl x; sleep 30; done").out).toContain("reminder add");
    expect(a("sleep 5m").out).toContain("reminder add");
    expect(a("sleep 2 && ls").out).toBe("");
    expect(a("git status").out).toBe("");
  });

  test("also matches gh --watch, kubectl --watch/-w and a timeout of a minute or more", () => {
    expect(a("gh run watch 123 --watch").out).toContain("reminder add");
    expect(a("kubectl get pods -w").out).toContain("reminder add");
    expect(a("kubectl rollout status deploy/x --watch").out).toContain("reminder add");
    expect(a("timeout 600 some-script.sh").out).toContain("reminder add");
    expect(a("timeout 10 some-script.sh").out).toBe(""); // short timeout, not a long wait
  });

  test("blocks a foreground wait in a chat session with a reason, not just advice", () => {
    const blocked = a("sleep 580", "false", "signal");
    expect(blocked.code).toBe(2);
    expect(blocked.out).toContain("run_in_background");
    expect(blocked.out).toContain("reminder add");
  });

  test.each(["signal", "whatsapp", "telegram", "web"])("treats channel=%s as a live chat session", (channel) => {
    expect(a("sleep 580", "false", channel).code).toBe(2);
  });

  test("allows the same command in a chat session once it is backgrounded", () => {
    const bg = a("sleep 580", "true", "signal");
    expect(bg.code).toBe(0);
    expect(bg.out).toContain("reminder add");
  });

  test("does not block outside a chat session, or without the new args (legacy call)", () => {
    expect(a("sleep 580", "false", "email").code).toBe(0);
    expect(a("sleep 580", "false", "cron").code).toBe(0);
    expect(a("sleep 580").code).toBe(0); // legacy 1-arg call keeps advisory-only behaviour
  });

  test("the Claude PreToolUse hook wraps advice as additionalContext", () => {
    const hook = join(hooks, "remind-use-reminders.sh");
    const poll = run([hook], {}, JSON.stringify({ tool_input: { command: "sleep 600" } }));
    expect(JSON.parse(poll.out).hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse" });
    expect(JSON.parse(poll.out).hookSpecificOutput.additionalContext).toContain("reminder add");
    expect(run([hook], {}, JSON.stringify({ tool_input: { command: "ls" } }))).toEqual({ code: 0, out: "" });
    expect(run([hook], {}, "not json")).toEqual({ code: 0, out: "" });
  });

  test("the Claude PreToolUse hook denies a foreground wait in a chat session", () => {
    const hook = join(hooks, "remind-use-reminders.sh");
    const denied = run([hook], { ATLAS_TRIGGER_CHANNEL: "signal" }, JSON.stringify({ tool_input: { command: "sleep 600" } }));
    expect(denied.code).toBe(0);
    expect(JSON.parse(denied.out).hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(JSON.parse(denied.out).hookSpecificOutput.permissionDecisionReason).toContain("run_in_background");
  });

  test("the Claude PreToolUse hook allows the same command once run_in_background is set", () => {
    const hook = join(hooks, "remind-use-reminders.sh");
    const allowed = run([hook], { ATLAS_TRIGGER_CHANNEL: "signal" }, JSON.stringify({ tool_input: { command: "sleep 600", run_in_background: true } }));
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.out).hookSpecificOutput.additionalContext).toContain("reminder add");
  });

  test("still denies if jq fails to render the decision JSON (but can still read the command)", () => {
    const hook = join(hooks, "remind-use-reminders.sh");
    const binDir = join(root, "bin-broken-jq-pretool");
    mkdirSync(binDir);
    for (const bin of ["bash", "cat", "grep", "dirname"]) {
      const real = Bun.spawnSync(["which", bin]).stdout.toString().trim();
      if (real) writeFileSync(join(binDir, bin), `#!/bin/bash\nexec ${real} "$@"\n`), chmodSync(join(binDir, bin), 0o755);
    }
    // Real jq for reading tool_input (-r calls), but fails for rendering the decision (-n calls).
    const realJq = Bun.spawnSync(["which", "jq"]).stdout.toString().trim();
    writeFileSync(join(binDir, "jq"), `#!/bin/bash\n[ "$1" = "-n" ] && exit 1\nexec ${realJq} "$@"\n`);
    chmodSync(join(binDir, "jq"), 0o755);
    const r = run([hook], { ATLAS_TRIGGER_CHANNEL: "signal", PATH: binDir }, JSON.stringify({ tool_input: { command: "sleep 600" } }));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe("deny");
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
