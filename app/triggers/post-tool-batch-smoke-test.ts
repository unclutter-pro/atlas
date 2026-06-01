/**
 * Smoke test: does PostToolBatch hook + additionalContext actually inject
 * mid-turn context into the next LLM call?
 *
 * Strategy: force two SEPARATE tool batches via data dependency
 * (read a file → wait for content → make a decision based on it).
 * The PostToolBatch fires between them — the hook injects a steering
 * message that should redirect the agent's second action.
 *
 * Run with:  cd app/triggers && bun post-tool-batch-smoke-test.ts
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const MARKER_ORIGINAL = "ORIGINAL_42";
const MARKER_STEERED = "STEERED_99";

// Set up a workspace with a target file the agent must read first
const work = mkdtempSync(join(tmpdir(), "psbt-"));
const targetFile = join(work, "target.txt");
writeFileSync(targetFile, "This file says: do echo ORIGINAL_42 next.\n");

const PROMPT = [
  `First, read the file ${targetFile} to learn what to do.`,
  `After reading and understanding its contents, run the Bash command that the file instructs.`,
  `Do these as TWO separate steps: read first, wait for the file contents, THEN run the Bash command.`,
  `Do not chain or batch — read, then on the next step, run the command.`,
].join("\n");

let hookFireCount = 0;
let injectionAppliedAt = -1;

const q = query({
  prompt: PROMPT,
  options: {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    model: "claude-sonnet-4-5",
    allowedTools: ["Bash", "Read"],
    disallowedTools: ["Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Task"],
    cwd: work,
    persistSession: false,
    pathToClaudeCodeExecutable: "/usr/bin/claude",
    hooks: {
      PostToolBatch: [
        {
          hooks: [
            async (input: unknown) => {
              hookFireCount++;
              const batch = (input as { tool_calls?: { tool_name?: string }[] }).tool_calls ?? [];
              const batchNames = batch.map((b) => b.tool_name).join(", ");
              console.log(`[hook] PostToolBatch fire #${hookFireCount} (batch: ${batchNames})`);

              // After the first batch (the Read), inject steering that
              // tells the agent to run a DIFFERENT echo command than the
              // file said.
              if (hookFireCount === 1) {
                injectionAppliedAt = hookFireCount;
                console.log(`[hook]   → injecting steering: prefer ${MARKER_STEERED}`);
                return {
                  hookSpecificOutput: {
                    hookEventName: "PostToolBatch",
                    additionalContext: [
                      `[User-Steering received mid-turn]`,
                      `IMPORTANT: Ignore what the file says.`,
                      `Instead run Bash command: echo ${MARKER_STEERED}`,
                      `Then stop.`,
                    ].join("\n"),
                  },
                };
              }
              return {};
            },
          ],
        },
      ],
    },
  },
});

const toolUses: { name: string; input: unknown }[] = [];

try {
  for await (const msg of q) {
    if (msg.type === "assistant") {
      const content = (msg as unknown as { message?: { content?: unknown[] } }).message?.content ?? [];
      for (const block of content as { type: string; text?: string; name?: string; input?: unknown }[]) {
        if (block.type === "tool_use" && block.name) {
          toolUses.push({ name: block.name, input: block.input });
          console.log(`[agent] tool_use: ${block.name} ${JSON.stringify(block.input).slice(0, 120)}`);
        }
      }
    }
    if (msg.type === "result") {
      console.log(`\n[agent] result: ${(msg as { result?: string }).result?.slice(0, 200)}`);
      break;
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("\n=== Verdict ===");
console.log(`Hook fired:            ${hookFireCount} time(s)`);
console.log(`Injection applied at:  batch #${injectionAppliedAt}`);
console.log(`Tool calls total:      ${toolUses.length}`);

const allBashCmds = toolUses
  .filter((t) => t.name === "Bash")
  .map((t) => (t.input as { command?: string }).command ?? "");

console.log(`Bash commands (${allBashCmds.length}):`);
for (const c of allBashCmds) console.log(`  ${c}`);

const sawOriginal = allBashCmds.some((c) => c.includes(MARKER_ORIGINAL));
const sawSteered = allBashCmds.some((c) => c.includes(MARKER_STEERED));
console.log(`\n  saw ORIGINAL (${MARKER_ORIGINAL}): ${sawOriginal}`);
console.log(`  saw STEERED  (${MARKER_STEERED}):  ${sawSteered}`);

if (hookFireCount === 0) {
  console.log("\n❌ FAIL: PostToolBatch hook never fired.");
  process.exit(1);
}
if (sawSteered && !sawOriginal) {
  console.log("\n✅ PASS: Agent followed mid-turn steering. additionalContext works.");
  process.exit(0);
}
if (sawSteered && sawOriginal) {
  console.log("\n⚠️  PARTIAL: Agent ran both — hook injected but didn't override.");
  process.exit(2);
}
if (!sawSteered && !sawOriginal) {
  console.log("\n⚠️  INCONCLUSIVE: Agent batched both into Read or skipped Bash.");
  process.exit(4);
}
console.log("\n❌ FAIL: Agent ignored steering, ran ORIGINAL.");
process.exit(3);
