#!/usr/bin/env bun
/**
 * Stop-hook gate for the goal-validator session (channel = "validator").
 *
 * The validator must end its turn with exactly one parseable JSON verdict line:
 *   {"verdict": "pass" | "fail", "feedback": "..."}
 *
 * If the final assistant message isn't parseable (prose, code fences, extra
 * keys), block the stop and reprompt so the SAME session corrects its format —
 * instead of the close orchestrator recording "no parseable output" and burning
 * a validation attempt.
 *
 * Wired into `app/hooks/stop.sh`, active only when ATLAS_TRIGGER_CHANNEL=validator.
 *
 * Stop-hook contract (see https://code.claude.com/docs/en/hooks):
 *   stdin  — { transcript_path, stop_hook_active, ... }
 *   stdout — empty (allow stop) | {"decision":"block","reason":"..."} (continue)
 *   stop_hook_active is true once we've already blocked this turn — the
 *   documented guard against infinite loops, so we reprompt at most once.
 */
import { readFileSync } from "node:fs";
import { parseValidatorOutput } from "../triggers/manage-tasks.ts";

const input = (await Bun.stdin.json().catch(() => null)) as
  | { transcript_path?: string; stop_hook_active?: boolean }
  | null;

// Fail open if we can't inspect the turn, and never block more than once.
if (!input?.transcript_path || input.stop_hook_active) process.exit(0);

// Find the last assistant text message in the transcript (JSONL, one event/line).
let lastText = "";
try {
  for (const line of readFileSync(input.transcript_path, "utf8").split("\n")) {
    let msg: { role?: string; content?: unknown };
    try {
      msg = JSON.parse(line)?.message;
    } catch {
      continue;
    }
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const text = msg.content
      .filter((c: { type?: string }) => c?.type === "text")
      .map((c: { text?: string }) => c.text ?? "")
      .join("\n")
      .trim();
    if (text) lastText = text;
  }
} catch {
  process.exit(0); // unreadable transcript → fail open
}

// A parseable verdict (or no assistant message yet) → allow stop.
if (!lastText || parseValidatorOutput(lastText)) process.exit(0);

// Unparseable → block once and state exactly what to produce.
process.stdout.write(
  JSON.stringify({
    decision: "block",
    reason:
      'Your last message was not a parseable verdict. Respond with EXACTLY one ' +
      'JSON line and nothing else — no prose, no code fences, no extra keys:\n' +
      '{"verdict": "pass" | "fail", "feedback": "<short explanation, max 200 chars>"}',
  }),
);
