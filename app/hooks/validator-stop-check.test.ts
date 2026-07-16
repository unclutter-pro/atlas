/**
 * Tests for the validator Stop-hook gate (validator-stop-check.ts).
 * Run with: cd app && bun test hooks/validator-stop-check.test.ts
 *
 * The hook is exercised as a subprocess (matching how Claude Code invokes it):
 * stdin = hook JSON, stdout = "" (allow stop) or {"decision":"block",...}.
 */
import { test, describe, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "validator-stop-check.ts");

const CORRECTION_MARKER = "Invalid format. Please respond in the following JSON format only:";

function assistantEvent(text: string): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
}

/** A prior injected correction, as it appears back in the transcript. */
function correctionEvent(): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: CORRECTION_MARKER }] } });
}

function writeTranscript(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "vsc-"));
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

async function runHook(stdin: string): Promise<string> {
  const proc = Bun.spawn(["bun", HOOK], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(stdin);
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

describe("validator-stop-check", () => {
  test("allows stop when the last assistant message is a valid verdict", async () => {
    const path = writeTranscript([
      assistantEvent("Let me check the files."),
      assistantEvent(`{"verdict": "pass", "feedback": "done condition met"}`),
    ]);
    const out = await runHook(JSON.stringify({ transcript_path: path }));
    expect(out).toBe("");
  });

  test("blocks and reprompts with the exact format-correction when the last message is prose", async () => {
    const path = writeTranscript([
      assistantEvent("I reviewed the work and it looks complete to me, nice job!"),
    ]);
    const out = await runHook(JSON.stringify({ transcript_path: path }));
    const parsed = JSON.parse(out);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain(CORRECTION_MARKER);
    expect(parsed.reason).toContain(`"verdict"`);
  });

  test("blocks when JSON is present but verdict value is invalid", async () => {
    const path = writeTranscript([
      assistantEvent(`{"verdict": "looks-good", "feedback": "all fine"}`),
    ]);
    const out = await runHook(JSON.stringify({ transcript_path: path }));
    expect(JSON.parse(out).decision).toBe("block");
  });

  test("keeps reprompting while under the cap, even when stop_hook_active is true", async () => {
    // stop_hook_active no longer caps the loop — the correction count does.
    const path = writeTranscript([
      correctionEvent(),
      assistantEvent("still not valid json"),
    ]);
    const out = await runHook(JSON.stringify({ transcript_path: path, stop_hook_active: true }));
    expect(JSON.parse(out).decision).toBe("block");
  });

  test("allows stop after MAX_REPROMPTS (3) corrections have already been issued", async () => {
    const path = writeTranscript([
      correctionEvent(),
      correctionEvent(),
      correctionEvent(),
      assistantEvent("still not valid json after three tries"),
    ]);
    const out = await runHook(JSON.stringify({ transcript_path: path }));
    expect(out).toBe("");
  });

  test("fails open (allows stop) when no transcript_path is provided", async () => {
    const out = await runHook(JSON.stringify({ stop_hook_active: false }));
    expect(out).toBe("");
  });

  test("fails open on unparseable hook input", async () => {
    const out = await runHook("not json at all");
    expect(out).toBe("");
  });
});
