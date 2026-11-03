#!/usr/bin/env bun
/**
 * Lifecycle policy: blocks `gh` commands that would post a reference to a
 * private GitHub repo into a public one (issue/PR body, comment, review,
 * release notes). Public repos are readable by anyone; a link, `owner/repo#N`
 * mention, or pasted body text naming a private repo leaks its existence and
 * contents to the world even if the private repo itself stays locked down.
 *
 * Usage: gh-reference-guard.ts "<command>" ["<cwd>"]
 * Output: block reason on stdout with exit 2, or nothing with exit 0.
 *
 * Override: prefix the command with `GH_REF_GUARD_OK=1 ` when the reference
 * is actually to a public repo and this guard got it wrong.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";

export type VisibilityResult = "private" | "public" | "not-found";
export type VisibilityLookup = (repo: string) => Promise<VisibilityResult>;

export interface GuardOptions {
  cwd?: string;
  lookup?: VisibilityLookup;
  readFile?: (path: string) => string | null;
  getRemoteUrl?: (cwd: string) => string | null;
  cachePath?: string;
}

type Token = { type: "word"; value: string } | { type: "sep" };

function tokenize(cmd: string): Token[] {
  const tokens: Token[] = [];
  const n = cmd.length;
  let i = 0;
  let cur = "";
  let active = false;
  const push = () => {
    if (active) {
      tokens.push({ type: "word", value: cur });
      cur = "";
      active = false;
    }
  };
  while (i < n) {
    const c = cmd[i]!;
    if (c === "&" && cmd[i + 1] === "&") {
      push();
      tokens.push({ type: "sep" });
      i += 2;
      continue;
    }
    if (c === "|" && cmd[i + 1] === "|") {
      push();
      tokens.push({ type: "sep" });
      i += 2;
      continue;
    }
    if (c === "|" || c === ";" || c === "\n") {
      push();
      tokens.push({ type: "sep" });
      i += 1;
      continue;
    }
    if (c === " " || c === "\t") {
      push();
      i += 1;
      continue;
    }
    if (c === "'") {
      active = true;
      i += 1;
      while (i < n && cmd[i] !== "'") {
        cur += cmd[i];
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '"') {
      active = true;
      i += 1;
      while (i < n && cmd[i] !== '"') {
        if (cmd[i] === "\\" && i + 1 < n) {
          cur += cmd[i + 1];
          i += 2;
          continue;
        }
        cur += cmd[i];
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === "\\" && i + 1 < n) {
      active = true;
      cur += cmd[i + 1];
      i += 2;
      continue;
    }
    // Heredoc: consume the operator and delimiter as an opaque token, then
    // skip the body lines verbatim so they can't be mistaken for separators
    // or further gh invocations. The body text is still scanned for
    // references since that happens on the raw command string separately.
    if (c === "<" && cmd[i + 1] === "<") {
      push();
      i += 2;
      let strip = false;
      if (cmd[i] === "-") {
        strip = true;
        i += 1;
      }
      while (cmd[i] === " " || cmd[i] === "\t") i += 1;
      let quote = "";
      if (cmd[i] === "'" || cmd[i] === '"') {
        quote = cmd[i]!;
        i += 1;
      }
      let delim = "";
      while (i < n && /[A-Za-z0-9_]/.test(cmd[i]!)) {
        delim += cmd[i];
        i += 1;
      }
      if (quote && cmd[i] === quote) i += 1;
      tokens.push({ type: "word", value: `<<${delim}` });
      while (i < n && cmd[i] !== "\n") i += 1;
      if (i < n) i += 1;
      while (i < n) {
        const lineEnd = cmd.indexOf("\n", i);
        const end = lineEnd === -1 ? n : lineEnd;
        const line = cmd.slice(i, end);
        const compare = strip ? line.replace(/^\t+/, "") : line;
        i = lineEnd === -1 ? n : lineEnd + 1;
        if (compare === delim) break;
      }
      continue;
    }
    active = true;
    cur += c;
    i += 1;
  }
  push();
  return tokens;
}

function groupStatements(tokens: Token[]): string[][] {
  const result: string[][] = [];
  let cur: string[] = [];
  for (const t of tokens) {
    if (t.type === "sep") {
      if (cur.length) result.push(cur);
      cur = [];
    } else {
      cur.push(t.value);
    }
  }
  if (cur.length) result.push(cur);
  return result;
}

function stripEnvAssignments(statement: string[]): string[] {
  let i = 0;
  while (i < statement.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(statement[i]!)) i += 1;
  return statement.slice(i);
}

// Flags that consume the following token as a value. Used to avoid treating
// a flag's value (e.g. a URL inside --body text) as a positional target.
const VALUE_FLAGS = new Set([
  "-R",
  "--repo",
  "-b",
  "--body",
  "--body-file",
  "-t",
  "--title",
  "-F",
  "--field",
  "-f",
  "--raw-field",
  "--input",
  "-X",
  "--method",
  "--base",
  "--head",
  "-m",
  "--message",
  "--notes",
  "--notes-file",
  "-a",
  "--assignee",
  "-l",
  "--label",
  "-r",
  "--reviewer",
  "--milestone",
  "--tag",
  "--target",
  "-H",
  "--header",
  "-q",
  "--jq",
  "--hostname",
]);

function isFlagValueToken(args: string[], i: number): boolean {
  return i > 0 && VALUE_FLAGS.has(args[i - 1]!);
}

function extractFlagValue(args: string[], names: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const name of names) {
      if (a === name) return args[i + 1] ?? null;
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
    }
  }
  return null;
}

function extractFlagValues(args: string[], names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const name of names) {
      if (a === name) {
        if (args[i + 1] !== undefined) out.push(args[i + 1]!);
      } else if (a.startsWith(`${name}=`)) {
        out.push(a.slice(name.length + 1));
      }
    }
  }
  return out;
}

function normalizeOwnerRepo(raw: string): string | null {
  let v = raw.trim();
  if (!v) return null;
  v = v
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\.git$/i, "");
  const parts = v.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const repo = parts[parts.length - 1]!;
  const owner = parts[parts.length - 2]!;
  return `${owner}/${repo}`.toLowerCase();
}

function extractDashR(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-R" || a === "--repo") return normalizeOwnerRepo(args[i + 1] ?? "");
    if (a.startsWith("--repo=")) return normalizeOwnerRepo(a.slice(7));
  }
  return null;
}

function extractUrlTarget(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (isFlagValueToken(args, i)) continue;
    const a = args[i]!;
    if (a.startsWith("-")) continue;
    const m = /github\.com\/([A-Za-z0-9][-A-Za-z0-9._]*)\/([A-Za-z0-9][-A-Za-z0-9._]*)/i.exec(a);
    if (m) return `${m[1]}/${m[2]}`.replace(/\.git$/i, "").toLowerCase();
  }
  return null;
}

function extractApiPathTarget(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    if (isFlagValueToken(args, i)) continue;
    const a = args[i]!;
    if (a.startsWith("-")) continue;
    const m = /^\/?repos\/([A-Za-z0-9][-A-Za-z0-9._]*)\/([A-Za-z0-9][-A-Za-z0-9._]*)/i.exec(a);
    if (m) return `${m[1]}/${m[2]}`.toLowerCase();
  }
  return null;
}

/** Statement classification: whether it's a write-ish gh call worth scanning, and whether it's a graphql mutation (target unknowable from the call itself). */
function classify(rawCommand: string, args: string[]): { relevant: boolean; graphqlMutation: boolean } {
  const verb0 = (args[0] ?? "").toLowerCase();
  const verb1 = (args[1] ?? "").toLowerCase();

  if ((verb0 === "issue" || verb0 === "pr") && ["create", "comment", "edit", "review", "merge"].includes(verb1)) {
    return { relevant: true, graphqlMutation: false };
  }
  if (verb0 === "release" && ["create", "edit"].includes(verb1)) {
    return { relevant: true, graphqlMutation: false };
  }
  if (verb0 === "api") {
    if (verb1 === "graphql") {
      const isMutation = /\bmutation\b/i.test(rawCommand);
      return { relevant: isMutation, graphqlMutation: isMutation };
    }
    const method = extractFlagValue(args, ["-X", "--method"]);
    const hasBodyFlag = args.some((a) => ["-f", "--field", "-F", "--raw-field", "--input"].includes(a));
    if (method) return { relevant: ["POST", "PUT", "PATCH"].includes(method.toUpperCase()), graphqlMutation: false };
    return { relevant: hasBodyFlag, graphqlMutation: false };
  }
  return { relevant: false, graphqlMutation: false };
}

function collectFileTexts(args: string[], cwd: string, readFile: (path: string) => string | null): string[] {
  const texts: string[] = [];
  for (const f of extractFlagValues(args, ["--body-file", "--notes-file"])) {
    if (f === "-") continue; // stdin can't be read here
    const content = readFile(resolvePath(cwd, f));
    if (content) texts.push(content);
  }
  for (const kv of extractFlagValues(args, ["-f", "--field", "-F", "--raw-field"])) {
    const m = /^[^=]+=@(.+)$/.exec(kv);
    if (!m) continue;
    const content = readFile(resolvePath(cwd, m[1]!));
    if (content) texts.push(content);
  }
  for (const f of extractFlagValues(args, ["--input"])) {
    if (f === "-") continue;
    const content = readFile(resolvePath(cwd, f));
    if (content) texts.push(content);
  }
  return texts;
}

// github.com paths that are never a repo (so `owner/repo` parsing on them is meaningless).
const RESERVED_GH_PATHS = new Set(["orgs", "settings", "apps", "marketplace", "sponsors", "features", "topics", "login"]);

function addRef(map: Map<string, string>, owner: string, repo: string) {
  const cleanRepo = repo.replace(/\.git$/i, "");
  if (!owner || !cleanRepo) return;
  if (RESERVED_GH_PATHS.has(owner.toLowerCase())) return;
  const key = `${owner}/${cleanRepo}`.toLowerCase();
  if (!map.has(key)) map.set(key, `${owner}/${cleanRepo}`);
}

/** Finds `owner/repo#N` and github.com/owner/repo links in free text. Exported for direct testing. */
export function extractReferences(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const hashRe = /\b([A-Za-z0-9][-A-Za-z0-9._]*)\/([A-Za-z0-9][-A-Za-z0-9._]*)#\d+/g;
  let m: RegExpExecArray | null;
  while ((m = hashRe.exec(text))) addRef(map, m[1]!, m[2]!);
  const urlRe = /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9][-A-Za-z0-9._]*)\/([A-Za-z0-9][-A-Za-z0-9._]*)/gi;
  while ((m = urlRe.exec(text))) addRef(map, m[1]!, m[2]!);
  return map;
}

function effectiveCwd(command: string, hookCwd: string): string {
  const m = /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&/.exec(command);
  if (!m) return hookCwd;
  let dir = m[1]!;
  if ((dir.startsWith('"') && dir.endsWith('"')) || (dir.startsWith("'") && dir.endsWith("'"))) dir = dir.slice(1, -1);
  return resolvePath(hookCwd, dir);
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultGetRemoteUrl(cwd: string): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", cwd, "remote", "get-url", "origin"]);
    if (r.exitCode !== 0) return null;
    return r.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

function originOwnerRepo(cwd: string, getRemoteUrl: (cwd: string) => string | null): string | null {
  const url = getRemoteUrl(cwd);
  if (!url) return null;
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(url.trim());
  if (!m) return null;
  return `${m[1]}/${m[2]}`.toLowerCase();
}

function defaultCachePath(): string {
  return join(process.env.HOME ?? homedir(), ".cache", "atlas", "gh-visibility.json");
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry {
  result: VisibilityResult;
  ts: number;
}

function loadCache(path: string): Record<string, CacheEntry> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveCache(path: string, cache: Record<string, CacheEntry>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache));
  } catch {
    // Best effort — a cache write failure must not break the guard.
  }
}

async function ghApiLookup(repo: string): Promise<VisibilityResult> {
  const proc = Bun.spawn(["gh", "api", `repos/${repo}`, "--jq", ".private"], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 5000);
  try {
    const [exitCode, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (exitCode !== 0) {
      if (/404|not found/i.test(err)) return "not-found";
      throw new Error(`gh api lookup failed for ${repo}: ${err.trim() || `exit ${exitCode}`}`);
    }
    const trimmed = out.trim();
    if (trimmed === "true") return "private";
    if (trimmed === "false") return "public";
    throw new Error(`unexpected gh api output for ${repo}: ${trimmed}`);
  } finally {
    clearTimeout(timer);
  }
}

function cachedLookup(base: VisibilityLookup, cachePath: string): VisibilityLookup {
  return async (repo: string) => {
    const key = repo.toLowerCase();
    const cache = loadCache(cachePath);
    const entry = cache[key];
    const now = Date.now();
    if (entry && now - entry.ts < CACHE_TTL_MS) return entry.result;
    const result = await base(repo);
    cache[key] = { result, ts: now };
    saveCache(cachePath, cache);
    return result;
  };
}

/** Reads a static JSON map of repo -> visibility (or "error") from GH_REF_GUARD_FIXTURE, for hermetic end-to-end tests of the CLI/wrapper. */
export function fixtureLookup(path: string): VisibilityLookup {
  let data: Record<string, VisibilityResult | "error"> = {};
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Corrupt or missing fixture → every lookup below will "error" (fail open).
  }
  return async (repo: string) => {
    const v = data[repo.toLowerCase()];
    if (v === undefined || v === "error") throw new Error(`no fixture visibility for ${repo}`);
    return v;
  };
}

function defaultLookup(cachePath: string): VisibilityLookup {
  const fixture = process.env.GH_REF_GUARD_FIXTURE;
  if (fixture) return fixtureLookup(fixture);
  return cachedLookup(ghApiLookup, cachePath);
}

function blockMessage(offending: string[]): string {
  return (
    `Blocked: this command would post a reference to a private (or inaccessible) repo into a public repo: ${offending.join(", ")}. ` +
    `Drop the reference, or describe it generically ("tracked internally") instead of pasting a private repo's link, issue/PR number, or name into a public issue, PR, comment, review, or release. ` +
    "If the referenced repo is actually public, prefix the command with GH_REF_GUARD_OK=1 to override."
  );
}

/** Evaluates a shell command against the private-reference policy. Returns a block reason, or null to allow. */
export async function evaluateGhCommand(command: string, opts: GuardOptions = {}): Promise<string | null> {
  if (/^\s*GH_REF_GUARD_OK=1\s/.test(command)) return null;
  if (!/\bgh\b/.test(command)) return null; // fast path: no network, no parsing

  const hookCwd = opts.cwd ?? process.cwd();
  const readFile = opts.readFile ?? defaultReadFile;
  const getRemoteUrl = opts.getRemoteUrl ?? defaultGetRemoteUrl;
  const lookup = opts.lookup ?? defaultLookup(opts.cachePath ?? defaultCachePath());

  try {
    const statements = groupStatements(tokenize(command)).map(stripEnvAssignments);
    const invocations = statements.filter((s) => (s[0] ?? "").toLowerCase() === "gh").map((s) => s.slice(1));

    const relevant = invocations.map((args) => ({ args, ...classify(command, args) })).filter((r) => r.relevant);
    if (relevant.length === 0) return null;

    const cwd = effectiveCwd(command, hookCwd);

    const fileTexts = relevant.flatMap((r) => collectFileTexts(r.args, cwd, readFile));
    const scanText = [command, ...fileTexts].join("\n");
    const refs = extractReferences(scanText);

    const targets = relevant.map((r) => ({
      args: r.args,
      target: r.graphqlMutation
        ? null
        : extractDashR(r.args) ?? extractUrlTarget(r.args) ?? extractApiPathTarget(r.args) ?? originOwnerRepo(cwd, getRemoteUrl),
    }));

    const uniqueTargets = [...new Set(targets.map((t) => t.target).filter((t): t is string => !!t))];
    const uniqueRefs = [...refs.keys()];

    const resolved = new Map<string, Promise<VisibilityResult>>();
    const resolveOnce = (repo: string) => {
      const key = repo.toLowerCase();
      let p = resolved.get(key);
      if (!p) {
        p = lookup(repo);
        resolved.set(key, p);
      }
      return p;
    };

    const [targetEntries, refEntries] = await Promise.all([
      Promise.all(uniqueTargets.map(async (t) => [t, await resolveOnce(t)] as const)),
      Promise.all(uniqueRefs.map(async (r) => [r, await resolveOnce(r)] as const)),
    ]);
    const targetVisibility = new Map(targetEntries);
    const refVisibility = new Map(refEntries);

    const offending = new Set<string>();
    for (const { target } of targets) {
      // A target we can't resolve, or that resolves to private/inaccessible,
      // never leaks anything — only a public (or unresolvable) target does.
      if (target && targetVisibility.get(target) !== "public") continue;
      for (const ref of uniqueRefs) {
        if (ref === target) continue;
        if (refVisibility.get(ref) !== "public") offending.add(ref);
      }
    }

    if (offending.size === 0) return null;
    return blockMessage([...offending].map((key) => refs.get(key) ?? key));
  } catch (err) {
    console.error(`gh-reference-guard: ${err instanceof Error ? err.message : String(err)} — allowing`);
    return null;
  }
}

if (import.meta.main) {
  const [command = "", cwd = process.cwd()] = process.argv.slice(2);
  try {
    const reason = await evaluateGhCommand(command, { cwd });
    if (reason) {
      process.stdout.write(`${reason}\n`);
      process.exit(2);
    }
    process.exit(0);
  } catch (err) {
    console.error(`gh-reference-guard: unexpected error, allowing: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  }
}
