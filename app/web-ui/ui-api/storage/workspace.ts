/**
 * Workspace breakdown: size and file count per top-level entry in HOME, the
 * 20 largest files, and the SQLite DB size (including -wal/-shm).
 *
 * Walking HOME can be slow, so this:
 *   - uses fs/promises so the event loop is never blocked for long (each
 *     readdir/lstat yields control back)
 *   - never follows symlinks (lstat, skip on isSymbolicLink)
 *   - caches the result for 60s, keyed by HOME, with a computedAt timestamp
 *     and a `refresh` param to force a recompute
 *   - caps the walk at MAX_ENTRIES / MAX_WALK_MS and reports `truncated`
 */

import { readdir, lstat } from "fs/promises";
import { statSync } from "fs";
import { join } from "path";
import { home } from "../shared/env";

const MAX_ENTRIES = 200_000;
const MAX_WALK_MS = 4_000;
const LARGEST_N = 20;
const CACHE_TTL_MS = 60_000;

/** Known top-level entries, per docs/directory-structure.md. .claude is split so the (often large) transcript archive stands out. */
const KNOWN_LABELS: Record<string, string> = {
  ".claude/projects": "Claude Code session transcripts",
  ".claude": "Claude Code config (skills, agents, settings)",
  ".atlas-mcp": "User MCP config (Playwright, custom tools)",
  ".index": "Database and per-channel state (SQLite)",
  ".attachments": "Message attachments",
  memory: "Long-term memory",
  projects: "Working directories",
  triggers: "Custom trigger prompts",
  mcps: "User-installed MCP servers",
  secrets: "Secrets (API keys, credentials)",
  bin: "User scripts",
  "supervisor.d": "Supervisord config overrides",
  "IDENTITY.md": "Agent identity/personality",
  "SOUL.md": "Agent core values",
  "config.yml": "System configuration",
  crontab: "Generated crontab",
  "user-extensions.sh": "Runs on every container start",
};

export interface WorkspaceEntry {
  key: string;
  label: string | null;
  kind: "dir" | "file";
  sizeBytes: number;
  fileCount: number;
}

export interface WorkspaceLargestFile {
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface WorkspaceDatabase {
  path: string;
  sizeBytes: number;
  walSizeBytes: number;
  shmSizeBytes: number;
  totalSizeBytes: number;
}

export interface WorkspaceResponse {
  computedAt: string;
  truncated: boolean;
  totalSizeBytes: number;
  totalFileCount: number;
  entries: WorkspaceEntry[];
  largestFiles: WorkspaceLargestFile[];
  database: WorkspaceDatabase | null;
}

interface Bucket {
  sizeBytes: number;
  fileCount: number;
  kind: "dir" | "file";
}

interface WalkState {
  entries: number;
  startedAt: number;
  truncated: boolean;
  buckets: Map<string, Bucket>;
  largest: WorkspaceLargestFile[];
  totalSizeBytes: number;
  totalFileCount: number;
}

/** Which top-level bucket a file belongs to. .claude/projects/* is split out from the rest of .claude. */
function bucketKeyOf(segs: string[]): string {
  if (segs[0] === ".claude" && segs[1] === "projects") return ".claude/projects";
  return segs[0]!;
}

function addLargest(state: WalkState, path: string, sizeBytes: number, modifiedAt: string): void {
  const arr = state.largest;
  if (arr.length >= LARGEST_N && sizeBytes <= arr[arr.length - 1]!.sizeBytes) return;
  arr.push({ path, sizeBytes, modifiedAt });
  arr.sort((a, b) => b.sizeBytes - a.sizeBytes);
  if (arr.length > LARGEST_N) arr.length = LARGEST_N;
}

async function walk(dir: string, segsPrefix: string[], state: WalkState): Promise<void> {
  if (state.truncated) return;
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of dirents) {
    if (state.truncated) return;
    state.entries++;
    if (state.entries > MAX_ENTRIES || Date.now() - state.startedAt > MAX_WALK_MS) {
      state.truncated = true;
      return;
    }
    const abs = join(dir, d.name);
    const segs = [...segsPrefix, d.name];
    let st;
    try {
      st = await lstat(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // never followed, never counted
    if (st.isDirectory()) {
      await walk(abs, segs, state);
    } else if (st.isFile()) {
      const key = bucketKeyOf(segs);
      const b = state.buckets.get(key) ?? { sizeBytes: 0, fileCount: 0, kind: "dir" };
      b.sizeBytes += st.size;
      b.fileCount += 1;
      state.buckets.set(key, b);
      state.totalSizeBytes += st.size;
      state.totalFileCount += 1;
      addLargest(state, segs.join("/"), st.size, new Date(st.mtimeMs).toISOString());
    }
  }
}

function loadDatabase(): WorkspaceDatabase | null {
  const dbPath = join(home(), ".index", "atlas.db");
  let sizeBytes: number;
  try {
    sizeBytes = statSync(dbPath).size;
  } catch {
    return null;
  }
  const statOrZero = (p: string) => {
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  };
  const walSizeBytes = statOrZero(`${dbPath}-wal`);
  const shmSizeBytes = statOrZero(`${dbPath}-shm`);
  return { path: "~/.index/atlas.db", sizeBytes, walSizeBytes, shmSizeBytes, totalSizeBytes: sizeBytes + walSizeBytes + shmSizeBytes };
}

async function computeWorkspace(): Promise<Omit<WorkspaceResponse, "computedAt">> {
  const state: WalkState = { entries: 0, startedAt: Date.now(), truncated: false, buckets: new Map(), largest: [], totalSizeBytes: 0, totalFileCount: 0 };

  // Seed from the top-level listing so empty directories and file-vs-dir
  // kind are known even if the walk below is capped before reaching them.
  try {
    for (const d of await readdir(home(), { withFileTypes: true })) {
      if (d.isSymbolicLink()) continue;
      if (d.name === ".claude") {
        state.buckets.set(".claude", { sizeBytes: 0, fileCount: 0, kind: "dir" });
        state.buckets.set(".claude/projects", { sizeBytes: 0, fileCount: 0, kind: "dir" });
      } else if (d.isDirectory()) {
        state.buckets.set(d.name, { sizeBytes: 0, fileCount: 0, kind: "dir" });
      } else if (d.isFile()) {
        state.buckets.set(d.name, { sizeBytes: 0, fileCount: 0, kind: "file" });
      }
    }
  } catch {}

  await walk(home(), [], state);

  const entries: WorkspaceEntry[] = [...state.buckets.entries()]
    .map(([key, b]) => ({ key, label: KNOWN_LABELS[key] ?? null, kind: b.kind, sizeBytes: b.sizeBytes, fileCount: b.fileCount }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes);

  return {
    truncated: state.truncated,
    totalSizeBytes: state.totalSizeBytes,
    totalFileCount: state.totalFileCount,
    entries,
    largestFiles: state.largest,
    database: loadDatabase(),
  };
}

let cache: { home: string; computedAtMs: number; data: WorkspaceResponse } | null = null;

export async function getWorkspace(opts: { refresh?: boolean } = {}): Promise<WorkspaceResponse> {
  const h = home();
  if (!opts.refresh && cache && cache.home === h && Date.now() - cache.computedAtMs < CACHE_TTL_MS) return cache.data;
  const base = await computeWorkspace();
  const data: WorkspaceResponse = { computedAt: new Date().toISOString(), ...base };
  cache = { home: h, computedAtMs: Date.now(), data };
  return data;
}

/** Test-only: drop the cache so the next call recomputes even within the TTL. */
export function resetWorkspaceCacheForTests(): void {
  cache = null;
}
