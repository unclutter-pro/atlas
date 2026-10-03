import { readFileSync } from "node:fs";
import type { HarnessBackend, SessionRef } from "../../../lib/harness.ts";
import type { ClaudeSessionStore } from "../../../lib/harness/claude-store.ts";
import { harnessError } from "../../../lib/harness/errors.ts";
import { MessageAccumulator } from "./normalize.ts";

export function validateRef(ref: SessionRef): void {
  if (ref.backend !== "claude-code" || !/^[a-zA-Z0-9_-]+$/.test(ref.nativeId))
    throw harnessError("configuration", "Invalid Claude session reference");
}

/** Transcript path; the portable API rejects invalid references. */
export function findTranscript(store: ClaudeSessionStore, ref: SessionRef): string | null {
  validateRef(ref);
  return store.transcriptPath(ref);
}

/** Single snapshot page avoids exposing filesystem paths or unstable offsets. */
export async function readHistory(store: ClaudeSessionStore, ref: SessionRef, cursor?: string): ReturnType<HarnessBackend["history"]> {
  if (cursor !== undefined) throw harnessError("configuration", "Claude history returns one snapshot page without a cursor");
  const file = findTranscript(store, ref);
  if (!file) throw harnessError("session-missing", `Session ${ref.nativeId} has no transcript`);
  const rows = readFileSync(file, "utf8").split("\n");
  const accumulator = new MessageAccumulator();
  for (const line of rows) {
    try {
      accumulator.add(JSON.parse(line));
    } catch { /* A crash can leave an incomplete trailing line. */ }
  }
  return { messages: [...accumulator.messages.values()] };
}
