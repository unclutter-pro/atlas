#!/usr/bin/env bun
/**
 * `sessions` — recent agent sessions for dreaming and retention, read
 * through the configured backend's session store (never backend files).
 *
 * Extracts user messages, assistant text, tool usage and files touched, and
 * condenses them for memory consolidation. Large sessions keep their first
 * and last turns; nested agents get a one-line summary.
 *
 * Usage:
 *   sessions [--hours 24] [--max-tokens 30000] [--exclude-trigger <name>]...
 *   sessions --list [--hours 24] [--exclude-trigger <name>]...
 *   sessions --session <session-id | session-id/agent-id | legacy .jsonl path>
 *   sessions --prune-days 14
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { basename, dirname, join } from "path";
import type { HarnessSessionStore, HistoryEntry, JsonValue, SessionRef } from "../lib/harness.ts";
import { createSessionStore } from "../lib/harness/stores.ts";

const DEFAULT_HOURS = 24;
const DEFAULT_MAX_TOKENS = 30000;
const CHARS_PER_TOKEN = 4;
/** Per-message truncation limits. */
const USER_MSG_LIMIT = 300;
const ASSISTANT_MSG_LIMIT = 400;
/** Max conversation turns per session (keeps first + last half). */
const MAX_TURNS_PER_SESSION = 40;

type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; tools: string[] }
  | { role: "tools"; tools: string[] }
  | { role: "gap"; text: string };

export interface SessionSummary {
  /** Session ID, or the nested agent's ID. */
  id: string;
  /** `<session>` or `<session>/<agent>`: what --session accepts. */
  reference: string;
  nested: boolean;
  firstTs: string | null;
  lastTs: string | null;
  turnCount: number;
  turnsSkipped: number;
  toolCounts: Map<string, number>;
  filesTouched: string[];
  turns: Turn[];
}

const isSystemText = (text: string) => /^\s*<system-(reminder|notice)>/.test(text);

const field = (input: JsonValue, key: string): unknown =>
  input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>)[key] : undefined;

/** Name plus the parameters that tell what a tool call did. */
function toolDetail(name: string, input: JsonValue): { name: string; file?: string } {
  const file = field(input, "file_path");
  return { name, ...(typeof file === "string" ? { file } : {}) };
}

/** Condensed summary of a session's (or nested agent's) history entries. */
export function summarize(id: string, reference: string, nested: boolean, entries: HistoryEntry[]): SessionSummary {
  let turns: Turn[] = [];
  const toolCounts = new Map<string, number>();
  const files = new Set<string>();
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  // One assistant message can span several entries (text, reasoning, tool calls).
  let group: { messageId: string | null; texts: string[]; tools: string[] } | null = null;
  const flush = () => {
    if (!group) return;
    const text = group.texts.join("\n");
    if (text.trim().length > 20) turns.push({ role: "assistant", text, tools: group.tools });
    else if (group.tools.length) turns.push({ role: "tools", tools: group.tools });
    group = null;
  };

  for (const e of entries) {
    if (e.at) {
      firstTs ??= e.at;
      lastTs = e.at;
    }
    if (e.kind === "tool-result") continue;
    if (e.kind === "user-text") {
      flush();
      if (!isSystemText(e.text) && e.text.trim().length > 10) turns.push({ role: "user", text: e.text });
      continue;
    }
    // All three kinds carry messageId, so a tool-only message gets a boundary too.
    const messageId = e.kind === "assistant-text" || e.kind === "reasoning" || e.kind === "tool-call" ? e.messageId : null;
    if (!group || (messageId && group.messageId && messageId !== group.messageId)) {
      flush();
      group = { messageId, texts: [], tools: [] };
    }
    group.messageId ??= messageId;
    if (e.kind === "assistant-text") {
      if (!isSystemText(e.text)) group.texts.push(e.text);
    } else if (e.kind === "reasoning") {
      // Reasoning reveals decisions; keep a short excerpt of substantial ones.
      if (e.text.length > 50) group.texts.push(`[thinking: ${e.text.slice(0, 200)}]`);
    } else if (e.kind === "tool-call") {
      const detail = toolDetail(e.name, e.input);
      group.tools.push(detail.name);
      toolCounts.set(detail.name, (toolCounts.get(detail.name) ?? 0) + 1);
      if (detail.file) files.add(detail.file);
    }
  }
  flush();

  const turnCount = turns.length;
  let turnsSkipped = 0;
  if (turnCount > MAX_TURNS_PER_SESSION) {
    const half = MAX_TURNS_PER_SESSION / 2;
    turnsSkipped = turnCount - MAX_TURNS_PER_SESSION;
    turns = [...turns.slice(0, half), { role: "gap", text: `[...${turnsSkipped} turns skipped...]` }, ...turns.slice(-half)];
  }
  return {
    id, reference, nested, firstTs, lastTs, turnCount, turnsSkipped, toolCounts,
    filesTouched: [...files].sort().slice(0, 20), turns,
  };
}

const topTools = (counts: Map<string, number>, n: number) =>
  [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

const clipLine = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text).replace(/\n/g, " ").trim();

const firstUser = (s: SessionSummary, max: number) => {
  const turn = s.turns.find((t) => t.role === "user");
  return turn && turn.role === "user" ? turn.text.slice(0, max).replace(/\n/g, " ").trim() : "";
};

/** Conversation detail (main sessions and --session). */
export function formatFull(s: SessionSummary): string {
  if (s.turnCount === 0) return "";
  const lines = [`### ${s.nested ? "[subagent] " : ""}Session ${s.id.slice(0, 8)}`];
  if (s.firstTs && s.lastTs) lines.push(`Time: ${s.firstTs.slice(0, 19)} → ${s.lastTs.slice(0, 19)}`);
  lines.push(s.turnsSkipped
    ? `Turns: ${s.turnCount} total, ${s.turnCount - s.turnsSkipped} shown (middle ${s.turnsSkipped} omitted)`
    : `Turns: ${s.turnCount}`);
  if (s.toolCounts.size) lines.push(`Tools: ${topTools(s.toolCounts, 8).map(([n, c]) => `${n}(${c})`).join(", ")}`);
  if (s.filesTouched.length) lines.push(`Files: ${s.filesTouched.slice(0, 10).join(", ")}`);
  lines.push("");
  for (const t of s.turns) {
    if (t.role === "gap") lines.push(t.text);
    else if (t.role === "user") lines.push(`👤 ${clipLine(t.text, USER_MSG_LIMIT)}`);
    else if (t.role === "assistant") {
      const suffix = t.tools.length ? ` [${t.tools.slice(0, 3).join(", ")}]` : "";
      lines.push(`🤖 ${clipLine(t.text, ASSISTANT_MSG_LIMIT)}${suffix}`);
    } else lines.push(`  🔧 ${t.tools.slice(0, 5).join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** One line per nested agent. */
function formatCondensed(s: SessionSummary): string {
  if (s.turnCount === 0) return "";
  const tools = topTools(s.toolCounts, 5).map(([n, c]) => `${n}(${c})`).join(", ") || "none";
  return `- **${s.id.slice(0, 8)}**: ${firstUser(s, 150) || "(no user text)"} | Tools: ${tools}\n`;
}

/** One index row for --list; the last column is what --session accepts. */
function formatIndex(s: SessionSummary): string {
  if (s.turnCount === 0) return "";
  const turns = `${s.turnCount} turns${s.turnsSkipped ? ` (${s.turnCount - s.turnsSkipped} shown)` : ""}`;
  const time = s.firstTs && s.lastTs ? `${s.firstTs.slice(0, 19)} → ${s.lastTs.slice(0, 19)}` : "";
  const tools = topTools(s.toolCounts, 5).map(([n, c]) => `${n}(${c})`).join(", ") || "none";
  return `${s.nested ? "sub" : "main"} | ${s.id.slice(0, 8)} | ${turns} | ${time} | ${tools} | ${firstUser(s, 120)} | ${s.reference}\n`;
}

/** Session IDs recorded for the given triggers (their runs are left out). */
function excludedSessionIds(triggers: string[], home: string): Set<string> {
  const excluded = new Set<string>();
  const dbPath = join(home, ".index", "atlas.db");
  if (!triggers.length || !existsSync(dbPath)) return excluded;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const placeholders = triggers.map(() => "?").join(",");
    for (const table of ["trigger_sessions", "session_metrics"]) {
      try {
        const rows = db.query(`SELECT session_id FROM ${table} WHERE trigger_name IN (${placeholders})`).all(...triggers) as Array<{ session_id: string | null }>;
        for (const row of rows) if (row.session_id) excluded.add(row.session_id);
      } catch {}
    }
  } catch {
  } finally {
    db?.close();
  }
  return excluded;
}

/** `<session>`, `<session>/<agent>`, or a legacy transcript path. */
export function parseReference(arg: string, store: HarnessSessionStore): { ref: SessionRef; agent?: string } | null {
  if (arg.endsWith(".jsonl")) {
    const stem = basename(arg, ".jsonl");
    const parent = dirname(arg);
    if (basename(parent) === "subagents") {
      const ref = store.ref(basename(dirname(parent)));
      return ref ? { ref, agent: stem } : null;
    }
    const ref = store.ref(stem);
    return ref ? { ref } : null;
  }
  const [session, agent, ...rest] = arg.split("/");
  const ref = store.ref(session);
  if (!ref || rest.length) return null;
  return agent ? { ref, agent } : { ref };
}

/** Summaries of sessions active in the last `hours`, oldest first. */
export async function recentSessions(store: HarnessSessionStore, hours: number, excluded: Set<string>): Promise<SessionSummary[]> {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const out: SessionSummary[] = [];
  for (const session of store.list({ activeSince: since })) {
    const id = session.ref.nativeId;
    // Nested agents of an excluded session belong to it as well.
    if (excluded.has(id)) continue;
    const main = await store.load(session.ref, { maxBytes: Infinity });
    if (main) out.push(summarize(id, id, false, main.entries));
    for (const agent of session.nestedAgents) {
      if (agent.lastActivityAt < since) continue;
      const nested = await store.load(session.ref, { maxBytes: Infinity, agent: agent.id });
      if (nested) out.push(summarize(agent.id, `${id}/${agent.id}`, true, nested.entries));
    }
  }
  return out;
}

/** The full extract: main sessions in detail, nested agents condensed, within a character budget. */
export function formatExtract(summaries: SessionSummary[], hours: number, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const main = summaries.filter((s) => !s.nested);
  const sub = summaries.filter((s) => s.nested);
  const parts: string[] = [];
  let chars = 0;
  const add = (text: string) => {
    if (chars + text.length > maxChars) return false;
    parts.push(text);
    chars += text.length;
    return true;
  };

  add(`# Session Extract — Last ${hours}h\n`);
  add(`${main.length} main sessions, ${sub.length} subagent sessions\n\n`);
  if (main.length) {
    add("## Main Sessions\n\n");
    for (const s of main) {
      const text = formatFull(s);
      if (text && !add(text)) {
        add("\n[Budget reached — remaining sessions skipped]\n");
        break;
      }
    }
  }
  if (sub.length && chars < maxChars - 2000) {
    add("\n## Subagent Sessions\n\n");
    for (const s of sub) {
      const text = formatCondensed(s);
      if (text && !add(text)) {
        add(`[...and ${sub.length} more]\n`);
        break;
      }
    }
  }
  const allTools = new Map<string, number>();
  for (const s of summaries) for (const [n, c] of s.toolCounts) allTools.set(n, (allTools.get(n) ?? 0) + c);
  if (allTools.size && chars < maxChars - 500) {
    add("\n## Tool Usage Summary\n\n");
    for (const [n, c] of topTools(allTools, 15)) add(`- ${n}: ${c}\n`);
  }
  return parts.join("");
}

function parseArgs(argv: string[]) {
  const args = { hours: DEFAULT_HOURS, maxTokens: DEFAULT_MAX_TOKENS, list: false, session: null as string | null,
    excludeTriggers: [] as string[], pruneDays: null as number | null };
  for (let i = 0; i < argv.length; i++) {
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${argv[i - 1]} needs a value`);
      return v;
    };
    const flag = argv[i]!;
    if (flag === "--hours") args.hours = Number(value());
    else if (flag === "--max-tokens") args.maxTokens = Number(value());
    else if (flag === "--list") args.list = true;
    else if (flag === "--session") args.session = value();
    else if (flag === "--exclude-trigger") args.excludeTriggers.push(value());
    else if (flag === "--prune-days") args.pruneDays = Number(value());
    else throw new Error(`Unknown option: ${flag}`);
  }
  for (const [name, n] of [["--hours", args.hours], ["--max-tokens", args.maxTokens], ["--prune-days", args.pruneDays ?? 1]] as const) {
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`${(err as Error).message}\nUsage: sessions [--hours N] [--max-tokens N] [--list] [--session <ref>] [--exclude-trigger <name>]... [--prune-days N]`);
    return 2;
  }
  const home = process.env.HOME ?? "/home/agent";
  const store = createSessionStore({ home });

  if (args.pruneDays !== null) {
    const removed = store.prune({ inactiveBefore: new Date(Date.now() - args.pruneDays * 86400_000).toISOString() });
    console.log(`Sessions pruned: ${removed} inactive for more than ${args.pruneDays} days`);
    return 0;
  }

  if (args.session) {
    const target = parseReference(args.session, store);
    const read = target ? await store.load(target.ref, { maxBytes: Infinity, agent: target.agent }) : null;
    if (!target || !read) {
      console.error(`Session not found: ${args.session}`);
      return 1;
    }
    const id = target.agent ?? target.ref.nativeId;
    const reference = target.agent ? `${target.ref.nativeId}/${target.agent}` : target.ref.nativeId;
    console.log(formatFull(summarize(id, reference, !!target.agent, read.entries)));
    return 0;
  }

  const summaries = (await recentSessions(store, args.hours, excludedSessionIds(args.excludeTriggers, home)))
    .filter((s) => s.turnCount > 0);
  if (!summaries.length) {
    console.log(`No sessions with content in the last ${args.hours} hours.`);
    return 0;
  }
  if (args.list) {
    const rows = [`# Sessions from last ${args.hours}h (${summaries.length} sessions)\n`,
      "type | id | turns | time | tools | context | session", "--- | --- | --- | --- | --- | --- | ---"];
    console.log(rows.join("\n"));
    process.stdout.write(summaries.map(formatIndex).join(""));
    return 0;
  }
  console.log(formatExtract(summaries, args.hours, args.maxTokens));
  return 0;
}

if (import.meta.main) process.exit(await main());
