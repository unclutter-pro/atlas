#!/usr/bin/env bun
/**
 * Claude Code Stop hook for the goal-validator session: reads the final
 * assistant message from the transcript Claude Code hands over and applies
 * Atlas' validator format gate (lifecycle/validator-gate.ts).
 *
 * Previous corrections are counted in the transcript (the documented
 * alternative to the single-shot `stop_hook_active` guard), so the loop is
 * bounded regardless of `stop_hook_active`.
 *
 * Wired into `stop.sh` (this directory), active only when ATLAS_TRIGGER_CHANNEL=validator.
 *
 * Stop-hook contract (see https://code.claude.com/docs/en/hooks):
 *   stdin  — { transcript_path, stop_hook_active, ... }
 *   stdout — empty (allow stop) | {"decision":"block","reason":"..."} (continue)
 */
import { readFileSync } from "node:fs";
import { CORRECTION_MARKER, validatorGate } from "../../../lifecycle/validator-gate.ts";

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

const reason = validatorGate(lastText, transcript.split(CORRECTION_MARKER).length - 1);
if (reason) process.stdout.write(JSON.stringify({ decision: "block", reason }));
