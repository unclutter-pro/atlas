/**
 * /ui/api/knowledge/* — endpoints for the Knowledge area (frontend/pages/knowledge/).
 *
 *   GET    /ui/api/knowledge                 MEMORY.md, file tree, journal summary
 *   GET    /ui/api/knowledge/search?q=       full-text search with match offsets
 *   GET    /ui/api/knowledge/file/<path>     one file under ~/memory
 *   PUT    /ui/api/knowledge/file/<path>     save {content, baseMtimeMs}; 409 on conflict
 *   DELETE /ui/api/knowledge/file/<path>     delete (never MEMORY.md or journals)
 *   GET    /ui/api/knowledge/journal         days with entries
 *   GET    /ui/api/knowledge/journal/:date   one day plus previous/next entry
 *
 * Journals are read-only here. Path handling lives in ./knowledge/files.ts.
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { home, paths } from "./shared/env";
import { handler, json, query, readJson, badRequest, notFound, HttpError, type ApiRoutes } from "./shared/http";
import {
  MAX_READ_BYTES,
  isReadOnly,
  isValidDate,
  journalDateOf,
  listJournalDays,
  meta,
  readText,
  resolveMemoryPath,
  searchMemory,
  statOrNull,
  walkMemory,
  type FileMeta,
  type JournalDay,
  type SearchHit,
} from "./knowledge/files";

export type { FileMeta, JournalDay, SearchHit, SearchLine } from "./knowledge/files";

export interface MemoryFileResponse extends FileMeta {
  content: string;
  kind: "memory" | "journal";
  /** Journal date when the file is a dated journal entry. */
  date: string | null;
  editable: boolean;
  /** Only MEMORY.md and journals are protected from deletion. */
  deletable: boolean;
}

export interface KnowledgeOverviewResponse {
  /** ~/memory/MEMORY.md, or the legacy ~/MEMORY.md (read-only) when only that exists. */
  memory: (MemoryFileResponse & { legacyLocation: boolean }) | null;
  /** Everything under ~/memory except MEMORY.md and dated journal entries. */
  files: FileMeta[];
  journal: { count: number; latest: JournalDay | null; recent: JournalDay[] };
}

export interface SearchResponse {
  q: string;
  hits: SearchHit[];
  truncated: boolean;
  /** Number of files whose content was searched. */
  scanned: number;
}

export interface JournalListResponse {
  days: JournalDay[];
}

export interface JournalDayResponse {
  date: string;
  /** null when there is no entry for this day. */
  entry: (FileMeta & { content: string; legacyLocation: boolean }) | null;
  /** Nearest days with entries before/after `date`. */
  prev: string | null;
  next: string | null;
  latest: string | null;
}

export interface SaveFileRequest {
  content: string;
  /** mtime the edit was based on; null to create a new file. */
  baseMtimeMs: number | null;
}

export interface SaveConflictResponse {
  error: string;
  conflict: true;
  current: MemoryFileResponse | null;
}

const FILE_PREFIX = "/ui/api/knowledge/file/";

/** Path after /file/, decoded per segment (Bun gives no params for a trailing `*`). */
function filePathOf(req: Request): string {
  const pathname = new URL(req.url).pathname;
  if (!pathname.startsWith(FILE_PREFIX)) badRequest("Missing path");
  try {
    return pathname.slice(FILE_PREFIX.length).split("/").map(decodeURIComponent).join("/");
  } catch {
    badRequest("Invalid path");
  }
}

function loadFile(rel: string, abs: string): MemoryFileResponse | null {
  const st = statOrNull(abs);
  if (!st) return null;
  if (!st.isFile()) throw new HttpError(400, "Not a file");
  if (st.size > MAX_READ_BYTES) throw new HttpError(413, "File is too large to display");
  const date = journalDateOf(rel);
  return {
    ...meta(rel, st),
    content: readText(abs),
    kind: date ? "journal" : "memory",
    date,
    editable: !isReadOnly(rel),
    deletable: !isReadOnly(rel) && rel !== "MEMORY.md",
  };
}

/** Write via temp file + rename so readers (and the agent) never see a half-written file. */
function atomicWrite(abs: string, content: string) {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.${basename(abs)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, abs);
}

function overview(): KnowledgeOverviewResponse {
  const all = walkMemory();
  let memory: KnowledgeOverviewResponse["memory"] = null;
  const main = loadFile("MEMORY.md", paths.memoryMd());
  if (main) memory = { ...main, legacyLocation: false };
  else {
    const legacy = join(home(), "MEMORY.md");
    const st = statOrNull(legacy);
    if (st?.isFile() && st.size <= MAX_READ_BYTES) {
      memory = { ...meta("MEMORY.md", st), content: readText(legacy), kind: "memory", date: null, editable: false, deletable: false, legacyLocation: true };
    }
  }
  const days = listJournalDays(all);
  return {
    memory,
    files: all.filter((f) => f.path !== "MEMORY.md" && journalDateOf(f.path) === null),
    journal: { count: days.length, latest: days[0] ?? null, recent: days.slice(0, 7) },
  };
}

function journalDay(date: string): JournalDayResponse {
  if (!isValidDate(date)) badRequest("Date must be YYYY-MM-DD");
  const days = listJournalDays();
  const day = days.find((d) => d.date === date);
  let entry: JournalDayResponse["entry"] = null;
  if (day) {
    const { abs } = resolveMemoryPath(day.path);
    const st = statOrNull(abs);
    if (st && st.size <= MAX_READ_BYTES) {
      entry = { ...meta(day.path, st), content: readText(abs), legacyLocation: !day.path.startsWith("journal/") };
    }
  }
  // days are newest first
  const prev = days.find((d) => d.date < date)?.date ?? null;
  const next = [...days].reverse().find((d) => d.date > date)?.date ?? null;
  return { date, entry, prev, next, latest: days[0]?.date ?? null };
}

export const routes: ApiRoutes = {
  "/ui/api/knowledge": {
    GET: handler(() => json(overview() satisfies KnowledgeOverviewResponse)),
  },

  "/ui/api/knowledge/search": {
    GET: handler((req) => {
      const q = (query(req).get("q") ?? "").trim();
      if (q.length > 200) badRequest("Query too long");
      return json({ q, ...searchMemory(q) } satisfies SearchResponse);
    }),
  },

  "/ui/api/knowledge/file/*": {
    GET: handler((req) => {
      const { abs, rel } = resolveMemoryPath(filePathOf(req));
      return json(loadFile(rel, abs) ?? notFound("No such file"));
    }),

    PUT: handler(async (req) => {
      const { abs, rel } = resolveMemoryPath(filePathOf(req));
      const body = await readJson<Partial<SaveFileRequest>>(req);
      if (isReadOnly(rel)) throw new HttpError(403, "Journal entries are read-only");
      if (typeof body.content !== "string") badRequest("Missing 'content'");
      if (body.baseMtimeMs !== null && typeof body.baseMtimeMs !== "number") badRequest("Missing 'baseMtimeMs' (null to create)");
      if (Buffer.byteLength(body.content) > MAX_READ_BYTES) throw new HttpError(413, "Content too large");
      if (body.baseMtimeMs === null && !/\.(md|txt)$/i.test(rel)) badRequest("New files must end in .md or .txt");

      const st = statOrNull(abs);
      if (st && !st.isFile()) badRequest("Not a file");
      const conflict =
        body.baseMtimeMs === null ? st !== null : !st || Math.abs(st.mtimeMs - body.baseMtimeMs) > 0.5;
      if (conflict) {
        const current = st ? loadFile(rel, abs) : null;
        const error = body.baseMtimeMs === null ? "A file with this name already exists" : current ? "The file changed on disk since you opened it" : "The file was deleted since you opened it";
        return json({ error, conflict: true, current } satisfies SaveConflictResponse, { status: 409 });
      }

      atomicWrite(abs, body.content);
      return json(loadFile(rel, abs)!);
    }),

    DELETE: handler(async (req) => {
      const { abs, rel } = resolveMemoryPath(filePathOf(req));
      await readJson(req);
      if (isReadOnly(rel)) throw new HttpError(403, "Journal entries are read-only");
      if (rel === "MEMORY.md") throw new HttpError(403, "MEMORY.md cannot be deleted");
      const st = statOrNull(abs);
      if (!st) notFound("No such file");
      if (!st.isFile()) badRequest("Not a file");
      unlinkSync(abs);
      return json({ ok: true, path: rel });
    }),
  },

  "/ui/api/knowledge/journal": {
    GET: handler(() => json({ days: listJournalDays() } satisfies JournalListResponse)),
  },

  "/ui/api/knowledge/journal/:date": {
    GET: handler((req) => json(journalDay(req.params.date ?? "") satisfies JournalDayResponse)),
  },
};
