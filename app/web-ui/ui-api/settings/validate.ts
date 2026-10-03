/**
 * Pre-save checks for config.yml and user-extensions.sh.
 *
 * config.yml: a syntax error is fatal (resolveConfig would silently fall
 * back to defaults for everything). Wrong value types are errors the user
 * can override ("save anyway"); YAML turns an unquoted +4917… into a
 * number, which breaks signal.number and whitelists. Unknown sections are
 * only warnings.
 */

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import yaml from "js-yaml";
import { getConfigDefaults } from "../../../lib/config";

export interface ValidationIssue {
  /** Dot path ("signal.number") or "" for the whole file. */
  path: string;
  message: string;
  severity: "error" | "warning";
  line?: number;
}

export interface ValidationResult {
  /** Parse error: the file cannot be saved. */
  syntaxError: { message: string; line: number | null } | null;
  issues: ValidationIssue[];
}

type Kind = "string" | "number" | "boolean" | "string[]" | "object";

// Top-level sections read by something other than lib/config.
const EXTRA_SECTIONS = ["team", "telegram", "whatsapp"];
const EXTRA_KEYS: Record<string, Kind> = { "email.idle_timeout": "number" };

/** Top-level keys in DEFAULTS that are scalars (e.g. `timezone: ""`), not `section: { key: value }` mappings. */
const TOP_LEVEL_SCALAR_KEYS = new Set(["timezone"]);

function kindOf(v: unknown): Kind | "array" | "null" {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.every((x) => typeof x === "string") ? "string[]" : "array";
  if (typeof v === "object") return "object";
  return typeof v as Kind;
}

let schemaCache: { sections: Set<string>; keys: Map<string, Kind> } | null = null;

/** Expected kinds derived from the built-in defaults. */
function schema() {
  if (schemaCache) return schemaCache;
  const defaults = getConfigDefaults() as unknown as Record<string, Record<string, unknown>>;
  const keys = new Map<string, Kind>();
  for (const [section, values] of Object.entries(defaults)) {
    if (section === "plugins") continue;
    if (TOP_LEVEL_SCALAR_KEYS.has(section)) {
      const kind = kindOf(values);
      keys.set(section, kind === "array" || kind === "null" ? "string[]" : kind);
      continue;
    }
    for (const [k, v] of Object.entries(values)) {
      const kind = kindOf(v);
      keys.set(`${section}.${k}`, kind === "array" || kind === "null" ? "string[]" : kind);
    }
  }
  for (const [k, kind] of Object.entries(EXTRA_KEYS)) keys.set(k, kind);
  schemaCache = { sections: new Set([...Object.keys(defaults), ...EXTRA_SECTIONS]), keys };
  return schemaCache;
}

export function validateConfigYaml(content: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    const e = err as { reason?: string; message?: string; mark?: { line?: number } };
    const line = typeof e.mark?.line === "number" ? e.mark.line + 1 : null;
    return { syntaxError: { message: e.reason || e.message || String(err), line }, issues: [] };
  }
  if (parsed == null) return { syntaxError: null, issues: [] };
  if (kindOf(parsed) !== "object") {
    return { syntaxError: { message: "The top level must be a mapping (key: value pairs).", line: null }, issues: [] };
  }

  const { sections, keys } = schema();
  const issues: ValidationIssue[] = [];
  const root = parsed as Record<string, unknown>;

  for (const [section, value] of Object.entries(root)) {
    if (!sections.has(section)) {
      issues.push({ path: section, severity: "warning", message: "Unknown section — Atlas does not read it." });
      continue;
    }
    if (value == null) continue;
    if (TOP_LEVEL_SCALAR_KEYS.has(section)) {
      const expected = keys.get(section);
      if (expected && kindOf(value) !== expected) {
        issues.push({ path: section, severity: "error", message: `Expected ${label(expected)}, got ${describe(value)}.` });
      }
      continue;
    }
    if (kindOf(value) !== "object") {
      issues.push({ path: section, severity: "error", message: `Must be a mapping, got ${describe(value)}.` });
      continue;
    }
    if (section === "plugins") {
      const enabled = (value as Record<string, unknown>).enabled;
      if (enabled != null && kindOf(enabled) !== "object") {
        issues.push({ path: "plugins.enabled", severity: "error", message: `Must be a mapping of plugin id to true/false, got ${describe(enabled)}.` });
      } else if (enabled) {
        for (const [id, on] of Object.entries(enabled as Record<string, unknown>)) {
          if (typeof on !== "boolean") issues.push({ path: `plugins.enabled.${id}`, severity: "error", message: `Must be true or false, got ${describe(on)}.` });
        }
      }
      continue;
    }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const path = `${section}.${key}`;
      const expected = keys.get(path);
      if (!expected || v == null) continue;
      const actual = kindOf(v);
      if (actual === expected) continue;
      const hint = expected === "string" && typeof v === "number" ? " Quote the value." : expected === "string[]" && Array.isArray(v) ? " Quote every entry." : "";
      issues.push({ path, severity: "error", message: `Expected ${label(expected)}, got ${describe(v)}.${hint}` });
    }
  }
  return { syntaxError: null, issues };
}

function label(kind: Kind): string {
  return kind === "string[]" ? "a list of strings" : kind === "object" ? "a mapping" : `a ${kind}`;
}

function describe(v: unknown): string {
  const k = kindOf(v);
  if (k === "array" || k === "string[]") return "a list";
  if (k === "object") return "a mapping";
  if (k === "null") return "nothing";
  return `${k} ${JSON.stringify(v)}`;
}

/**
 * `bash -n` syntax check. Returns null when bash is not available (the
 * check is skipped), otherwise the issues found (empty = OK).
 */
export function checkBashSyntax(content: string): ValidationIssue[] | null {
  const dir = mkdtempSync(join(tmpdir(), "atlas-ext-"));
  const file = join(dir, "user-extensions.sh");
  try {
    writeFileSync(file, content);
    let exitCode: number | null;
    let stderr: string;
    try {
      const res = Bun.spawnSync(["bash", "-n", file], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
      exitCode = res.exitCode;
      stderr = res.stderr.toString();
    } catch {
      return null;
    }
    if (exitCode === null) return null; // timed out
    if (exitCode === 0) return [];
    const out = stderr.split(file).join("user-extensions.sh").trim();
    return out
      .split("\n")
      .filter(Boolean)
      .map((message: string) => {
        const m = message.match(/line (\d+):/);
        return { path: "", severity: "error" as const, message, line: m ? Number(m[1]) : undefined };
      });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
