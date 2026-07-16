#!/usr/bin/env bun
/**
 * Stop-hook gate for the goal-validator session (channel = "validator").
 *
 * The validator must end its turn with exactly one parseable JSON verdict line:
 *   {"verdict": "pass" | "fail", "feedback": "..."}
 *
 * If the final assistant message isn't parseable (prose, code fences, extra
 * keys), block the stop and send it back to the validator with an explicit
 * format-correction so the SAME session fixes its output — instead of the close
 * orchestrator recording "no parseable output" and burning a validation attempt.
 *
 * The correction is retried up to MAX_REPROMPTS times. The loop is bounded by
 * counting how many corrections we've already injected into the transcript
 * (the documented alternative to the single-shot `stop_hook_active` guard),
 * then failing open so the run can never hang.
 *
 * Wired into `app/hooks/stop.sh`, active only when ATLAS_TRIGGER_CHANNEL=validator.
 *
 * Stop-hook contract (see https://code.claude.com/docs/en/hooks):
 *   stdin  — { transcript_path, stop_hook_active, ... }
 *   stdout — empty (allow stop) | {"decision":"block","reason":"..."} (continue)
 */
import { readFileSync } from "node:fs";
import { parseValidatorOutput } from "../triggers/manage-tasks.ts";

/** How many times to bounce a malformed verdict back before giving up. */
const MAX_REPROMPTS = 3;

/**
 * Stable marker inside every correction we inject. Counting its occurrences in
 * the transcript tells us how many reprompts have already happened, which caps
 * the loop regardless of `stop_hook_active`.
 */
const CORRECTION_MARKER = "Invalid format. Please respond in the following JSON format only:";

const CORRECTION_REASON =
  `${CORRECTION_MARKER}\n` +
  `{"verdict": "pass" | "fail", "feedback": "<short explanation, max 200 chars>"}\n` +
  `Output ONLY that single line — no prose, no reasoning, no code fences, no extra keys, ` +
  `nothing before or after it.`;

const input = (await Bun.stdin.json().catch(() => null)) as
  | { transcript_path?: string; stop_hook_active?: boolean }
  | null;

// Fail open if we can't inspect the turn.
if (!input?.transcript_path) process.exit(0);

let transcript = "";
try {
  transcript = readFileSync(input.transcript_path, "utf8");
} catch {
  process.exit(0); // unreadable transcript → fail open
}

// Find the last assistant text message in the transcript (JSONL, one event/line).
let lastText = "";
for (const line of transcript.split("\n")) {
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

// A parseable verdict (or no assistant message yet) → allow stop.
if (!lastText || parseValidatorOutput(lastText)) process.exit(0);

// Bound the loop: give up once we've already corrected MAX_REPROMPTS times.
const corrections = transcript.split(CORRECTION_MARKER).length - 1;
if (corrections >= MAX_REPROMPTS) process.exit(0);

// Unparseable and under the cap → send it back with the exact format contract.
process.stdout.write(JSON.stringify({ decision: "block", reason: CORRECTION_REASON }));
