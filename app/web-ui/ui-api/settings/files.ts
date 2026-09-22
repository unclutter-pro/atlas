/**
 * Workspace text files edited from Settings (IDENTITY.md, SOUL.md,
 * config.yml, user-extensions.sh) and the ~/secrets directory.
 *
 * Every editable file carries a `version` (mtime in ms). A save that sends
 * the version it loaded fails with 409 when the file changed on disk in the
 * meantime — the agent edits IDENTITY.md and config.yml itself.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { badRequest, HttpError, notFound } from "../shared/http";
import { home, paths } from "../shared/env";

export interface FileDoc {
  /** Display path, e.g. "~/IDENTITY.md". */
  path: string;
  exists: boolean;
  content: string;
  /** mtime in ms; send it back on save for conflict detection. null when the file does not exist. */
  version: number | null;
  updatedAt: string | null;
}

export function displayPath(abs: string): string {
  const h = home();
  return abs.startsWith(h + "/") ? `~/${abs.slice(h.length + 1)}` : abs;
}

export function readDoc(abs: string): FileDoc {
  try {
    const st = statSync(abs);
    return {
      path: displayPath(abs),
      exists: true,
      content: readFileSync(abs, "utf-8"),
      version: Math.floor(st.mtimeMs),
      updatedAt: st.mtime.toISOString(),
    };
  } catch {
    return { path: displayPath(abs), exists: false, content: "", version: null, updatedAt: null };
  }
}

export function currentVersion(abs: string): number | null {
  try {
    return Math.floor(statSync(abs).mtimeMs);
  } catch {
    return null;
  }
}

/** Throws 409 when the client edited an older version than what is on disk. `undefined` skips the check. */
export function assertVersion(abs: string, version: unknown): void {
  if (version === undefined) return;
  if (version !== null && typeof version !== "number") badRequest("'version' must be a number or null");
  if (currentVersion(abs) !== version) {
    throw new HttpError(409, `${displayPath(abs)} changed on disk since you opened it. Reload to get the latest version.`);
  }
}

/** Write via tmp file + rename so a crash never leaves a half-written file. Keeps the existing file mode. */
export function writeAtomic(abs: string, content: string, mode?: number): void {
  mkdirSync(dirname(abs), { recursive: true });
  let keepMode = mode;
  if (keepMode === undefined) {
    try {
      keepMode = statSync(abs).mode & 0o777;
    } catch {}
  }
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, content, keepMode !== undefined ? { mode: keepMode } : undefined);
    if (keepMode !== undefined) chmodSync(tmp, keepMode); // writeFileSync's mode is masked by umask
    renameSync(tmp, abs);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

export function contentField(body: Record<string, unknown>, max = 1_000_000): string {
  if (typeof body.content !== "string") badRequest("Missing 'content' field");
  if (body.content.length > max) badRequest("Content too large");
  return body.content;
}

// --- Secrets ---------------------------------------------------------------

export interface SecretItem {
  name: string;
  updatedAt: string | null;
  /** Config keys that point at this secret file, e.g. "email.password_file". */
  usedBy: string[];
}

const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function secretPath(name: string): string {
  if (!SECRET_NAME.test(name) || name.includes("..")) {
    badRequest("Invalid secret name. Use letters, digits, '.', '_' and '-' (max 128 characters, no leading dot).");
  }
  return join(paths.secrets(), name);
}

export function listSecrets(usedBy: (name: string) => string[]): SecretItem[] {
  const dir = paths.secrets();
  if (!existsSync(dir)) return [];
  const items: SecretItem[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile()) continue;
      items.push({ name, updatedAt: st.mtime.toISOString(), usedBy: usedBy(name) });
    } catch {}
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export function writeSecret(name: string, value: string): { created: boolean } {
  const abs = secretPath(name);
  const created = !existsSync(abs);
  mkdirSync(paths.secrets(), { recursive: true, mode: 0o700 });
  writeAtomic(abs, value, 0o600);
  return { created };
}

export function deleteSecret(name: string): void {
  const abs = secretPath(name);
  if (!existsSync(abs)) notFound(`No secret named ${name}`);
  unlinkSync(abs);
}
