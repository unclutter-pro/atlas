#!/usr/bin/env bun
/**
 * Stop-hook gate for the goal-validator session (channel = "validator").
 *
 * The validator MUST end its turn with exactly one parseable JSON verdict line:
 *   {"verdict": "pass" | "fail", "feedback": "..."}
 *
 * Some models occasionally answer in prose, wrap the JSON in code fences, or add
 * commentary — which the close orchestrator then records as "no parseable
 * output", burning a validation attempt for a complete goal. Instead of treating
 * that as an infrastructure error after the fact, this hook blocks the stop the
 * moment the final message is unparseable and feeds back the required format, so
 * the SAME validator session continues and the model corrects itself.
 *
 * Wired in by `app/hooks/stop.sh` only when ATLAS_TRIGGER_CHANNEL=validator.
 *
 * Hook I/O contract (Claude Code Stop hook):
 *   stdin  — JSON: { transcript_path, stop_hook_active, ... }
 *   stdout — empty (allow stop) OR {"decision":"block","reason":"..."} (continue)
 */
import { readFileSync } from "node:fs";
import { parseValidatorOutput } from "../triggers/manage-tasks.ts";

// Marker embedded in our reprompt so we can count how many times we have already
// nudged this session and stop looping if a model is hopelessly stuck. The outer
// validator timeout also bounds this, but an explicit cap avoids wasted turns.
const REPROMPT_MARKER = "[validator-format-gate]";
const MAX_REPROMPTS = 5;

const REQUIRED_FORMAT = `{"verdict": "pass" | "fail", "feedback": "<short explanation, max 200 chars>"}`;

/** Extract the concatenated text of an assistant transcript event, if any. */
function assistantText(event: unknown): string | null {
  const message = (event as { message?: { role?: string; content?: unknown } })?.message;
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return null;
  const text = message.content
    .filter((c: unknown) => (c as { type?: string })?.type === "text")
    .map((c: unknown) => (c as { text?: string }).text ?? "")
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

/** True if a user-injected event carries our reprompt marker. */
function isOurReprompt(event: unknown): boolean {
  const message = (event as { message?: { role?: string; content?: unknown } })?.message;
  if (!message || message.role !== "user") return false;
  return JSON.stringify(message.content ?? "").includes(REPROMPT_MARKER);
}

function allowStop(): never {
  process.exit(0);
}

function block(reason: string): never {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

async function main(): Promise<void> {
  const raw = await Bun.stdin.text().catch(() => "");
  let input: { transcript_path?: string } = {};
  try {
    input = JSON.parse(raw);
  } catch {
    allowStop(); // no parseable hook input — don't interfere
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) allowStop();

  let lines: string[];
  try {
    lines = readFileSync(transcriptPath, "utf8").split("\n").filter((l) => l.length > 0);
  } catch {
    allowStop(); // unreadable transcript — fail open
  }

  let lastAssistantText: string | null = null;
  let repromptCount = 0;
  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const text = assistantText(event);
    if (text) lastAssistantText = text;
    if (isOurReprompt(event)) repromptCount++;
  }

  // No assistant message yet, or it already carries a valid verdict → allow stop.
  if (lastAssistantText === null) allowStop();
  if (parseValidatorOutput(lastAssistantText) !== null) allowStop();

  // Unparseable. Give up after enough nudges to avoid an infinite loop.
  if (repromptCount >= MAX_REPROMPTS) allowStop();

  block(
    `${REPROMPT_MARKER} Your previous message was not a parseable verdict. ` +
    `Respond with EXACTLY one JSON line and NOTHING else — no prose, no code fences, no extra keys:\n` +
    REQUIRED_FORMAT,
  );
}

await main();
