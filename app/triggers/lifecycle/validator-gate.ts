/**
 * Lifecycle policy: format gate for the goal-validator session.
 *
 * The validator must end its turn with exactly one parseable JSON verdict line:
 *   {"verdict": "pass" | "fail", "feedback": "..."}
 *
 * If the final assistant message isn't parseable (prose, code fences, extra
 * keys), the turn goes back to the validator with an explicit format
 * correction so the SAME session fixes its output — instead of the close
 * orchestrator recording "no parseable output" and burning a validation
 * attempt. At most MAX_REPROMPTS corrections, then fail open so a run can
 * never hang.
 *
 * Backend adapters supply the final message and how many corrections the
 * session already received (count CORRECTION_MARKER in its history).
 */
import { parseValidatorOutput } from "../manage-tasks.ts";

/** How many times to bounce a malformed verdict back before giving up. */
export const MAX_REPROMPTS = 3;

/** Stable marker inside every correction; counting it bounds the loop. */
export const CORRECTION_MARKER = "Invalid format. Please respond in the following JSON format only:";

export const CORRECTION_REASON =
  `${CORRECTION_MARKER}\n` +
  `{"verdict": "pass" | "fail", "feedback": "<short explanation, max 200 chars>"}\n` +
  `Output ONLY that single line — no prose, no reasoning, no code fences, no extra keys, ` +
  `nothing before or after it.`;

/** The correction to send back, or null when the validator may stop. */
export function validatorGate(lastAssistantText: string, previousCorrections: number): string | null {
  // A parseable verdict (or no assistant message yet) → allow stop.
  if (!lastAssistantText || parseValidatorOutput(lastAssistantText)) return null;
  if (previousCorrections >= MAX_REPROMPTS) return null;
  return CORRECTION_REASON;
}
