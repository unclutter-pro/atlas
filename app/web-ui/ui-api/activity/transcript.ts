/**
 * Session transcripts for the Activity detail views, read through the
 * session store of the configured agent backend.
 *
 * Unlike the chat view, tool calls are paired with their results here and
 * nothing is dropped, so the detail view can show a run step by step.
 */

import type { HistoryEntry } from "../../../lib/harness";
import { sessionStore } from "../shared/env";

export type TranscriptEntry =
  | { kind: "user"; text: string; at: string | null }
  | { kind: "assistant"; text: string; at: string | null }
  | { kind: "thinking"; text: string; at: string | null }
  | { kind: "tool"; id: string | null; name: string; input: string; result: string | null; isError: boolean; at: string | null };

export interface Transcript {
  entries: TranscriptEntry[];
  /** Entries dropped from the front because of the size cap. */
  omitted: number;
  /** Only the tail of a very large history was read; earlier entries are unknown. */
  truncated: boolean;
  /** True when entries were cut to the run's time window (persistent sessions). */
  windowed: boolean;
  model: string | null;
}

const MAX_TEXT = 20_000;
const MAX_ENTRIES = 400;

function clip(s: string, max = MAX_TEXT): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${(s.length - max).toLocaleString("en-US")} more characters)` : s;
}

/** History entries → transcript entries. Tool results are attached to their tool call. */
export function toTranscriptEntries(history: HistoryEntry[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const tools = new Map<string, Extract<TranscriptEntry, { kind: "tool" }>>();
  for (const e of history) {
    if (e.kind === "user-text") entries.push({ kind: "user", text: clip(e.text), at: e.at });
    else if (e.kind === "assistant-text") entries.push({ kind: "assistant", text: clip(e.text), at: e.at });
    else if (e.kind === "reasoning") entries.push({ kind: "thinking", text: clip(e.text), at: e.at });
    else if (e.kind === "tool-call") {
      const input = typeof e.input === "string" ? e.input : JSON.stringify(e.input ?? {}, null, 2);
      const entry = { kind: "tool" as const, id: e.callId, name: e.name, input: clip(input), result: null, isError: false, at: e.at };
      if (e.callId) tools.set(e.callId, entry);
      entries.push(entry);
    } else {
      const text = clip(e.content);
      const call = e.callId ? tools.get(e.callId) : undefined;
      if (call) {
        call.result = text;
        call.isError = e.isError;
      } else {
        entries.push({ kind: "tool", id: e.callId, name: "tool result", input: "", result: text, isError: e.isError, at: e.at });
      }
    }
  }
  return entries;
}

/**
 * Load a transcript. With a window, only entries inside [from, to] are kept
 * (persistent sessions hold many runs). The store reads asynchronously and
 * only the tail of very large histories.
 */
export async function loadTranscript(
  sessionId: string | null | undefined,
  window?: { from: string | null; to: string | null },
): Promise<Transcript | null> {
  const sessions = sessionStore();
  const ref = sessions.ref(sessionId);
  const read = ref ? await sessions.load(ref, window?.from ? { window } : {}) : null;
  if (!read) return null;
  const entries = toTranscriptEntries(read.entries);
  const omitted = Math.max(0, entries.length - MAX_ENTRIES);
  return {
    entries: omitted ? entries.slice(omitted) : entries,
    omitted,
    truncated: read.truncated,
    windowed: read.windowed,
    model: read.model,
  };
}

/** Entries from the first or last `maxBytes` of a session's history. */
function excerptEntries(sessionId: string | null | undefined, from: "start" | "end", maxBytes: number): TranscriptEntry[] | null {
  const sessions = sessionStore();
  const ref = sessions.ref(sessionId);
  const read = ref ? sessions.excerpt(ref, { from, maxBytes }) : null;
  return read ? toTranscriptEntries(read.entries) : null;
}

/**
 * Best-effort "why did it fail": the last assistant text (or failing tool
 * result) inside the run window, read from the history tail only.
 */
export function lastErrorHint(sessionId: string | null | undefined, from: string | null, to: string | null): string | null {
  const entries = excerptEntries(sessionId, "end", 128 * 1024);
  if (!entries) return null;
  const lo = from ? Date.parse(from) - 2_000 : -Infinity;
  const hi = to ? Date.parse(to) + 5_000 : Infinity;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    const t = e.at ? Date.parse(e.at) : NaN;
    if (!Number.isNaN(t) && (t < lo || t > hi)) continue;
    if (e.kind === "assistant") return e.text;
    if (e.kind === "tool" && e.isError && e.result) return e.result;
  }
  return null;
}

/** First user prompt of a session (head of the history only). */
export function firstUserText(sessionId: string | null | undefined): string | null {
  const first = excerptEntries(sessionId, "start", 64 * 1024)?.find(
    (e): e is Extract<TranscriptEntry, { kind: "user" }> => e.kind === "user",
  );
  return first ? first.text : null;
}
