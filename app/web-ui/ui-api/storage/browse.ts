/**
 * Read-only file browser rooted at HOME, backing /ui/api/storage/browse/*
 * and /ui/api/storage/download/*.
 *
 * Every client-supplied path goes through resolveHomePath(): rejects
 * absolute paths, `..`, NUL bytes and backslashes, checks the resolved path
 * stays under HOME, then re-checks with realpath so a symlink cannot point
 * outside HOME. Unlike ~/memory (knowledge/files.ts) hidden segments are
 * allowed here — the whole point is to see .claude, .index, etc. Listings
 * never follow symlinks into their targets.
 *
 * Secrets (HOME/secrets/**, .claude/.credentials.json, .ssh/**, *.pem,
 * *.key, .env files, *.credentials*) are listed (name + size) but their
 * content and download are always denied. config.yml is shown through the
 * same secret-masking as Settings instead of being denied outright.
 */

import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, type Stats } from "fs";
import { dirname, join, resolve, sep } from "path";
import { HttpError } from "../shared/http";
import { home } from "../shared/env";
import { maskSecrets } from "../settings/mask";

export const MAX_PREVIEW_BYTES = 256 * 1024;
const SNIFF_BYTES = 8000;

// --- Path safety -------------------------------------------------------------

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/** Validate a client path (relative to HOME) and return its absolute path. "" means HOME itself. */
export function resolveHomePath(rel: string): { abs: string; rel: string } {
  if (typeof rel !== "string") throw new HttpError(400, "Invalid path");
  if (rel.includes("\0") || rel.includes("\\")) throw new HttpError(400, "Invalid path");
  if (rel.startsWith("/")) throw new HttpError(400, "Invalid path");
  const segs = rel.split("/").filter((s) => s !== "");
  if (segs.some((s) => s === "." || s === "..")) throw new HttpError(400, "Invalid path");

  const root = resolve(home());
  const abs = segs.length ? resolve(root, ...segs) : root;
  if (!isInside(root, abs)) throw new HttpError(400, "Invalid path");

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

// --- Secrets -------------------------------------------------------------

const SECRET_DIR_PREFIXES = ["secrets/", ".ssh/"];
const SECRET_EXT = /\.(pem|key)$/i;
const DOTENV_RE = /(^|\/)\.env(\.[^/]*)?$/i;
const CREDENTIALS_RE = /\.credentials/i;

/** Content and download of these are always denied; listing (name/size) is still shown. */
export function isSecretPath(rel: string): boolean {
  if (rel === "secrets" || rel === ".ssh") return true;
  if (SECRET_DIR_PREFIXES.some((p) => rel.startsWith(p))) return true;
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return SECRET_EXT.test(name) || DOTENV_RE.test(rel) || CREDENTIALS_RE.test(name);
}

const isLogFile = (rel: string) => /\.log(\.\d+)?$/i.test(rel);

// --- Better views -------------------------------------------------------------

export type BetterView = { kind: "memory"; path: string } | { kind: "session"; sessionId: string };

const SESSION_RE = /^\.claude\/projects\/.+\/([^/]+)\.jsonl$/;

export function betterViewFor(rel: string): BetterView | null {
  const session = rel.match(SESSION_RE);
  if (session) return { kind: "session", sessionId: session[1]! };
  if (rel.startsWith("memory/") && rel.length > "memory/".length) return { kind: "memory", path: rel.slice("memory/".length) };
  return null;
}

// --- Directory listing -------------------------------------------------------------

export interface BrowseEntry {
  name: string;
  path: string;
  kind: "dir" | "file" | "other";
  sizeBytes: number;
  modifiedAt: string | null;
  hidden: boolean;
  secret: boolean;
}

export interface BrowseDir {
  type: "dir";
  path: string;
  entries: BrowseEntry[];
}

export function listDir(rel: string, abs: string): BrowseDir {
  let dirents;
  try {
    dirents = readdirSync(abs, { withFileTypes: true });
  } catch {
    throw new HttpError(404, "No such directory");
  }
  const entries: BrowseEntry[] = dirents.map((d) => {
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    const childAbs = join(abs, d.name);
    let kind: BrowseEntry["kind"] = "other";
    let sizeBytes = 0;
    let modifiedAt: string | null = null;
    try {
      const st = lstatSync(childAbs);
      modifiedAt = new Date(st.mtimeMs).toISOString();
      if (st.isSymbolicLink()) kind = "other"; // never followed
      else if (st.isDirectory()) kind = "dir";
      else if (st.isFile()) {
        kind = "file";
        sizeBytes = st.size;
      }
    } catch {}
    return { name: d.name, path: childRel, kind, sizeBytes, modifiedAt, hidden: d.name.startsWith("."), secret: isSecretPath(childRel) };
  });
  entries.sort((a, b) => {
    if ((a.kind === "dir") !== (b.kind === "dir")) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { type: "dir", path: rel, entries };
}

// --- File preview -------------------------------------------------------------

export interface BrowseFile {
  type: "file";
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  secret: boolean;
  /** Content and download withheld: `secret` and not config.yml (which is masked instead). */
  denied: boolean;
  /** Content looks binary (a NUL byte in the first bytes) — no preview offered. */
  binary: boolean;
  /** config.yml: secrets masked the same way as Settings. */
  masked: boolean;
  /** Larger than MAX_PREVIEW_BYTES and not a .log — no preview offered. */
  tooLarge: boolean;
  /** .log file bigger than the cap: `content` is its tail, not the whole file. */
  tail: boolean;
  content: string | null;
  betterView: BetterView | null;
}

function sniffIsBinary(abs: string, size: number): boolean {
  if (size === 0) return false;
  const len = Math.min(size, SNIFF_BYTES);
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    return buf.includes(0);
  } finally {
    closeSync(fd);
  }
}

function readTail(abs: string, size: number, maxBytes: number): string {
  const len = Math.min(size, maxBytes);
  const start = size - len;
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    let text = buf.toString("utf-8");
    // The read likely starts mid-line; drop the partial first line.
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl !== -1 && nl < 200) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

export function loadFile(rel: string, abs: string, st: Stats): BrowseFile {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const secret = isSecretPath(rel);
  const isConfigYml = rel === "config.yml";
  const base = {
    path: rel,
    name,
    sizeBytes: st.size,
    modifiedAt: new Date(st.mtimeMs).toISOString(),
    secret,
    betterView: betterViewFor(rel),
  } as const;

  if (secret && !isConfigYml) {
    return { type: "file", ...base, denied: true, binary: false, masked: false, tooLarge: false, tail: false, content: null };
  }
  if (sniffIsBinary(abs, st.size)) {
    return { type: "file", ...base, denied: false, binary: true, masked: false, tooLarge: false, tail: false, content: null };
  }
  if (st.size <= MAX_PREVIEW_BYTES) {
    let content = readFileSync(abs, "utf-8");
    if (isConfigYml) content = maskSecrets(content);
    return { type: "file", ...base, denied: false, binary: false, masked: isConfigYml, tooLarge: false, tail: false, content };
  }
  if (isLogFile(rel)) {
    let content = readTail(abs, st.size, MAX_PREVIEW_BYTES);
    if (isConfigYml) content = maskSecrets(content);
    return { type: "file", ...base, denied: false, binary: false, masked: isConfigYml, tooLarge: false, tail: true, content };
  }
  return { type: "file", ...base, denied: false, binary: false, masked: false, tooLarge: true, tail: false, content: null };
}

// --- Download -------------------------------------------------------------

const MIME: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".sh": "text/x-sh; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

function mimeFor(rel: string): string {
  const dot = rel.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME[rel.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/** null when the file is a secret (other than config.yml) and download must be denied. */
export function loadDownload(rel: string, abs: string): { body: string | Buffer; mime: string } | null {
  if (isSecretPath(rel) && rel !== "config.yml") return null;
  if (rel === "config.yml") return { body: maskSecrets(readFileSync(abs, "utf-8")), mime: "text/plain; charset=utf-8" };
  return { body: readFileSync(abs), mime: mimeFor(rel) };
}
