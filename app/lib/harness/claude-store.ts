/**
 * Claude Code session storage: ~/.claude/projects/<project>/<session>.jsonl,
 * nested agents in <session>/subagents/*.jsonl. The only module outside the
 * Claude execution adapter that knows this layout or the JSONL line format.
 * SDK-free so the web UI can use it.
 */

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, watch } from "fs";
import { join } from "path";
import type {
  HistoryCursor, HistoryEntry, HistoryExcerpt, HistoryPosition, HarnessSessionStore, JsonValue,
  SessionMetadata, SessionRef, StoredSession, UsageSummary,
} from "../harness.ts";
import { responseCost } from "./claude-pricing.ts";

export const CLAUDE_BACKEND = "claude-code";

const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
const SESSION_PATH_RE = /^\.claude\/projects\/.+\/([^/]+)\.jsonl$/;
const TIMESTAMP_RE = /"timestamp":"([^"]+)"/;
const NL = 0x0a;
const READ_CHUNK = 1024 * 1024;
const METADATA_TAIL_BYTES = 64 * 1024;
const DEFAULT_LOAD_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Line format
// ---------------------------------------------------------------------------

type Line = Record<string, any>;

function blocksOf(message: unknown): unknown {
  // Old format: message is the content; new format: { role, content }.
  if (message && typeof message === "object" && !Array.isArray(message) && "content" in message) {
    return (message as { content: unknown }).content;
  }
  return message;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text ?? "") : "")).join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

function parseJson(line: string): Line | null {
  if (!line.trim()) return null;
  try {
    const obj = JSON.parse(line);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null; // a crash can leave an incomplete line
  }
}

/** Entries of one JSONL line. `offset` identifies lines without a uuid. */
function entriesOf(obj: Line, offset: number): HistoryEntry[] {
  const lineId = typeof obj.uuid === "string" && obj.uuid ? obj.uuid : `@${offset}`;
  const at = typeof obj.timestamp === "string" ? obj.timestamp : null;
  const nested = obj.isSidechain === true;
  const base = (i: number) => ({ id: `${lineId}:${i}`, at, nested });
  const out: HistoryEntry[] = [];

  if (obj.type === "user") {
    const content = blocksOf(obj.message);
    if (typeof content === "string") {
      if (content.trim()) out.push({ ...base(0), kind: "user-text", text: content });
    } else if (Array.isArray(content)) {
      content.forEach((block: any, i: number) => {
        if (block?.type === "tool_result") {
          out.push({
            ...base(i), kind: "tool-result",
            callId: typeof block.tool_use_id === "string" && block.tool_use_id ? block.tool_use_id : null,
            content: resultText(block.content), isError: !!block.is_error,
          });
        } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          out.push({ ...base(i), kind: "user-text", text: block.text });
        }
      });
    }
  } else if (obj.type === "assistant") {
    const message = obj.message;
    const messageId = message && typeof message === "object" && !Array.isArray(message) && typeof message.id === "string" ? message.id : null;
    const content = blocksOf(message);
    if (!Array.isArray(content)) return out;
    content.forEach((block: any, i: number) => {
      if (!block || typeof block !== "object") return;
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        out.push({ ...base(i), kind: "assistant-text", text: block.text, messageId });
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
        out.push({ ...base(i), kind: "reasoning", text: block.thinking });
      } else if (block.type === "tool_use") {
        out.push({
          ...base(i), kind: "tool-call",
          callId: typeof block.id === "string" && block.id ? block.id : null,
          name: typeof block.name === "string" && block.name ? block.name : "tool",
          input: (block.input ?? {}) as JsonValue,
        });
      }
    });
  }
  return out;
}

function modelOf(obj: Line): string | null {
  const message = obj.type === "assistant" ? obj.message : null;
  return message && typeof message === "object" && typeof message.model === "string" ? message.model : null;
}

/** Parse complete lines; `startOffset` is the byte offset of the first one. */
function parseText(text: string, startOffset: number): { entries: HistoryEntry[]; model: string | null } {
  const entries: HistoryEntry[] = [];
  let model: string | null = null;
  let offset = startOffset;
  for (const line of text.split("\n")) {
    const obj = parseJson(line);
    if (obj) {
      model ??= modelOf(obj);
      entries.push(...entriesOf(obj, offset));
    }
    offset += Buffer.byteLength(line, "utf8") + 1;
  }
  return { entries, model };
}

/** Last user text of a line (for the interrupt marker). */
function userText(message: unknown): string {
  const content = blocksOf(message);
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content.find((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string");
    return text ? text.text : "";
  }
  return "";
}

// ---------------------------------------------------------------------------
// File access
// ---------------------------------------------------------------------------

/** First or last `bytes` of a file, cut to whole lines. */
function readSlice(file: string, fromEnd: boolean, bytes: number): { text: string; start: number; truncated: boolean } {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    const start = fromEnd ? size - len : 0;
    readSync(fd, buf, 0, len, start);
    let text = buf.toString("utf8");
    let first = start;
    if (fromEnd && len < size) {
      // Drop the partial line at the cut.
      const cut = text.indexOf("\n") + 1;
      first += Buffer.byteLength(text.slice(0, cut), "utf8");
      text = text.slice(cut);
    }
    if (!fromEnd && len < size) text = text.slice(0, text.lastIndexOf("\n"));
    return { text, start: first, truncated: len < size };
  } catch {
    return { text: "", start: 0, truncated: false };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

class ClaudeHistoryCursor implements HistoryCursor {
  private offset = 0;
  private partial: Buffer = Buffer.alloc(0);
  private started = false;
  truncated = false;

  constructor(
    private readonly file: string,
    private readonly initialBytes: number,
    private readonly until: number | undefined,
  ) {}

  get position(): HistoryPosition {
    return String(this.offset);
  }

  read(): { entries: HistoryEntry[]; reset: boolean } {
    const out = { entries: [] as HistoryEntry[], reset: false };
    let fd: number | null = null;
    try {
      fd = openSync(this.file, "r");
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        out.reset = true;
        this.offset = 0;
        this.partial = Buffer.alloc(0);
        this.started = false;
        this.truncated = false;
      }
      const end = this.until !== undefined ? Math.min(size, this.until) : size;
      let start = this.offset;
      let dropFirst = false;
      if (!this.started) {
        this.started = true;
        if (end - start > this.initialBytes) {
          start = end - this.initialBytes;
          dropFirst = true;
          this.truncated = true;
        }
      }
      if (end <= start) return out;

      let lineStart = start - this.partial.length;
      let pos = start;
      while (pos < end) {
        const len = Math.min(READ_CHUNK, end - pos);
        const buf = Buffer.allocUnsafe(len);
        const n = readSync(fd, buf, 0, len, pos);
        if (n <= 0) break;
        pos += n;
        const data = this.partial.length ? Buffer.concat([this.partial, buf.subarray(0, n)]) : buf.subarray(0, n);
        let from = 0;
        for (let i = data.indexOf(NL); i !== -1; i = data.indexOf(NL, from)) {
          if (dropFirst) dropFirst = false;
          else {
            const obj = parseJson(data.toString("utf8", from, i));
            if (obj) out.entries.push(...entriesOf(obj, lineStart));
          }
          lineStart += i + 1 - from;
          from = i + 1;
        }
        this.partial = Buffer.from(data.subarray(from));
      }
      // A cut in the middle of the only line: nothing complete yet.
      if (dropFirst) this.partial = Buffer.alloc(0);
      this.offset = pos;
    } catch {
      // Missing or unreadable file: nothing new.
    } finally {
      if (fd !== null) closeSync(fd);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class ClaudeSessionStore implements HarnessSessionStore {
  readonly backend = CLAUDE_BACKEND;

  constructor(private readonly home: string) {}

  ref(nativeId: string | null | undefined): SessionRef | null {
    return typeof nativeId === "string" && SESSION_ID_RE.test(nativeId) ? { backend: this.backend, nativeId } : null;
  }

  /**
   * Transcript file of a session. For the Claude execution adapter only;
   * everything else uses the store methods.
   */
  transcriptPath(ref: SessionRef): string | null {
    if (ref.backend !== this.backend || !SESSION_ID_RE.test(ref.nativeId)) return null;
    const root = join(this.home, ".claude", "projects");
    if (!existsSync(root)) return null;
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = join(root, entry.name, `${ref.nativeId}.jsonl`);
        if (existsSync(file)) return file;
      }
    } catch {}
    return null;
  }

  /** Nested agent transcripts of a session transcript, by agent id. */
  private nestedFiles(transcript: string): Array<{ id: string; file: string }> {
    const dir = join(transcript.slice(0, -".jsonl".length), "subagents");
    try {
      return readdirSync(dir)
        .filter((entry) => entry.endsWith(".jsonl") && SESSION_ID_RE.test(entry.slice(0, -".jsonl".length)))
        .map((entry) => ({ id: entry.slice(0, -".jsonl".length), file: join(dir, entry) }));
    } catch {
      return []; // No nested agents yet
    }
  }

  /** Transcript plus nested agent transcripts. */
  private files(ref: SessionRef): string[] {
    const transcript = this.transcriptPath(ref);
    return transcript ? [transcript, ...this.nestedFiles(transcript).map((n) => n.file)] : [];
  }

  /** Every session transcript, with its project directory. */
  private transcripts(): Array<{ id: string; file: string; dir: string }> {
    const root = join(this.home, ".claude", "projects");
    const out: Array<{ id: string; file: string; dir: string }> = [];
    try {
      for (const project of readdirSync(root, { withFileTypes: true })) {
        if (!project.isDirectory()) continue;
        const dir = join(root, project.name);
        for (const entry of readdirSync(dir)) {
          const id = entry.slice(0, -".jsonl".length);
          if (entry.endsWith(".jsonl") && SESSION_ID_RE.test(id)) out.push({ id, file: join(dir, entry), dir });
        }
      }
    } catch {}
    return out;
  }

  private static mtime(file: string): number {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  }

  list(options: { activeSince: string }): StoredSession[] {
    const since = Date.parse(options.activeSince);
    const out: Array<StoredSession & { ms: number }> = [];
    for (const { id, file } of this.transcripts()) {
      const nested = this.nestedFiles(file).map((n) => ({ id: n.id, ms: ClaudeSessionStore.mtime(n.file) }));
      const ms = Math.max(ClaudeSessionStore.mtime(file), ...nested.map((n) => n.ms));
      if (!ms || ms < since) continue;
      out.push({
        ref: { backend: this.backend, nativeId: id },
        lastActivityAt: new Date(ms).toISOString(),
        nestedAgents: nested.sort((a, b) => a.ms - b.ms).map((n) => ({ id: n.id, lastActivityAt: new Date(n.ms).toISOString() })),
        ms,
      });
    }
    return out.sort((a, b) => a.ms - b.ms).map(({ ms: _ms, ...session }) => session);
  }

  prune(options: { inactiveBefore: string }): number {
    const before = Date.parse(options.inactiveBefore);
    if (Number.isNaN(before)) return 0;
    let removed = 0;
    for (const { file } of this.transcripts()) {
      const nested = this.nestedFiles(file);
      const ms = Math.max(ClaudeSessionStore.mtime(file), ...nested.map((n) => ClaudeSessionStore.mtime(n.file)));
      if (!ms || ms >= before) continue;
      try {
        // The session directory holds nested agents and tool-result spill files.
        rmSync(file.slice(0, -".jsonl".length), { recursive: true, force: true });
        rmSync(file, { force: true });
        removed++;
      } catch {}
    }
    return removed;
  }

  exists(ref: SessionRef): boolean {
    return this.transcriptPath(ref) !== null;
  }

  metadata(ref: SessionRef): SessionMetadata | null {
    const files = this.files(ref);
    if (files.length === 0) return null;
    let latestMs = 0;
    for (const file of files) {
      try {
        latestMs = Math.max(latestMs, statSync(file).mtimeMs);
      } catch {}
    }

    let lastEntryAt: string | null = null;
    let turn: SessionMetadata["turn"] | null = null;
    const lines = readSlice(files[0]!, true, METADATA_TAIL_BYTES).text.split("\n");
    for (let i = lines.length - 1; i >= 0 && (turn === null || lastEntryAt === null); i--) {
      const obj = parseJson(lines[i]!);
      if (!obj || obj.isSidechain === true || (obj.type !== "user" && obj.type !== "assistant")) continue;
      if (lastEntryAt === null && typeof obj.timestamp === "string") lastEntryAt = obj.timestamp;
      if (turn === null) {
        if (obj.type === "user") {
          // An interrupt marker ends the turn; any other input means work is coming.
          turn = userText(obj.message).startsWith("[Request interrupted") ? "ended" : "active";
        } else {
          const message = obj.message;
          const stop = message && typeof message === "object" && !Array.isArray(message) ? message.stop_reason : null;
          turn = stop === "tool_use" ? "active" : "ended";
        }
      }
    }
    return {
      lastActivityAt: latestMs ? new Date(latestMs).toISOString() : null,
      lastEntryAt,
      // Nothing conversational stored yet: the session is just starting.
      turn: turn ?? "active",
    };
  }

  excerpt(ref: SessionRef, options: { from: "start" | "end"; maxBytes: number }): HistoryExcerpt | null {
    const file = this.transcriptPath(ref);
    if (!file) return null;
    const slice = readSlice(file, options.from === "end", options.maxBytes);
    const parsed = parseText(slice.text, slice.start);
    return { ...parsed, truncated: slice.truncated, windowed: false };
  }

  async load(
    ref: SessionRef,
    options: { window?: { from: string | null; to: string | null }; maxBytes?: number; agent?: string } = {},
  ): Promise<HistoryExcerpt | null> {
    const transcript = this.transcriptPath(ref);
    if (!transcript) return null;
    const file = options.agent === undefined
      ? transcript
      : this.nestedFiles(transcript).find((n) => n.id === options.agent)?.file;
    if (!file) return null;
    const window = options.window;
    const maxBytes = options.maxBytes ?? DEFAULT_LOAD_BYTES;
    let text: string;
    let start = 0;
    let truncated = false;
    try {
      if (!window?.from && statSync(file).size > maxBytes) {
        const slice = readSlice(file, true, maxBytes);
        ({ text, start, truncated } = slice);
      } else {
        text = await Bun.file(file).text();
      }
    } catch {
      return null;
    }
    if (!window?.from) return { ...parseText(text, start), truncated, windowed: false };

    // Persistent sessions hold many runs: drop out-of-window lines before
    // JSON parsing so tens of MB don't stall the caller.
    const from = Date.parse(window.from) - 2_000;
    const to = window.to ? Date.parse(window.to) + 5_000 : Infinity;
    const entries: HistoryEntry[] = [];
    let model: string | null = null;
    let offset = start;
    let dropped = false;
    for (const line of text.split("\n")) {
      const lineOffset = offset;
      offset += Buffer.byteLength(line, "utf8") + 1;
      if (!line.trim()) continue;
      const ts = line.match(TIMESTAMP_RE)?.[1];
      const t = ts ? Date.parse(ts) : NaN;
      if (Number.isNaN(t) || t < from || t > to) {
        dropped = true;
        continue;
      }
      const obj = parseJson(line);
      if (!obj) continue;
      model ??= modelOf(obj);
      entries.push(...entriesOf(obj, lineOffset));
    }
    return { entries, model, truncated, windowed: dropped };
  }

  cursor(ref: SessionRef, options: { initialBytes?: number; until?: HistoryPosition } = {}): HistoryCursor | null {
    const file = this.transcriptPath(ref);
    if (!file) return null;
    const until = options.until !== undefined ? Number(options.until) : undefined;
    return new ClaudeHistoryCursor(
      file,
      options.initialBytes ?? DEFAULT_LOAD_BYTES,
      until !== undefined && Number.isFinite(until) ? until : undefined,
    );
  }

  watch(ref: SessionRef, onChange: () => void): (() => void) | null {
    const file = this.transcriptPath(ref);
    if (!file) return null;
    try {
      const watcher = watch(file, { persistent: false }, () => onChange());
      // On error the caller keeps working from runner notifications.
      watcher.on("error", () => watcher.close());
      return () => watcher.close();
    } catch {
      return null;
    }
  }

  usage(ref: SessionRef, window: { from: string; to: string }): UsageSummary {
    const unavailable: UsageSummary = {
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      cost: null, completeness: "unavailable",
    };
    const windowStart = Date.parse(window.from);
    // Buffer for tool results that land after the run ended.
    const windowEnd = Date.parse(window.to) + 60_000;
    if (Number.isNaN(windowStart) || Number.isNaN(windowEnd)) return unavailable;
    const files = this.files(ref);
    if (files.length === 0) return unavailable;

    // One API message can be written several times (one line per content block).
    const seen = new Set<string>();
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of content.split("\n")) {
        const obj = parseJson(line);
        if (!obj || typeof obj.timestamp !== "string") continue;
        const ts = Date.parse(obj.timestamp);
        if (Number.isNaN(ts) || ts < windowStart || ts > windowEnd) continue;
        const message = obj.message;
        if (!message || typeof message !== "object" || !message.usage || !message.id) continue;
        if (seen.has(message.id)) continue;
        seen.add(message.id);

        const usage = message.usage as Record<string, any>;
        const i = usage.input_tokens ?? 0;
        const o = usage.output_tokens ?? 0;
        const r = usage.cache_read_input_tokens ?? 0;
        const w = usage.cache_creation_input_tokens ?? 0;
        input += i;
        output += o;
        cacheRead += r;
        cacheWrite += w;
        cost += responseCost(typeof message.model === "string" ? message.model : "", usage);
      }
    }
    return {
      inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
      cost: { currency: "USD", amount: cost, source: "estimated" },
      completeness: "complete",
    };
  }

  locate(path: string): SessionRef | null {
    const match = path.match(SESSION_PATH_RE);
    return match ? this.ref(match[1]) : null;
  }
}
