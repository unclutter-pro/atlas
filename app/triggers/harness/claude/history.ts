import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessBackend, SessionRef } from "../../../lib/harness.ts";
import { harnessError } from "../errors.ts";
import { MessageAccumulator } from "./normalize.ts";

export function validateRef(ref: SessionRef): void {
  if (ref.backend !== "claude-code" || !/^[a-zA-Z0-9_-]+$/.test(ref.nativeId))
    throw harnessError("configuration", "Invalid Claude session reference");
}

export function findTranscript(home: string, ref: SessionRef): string | null {
  validateRef(ref);
  const root = join(home, ".claude/projects");
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of [join(root, entry.name, `${ref.nativeId}.jsonl`),
      join(root, entry.name, "sessions", `${ref.nativeId}.jsonl`)]) if (existsSync(file)) return file;
  }
  return null;
}

/** Single snapshot page avoids exposing filesystem paths or unstable offsets. */
export async function readHistory(home: string, ref: SessionRef, cursor?: string): ReturnType<HarnessBackend["history"]> {
  if (cursor !== undefined) throw harnessError("configuration", "Claude history returns one snapshot page without a cursor");
  const file = findTranscript(home, ref);
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
