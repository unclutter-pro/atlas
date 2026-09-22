/**
 * Claude Code session transcripts (~/.claude/projects/<dir>/<sessionId>.jsonl)
 * for the Activity detail views.
 *
 * Same line format as parseSessionMessages() in index.ts, but tool calls are
 * paired with their results by tool_use_id and nothing is dropped, so the
 * detail view can show a run step by step.
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "fs";
import { join } from "path";
import { paths } from "../shared/env";

export type TranscriptEntry =
  | { kind: "user"; text: string; at: string | null }
  | { kind: "assistant"; text: string; at: string | null }
  | { kind: "thinking"; text: string; at: string | null }
  | { kind: "tool"; id: string | null; name: string; input: string; result: string | null; isError: boolean; at: string | null };

export interface Transcript {
  entries: TranscriptEntry[];
  /** Entries dropped from the front because of the size cap. */
  omitted: number;
  /** Only the file's tail was read (very large transcript); earlier entries are unknown. */
  truncated: boolean;
  /** True when entries were cut to the run's time window (persistent sessions). */
  windowed: boolean;
  model: string | null;
}

const MAX_TEXT = 20_000;
const MAX_ENTRIES = 400;

export const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

function clip(s: string, max = MAX_TEXT): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${(s.length - max).toLocaleString("en-US")} more characters)` : s;
}

/** Locate a session's JSONL under ~/.claude/projects/*. */
export function findSessionFile(sessionId: string | null | undefined): string | null {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null;
  const dir = paths.claudeProjects();
  if (!existsSync(dir)) return null;
  try {
    for (const project of readdirSync(dir)) {
      const candidate = join(dir, project, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

function blocksOf(message: unknown): unknown {
  // Old format: message is the content; new format: { role, content }.
  if (message && typeof message === "object" && !Array.isArray(message) && "content" in message) return (message as { content: unknown }).content;
  return message;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text ?? "") : "")).join("\n");
  return content == null ? "" : JSON.stringify(content);
}

/** Parse JSONL text into entries. Tool results are attached to their tool call. */
export function parseTranscript(text: string): { entries: TranscriptEntry[]; model: string | null } {
  const entries: TranscriptEntry[] = [];
  const tools = new Map<string, Extract<TranscriptEntry, { kind: "tool" }>>();
  let model: string | null = null;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const at = typeof obj.timestamp === "string" ? obj.timestamp : null;

    if (obj.type === "user") {
      const content = blocksOf(obj.message);
      if (typeof content === "string") {
        if (content.trim()) entries.push({ kind: "user", text: clip(content), at });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "tool_result") {
            const text = clip(resultText(block.content));
            const call = block.tool_use_id ? tools.get(block.tool_use_id) : undefined;
            if (call) {
              call.result = text;
              call.isError = !!block.is_error;
            } else {
              entries.push({ kind: "tool", id: block.tool_use_id ?? null, name: "tool result", input: "", result: text, isError: !!block.is_error, at });
            }
          } else if (block?.type === "text" && block.text?.trim()) {
            entries.push({ kind: "user", text: clip(block.text), at });
          }
        }
      }
    } else if (obj.type === "assistant") {
      const msg = obj.message;
      if (!model && msg && typeof msg === "object" && typeof msg.model === "string") model = msg.model;
      const content = blocksOf(msg);
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === "text" && block.text) entries.push({ kind: "assistant", text: clip(block.text), at });
        else if (block?.type === "thinking" && block.thinking) entries.push({ kind: "thinking", text: clip(block.thinking), at });
        else if (block?.type === "tool_use") {
          const input = typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}, null, 2);
          const entry = { kind: "tool" as const, id: block.id ?? null, name: block.name || "tool", input: clip(input), result: null, isError: false, at };
          if (block.id) tools.set(block.id, entry);
          entries.push(entry);
        }
      }
    }
  }
  return { entries, model };
}

/** Without a run window only the tail is read; entries are capped anyway. */
const TAIL_BYTES = 8 * 1024 * 1024;
const TIMESTAMP_RE = /"timestamp":"([^"]+)"/;

/**
 * Load a transcript. With a window, only entries inside [from, to] are kept
 * (persistent sessions hold many runs in one file). Reads asynchronously and
 * drops out-of-window lines before JSON parsing, so long-lived sessions
 * (tens of MB) don't stall the server.
 */
export async function loadTranscript(
  sessionId: string | null | undefined,
  window?: { from: string | null; to: string | null },
): Promise<Transcript | null> {
  const file = findSessionFile(sessionId);
  if (!file) return null;
  let text: string;
  let truncated = false;
  try {
    if (!window?.from && statSync(file).size > TAIL_BYTES) {
      text = readSlice(file, true, TAIL_BYTES);
      truncated = true;
    } else {
      text = await Bun.file(file).text();
    }
  } catch {
    return null;
  }
  let windowed = false;
  if (window?.from) {
    const from = Date.parse(window.from) - 2_000;
    const to = window.to ? Date.parse(window.to) + 5_000 : Infinity;
    const lines = text.split("\n");
    const kept = lines.filter((line) => {
      const ts = line.match(TIMESTAMP_RE)?.[1];
      const t = ts ? Date.parse(ts) : NaN;
      return !Number.isNaN(t) && t >= from && t <= to;
    });
    windowed = kept.length !== lines.filter((l) => l.trim()).length;
    text = kept.join("\n");
  }
  const parsed = parseTranscript(text);
  const entries = parsed.entries;
  const omitted = Math.max(0, entries.length - MAX_ENTRIES);
  return {
    entries: omitted ? entries.slice(omitted) : entries,
    omitted,
    truncated,
    windowed,
    model: parsed.model,
  };
}

function readSlice(file: string, fromEnd: boolean, bytes: number): string {
  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fd = openSync(file, "r");
    readSync(fd, buf, 0, len, fromEnd ? size - len : 0);
    let s = buf.toString("utf-8");
    // Drop the partial line at the cut.
    if (fromEnd && len < size) s = s.slice(s.indexOf("\n") + 1);
    if (!fromEnd && len < size) s = s.slice(0, s.lastIndexOf("\n"));
    return s;
  } catch {
    return "";
  } finally {
    if (fd != null) closeSync(fd);
  }
}

/**
 * Best-effort "why did it fail": the last assistant text (or failing tool
 * result) inside the run window, read from the file tail only.
 */
export function lastErrorHint(sessionId: string | null | undefined, from: string | null, to: string | null): string | null {
  const file = findSessionFile(sessionId);
  if (!file) return null;
  const { entries } = parseTranscript(readSlice(file, true, 128 * 1024));
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

/** First user prompt of a session (head of the file only). */
export function firstUserText(sessionId: string | null | undefined): string | null {
  const file = findSessionFile(sessionId);
  if (!file) return null;
  const { entries } = parseTranscript(readSlice(file, false, 64 * 1024));
  const first = entries.find((e): e is Extract<TranscriptEntry, { kind: "user" }> => e.kind === "user");
  return first ? first.text : null;
}
