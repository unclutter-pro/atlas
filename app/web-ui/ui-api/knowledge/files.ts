/**
 * Filesystem access for the Knowledge area: safe path resolution inside
 * ~/memory, the file tree, journals and full-text search.
 *
 * Every client-supplied path goes through resolveMemoryPath(). It rejects
 * absolute paths, `..`, hidden segments and NUL bytes, checks the resolved
 * path stays under ~/memory (the legacy /memory/view approach) and then
 * re-checks with realpath so a symlink cannot point outside the root.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync, type Stats } from "fs";
import { dirname, join, resolve, sep } from "path";
import { paths } from "../shared/env";
import { HttpError } from "../shared/http";

export const MAX_READ_BYTES = 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const SEARCHABLE = /\.(md|markdown|txt|json|ya?ml)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type FileKind = "memory" | "journal";

export interface FileMeta {
  /** Path relative to ~/memory with forward slashes. */
  path: string;
  size: number;
  modifiedAt: string;
  mtimeMs: number;
}

/** A dated journal file: memory/journal/YYYY-MM-DD.md or legacy memory/YYYY-MM-DD.md. */
export function journalDateOf(rel: string): string | null {
  const m = rel.match(/^(?:journal\/)?(\d{4}-\d{2}-\d{2})\.md$/);
  return m ? m[1]! : null;
}

/** Journals are append-only records of what happened; the UI never edits them. */
export function isReadOnly(rel: string): boolean {
  return journalDateOf(rel) !== null || rel === "journal" || rel.startsWith("journal/");
}

export function isValidDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/**
 * Validate a client path (relative to ~/memory) and return its absolute path.
 * Throws 400 for anything suspicious. The target does not need to exist.
 */
export function resolveMemoryPath(rel: string): { abs: string; rel: string } {
  if (typeof rel !== "string" || !rel.trim()) throw new HttpError(400, "Missing path");
  if (rel.includes("\0") || rel.includes("\\")) throw new HttpError(400, "Invalid path");
  if (rel.startsWith("/")) throw new HttpError(400, "Invalid path");
  const segs = rel.split("/").filter((s) => s !== "");
  if (segs.length === 0 || segs.some((s) => s === "." || s === ".." || s.startsWith("."))) {
    throw new HttpError(400, "Invalid path");
  }
  const root = resolve(paths.memory());
  const abs = resolve(root, ...segs);
  if (!isInside(root, abs) || abs === root) throw new HttpError(400, "Invalid path");

  // Symlink escape: compare real paths of the deepest existing ancestor.
  if (existsSync(root)) {
    const realRoot = realpathSync(root);
    let probe = abs;
    while (!existsSync(probe) && isInside(root, dirname(probe)) && probe !== root) probe = dirname(probe);
    if (existsSync(probe) && !isInside(realRoot, realpathSync(probe))) throw new HttpError(400, "Invalid path");
  }
  return { abs, rel: segs.join("/") };
}

export function statOrNull(abs: string): Stats | null {
  try {
    return statSync(abs);
  } catch {
    return null;
  }
}

export function meta(rel: string, st: Stats): FileMeta {
  return { path: rel, size: st.size, modifiedAt: new Date(st.mtimeMs).toISOString(), mtimeMs: st.mtimeMs };
}

/** All non-hidden files under ~/memory (relative paths, sorted). Symlinked dirs are not followed. */
export function walkMemory(): Array<FileMeta> {
  const root = paths.memory();
  const out: FileMeta[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs, rel);
      else if (e.isFile()) {
        const st = statOrNull(abs);
        if (st) out.push(meta(rel, st));
      }
    }
  };
  if (existsSync(root)) walk(root, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export interface JournalDay {
  date: string;
  path: string;
  size: number;
  modifiedAt: string;
}

/** Every day with a journal entry, newest first. journal/ wins over the legacy root location. */
export function listJournalDays(files: FileMeta[] = walkMemory()): JournalDay[] {
  const byDate = new Map<string, JournalDay>();
  for (const f of files) {
    const date = journalDateOf(f.path);
    if (!date || !isValidDate(date)) continue;
    const existing = byDate.get(date);
    if (existing && existing.path.startsWith("journal/")) continue;
    byDate.set(date, { date, path: f.path, size: f.size, modifiedAt: f.modifiedAt });
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export function readText(abs: string): string {
  return readFileSync(abs, "utf-8");
}

// --- Search -----------------------------------------------------------------

export interface SearchLine {
  /** 1-based line number. */
  line: number;
  text: string;
  /** [start, end) character offsets of each match within `text`. */
  ranges: Array<[number, number]>;
}

export interface SearchHit {
  path: string;
  kind: FileKind;
  /** Set for journal files. */
  date: string | null;
  /** Query matched the file path itself. */
  pathMatch: boolean;
  matchCount: number;
  lines: SearchLine[];
  modifiedAt: string;
}

const MAX_LINE_CHARS = 240;

/** Trim a long line to a window around its first match, shifting the ranges. */
function snippet(text: string, ranges: Array<[number, number]>): { text: string; ranges: Array<[number, number]> } {
  if (text.length <= MAX_LINE_CHARS) return { text, ranges };
  const first = ranges[0]![0];
  const start = Math.max(0, Math.min(first - 60, text.length - MAX_LINE_CHARS));
  const end = start + MAX_LINE_CHARS;
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const shifted = ranges
    .filter(([s, e]) => s >= start && e <= end)
    .map(([s, e]) => [s - start + prefix.length, e - start + prefix.length] as [number, number]);
  return { text: prefix + text.slice(start, end) + suffix, ranges: shifted };
}

function findRanges(haystack: string, needle: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const h = haystack.toLowerCase();
  let i = h.indexOf(needle);
  while (i !== -1) {
    out.push([i, i + needle.length]);
    i = h.indexOf(needle, i + needle.length);
  }
  return out;
}

/**
 * Case-insensitive substring search over ~/memory (legacy /memory/search
 * semantics) with line numbers and match offsets for highlighting.
 * Ranking: MEMORY.md, then path matches, then most matches, then newest.
 */
export function searchMemory(q: string, opts: { maxFiles?: number; maxLines?: number } = {}): { hits: SearchHit[]; truncated: boolean; scanned: number } {
  const maxFiles = opts.maxFiles ?? 50;
  const maxLines = opts.maxLines ?? 5;
  const needle = q.trim().toLowerCase();
  const root = paths.memory();
  const hits: SearchHit[] = [];
  let scanned = 0;
  if (!needle) return { hits, truncated: false, scanned };

  for (const f of walkMemory()) {
    const pathMatch = f.path.toLowerCase().includes(needle);
    const lines: SearchLine[] = [];
    let matchCount = 0;
    if (SEARCHABLE.test(f.path) && f.size <= MAX_SEARCH_FILE_BYTES) {
      scanned++;
      let content: string;
      try {
        content = readText(join(root, f.path));
      } catch {
        continue;
      }
      const all = content.split("\n");
      for (let i = 0; i < all.length; i++) {
        const text = all[i]!.replace(/\r$/, "");
        const ranges = findRanges(text, needle);
        if (!ranges.length) continue;
        matchCount += ranges.length;
        if (lines.length < maxLines) lines.push({ line: i + 1, ...snippet(text, ranges) });
      }
    }
    if (!matchCount && !pathMatch) continue;
    const date = journalDateOf(f.path);
    hits.push({ path: f.path, kind: date ? "journal" : "memory", date, pathMatch, matchCount, lines, modifiedAt: f.modifiedAt });
  }

  const rank = (h: SearchHit) => (h.path === "MEMORY.md" ? 0 : h.pathMatch ? 1 : 2);
  hits.sort((a, b) => rank(a) - rank(b) || b.matchCount - a.matchCount || b.modifiedAt.localeCompare(a.modifiedAt));
  return { hits: hits.slice(0, maxFiles), truncated: hits.length > maxFiles, scanned };
}
