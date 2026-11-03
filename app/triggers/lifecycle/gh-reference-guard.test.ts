import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateGhCommand, extractReferences, type VisibilityLookup, type VisibilityResult } from "./gh-reference-guard.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "atlas-gh-ref-guard-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Builds a lookup from a fixed map; throws (simulating a real error) for any repo not listed, unless `errors` lists it explicitly. */
function stubLookup(map: Record<string, VisibilityResult>, calls?: string[]): VisibilityLookup {
  return async (repo: string) => {
    calls?.push(repo.toLowerCase());
    const v = map[repo.toLowerCase()];
    if (v === undefined) throw new Error(`no stub visibility for ${repo}`);
    return v;
  };
}

function noFile(): string | null {
  return null;
}

describe("evaluateGhCommand", () => {
  test("fast path: ignores non-gh commands without any lookup", async () => {
    const calls: string[] = [];
    const lookup = stubLookup({}, calls);
    const result = await evaluateGhCommand("git status && echo done", { lookup, readFile: noFile });
    expect(result).toBeNull();
    expect(calls).toEqual([]);
  });

  test("blocks a private repo reference in --body", async () => {
    const lookup = stubLookup({ "pub/repo": "public", "acme/priv": "private" });
    const result = await evaluateGhCommand('gh issue comment 5 -R pub/repo --body "see acme/priv#12"', { lookup, readFile: noFile });
    expect(result).toContain("acme/priv");
  });

  test("blocks a private repo referenced via a github.com URL", async () => {
    const lookup = stubLookup({ "pub/repo": "public", "acme/priv": "private" });
    const result = await evaluateGhCommand('gh issue comment 5 -R pub/repo --body "see https://github.com/acme/priv/issues/12 for context"', {
      lookup,
      readFile: noFile,
    });
    expect(result).toContain("acme/priv");
  });

  test("blocks a private reference pulled from a --body-file", async () => {
    const lookup = stubLookup({ "pub/repo": "public", "acme/priv": "private" });
    const readFile = (path: string) => (path.endsWith("body.txt") ? "see acme/priv#9" : null);
    const result = await evaluateGhCommand("gh issue comment 5 -R pub/repo --body-file body.txt", { lookup, readFile, cwd: root });
    expect(result).toContain("acme/priv");
  });

  test("blocks a private reference inside a heredoc body", async () => {
    const lookup = stubLookup({ "pub/repo": "public", "acme/priv": "private" });
    const cmd = ["gh issue comment 5 -R pub/repo --body \"$(cat <<'EOF'", "see acme/priv#3 for background", "EOF", ')"'].join("\n");
    const result = await evaluateGhCommand(cmd, { lookup, readFile: noFile });
    expect(result).toContain("acme/priv");
  });

  test("allows when the target repo itself is private, even with a private reference in the body", async () => {
    const lookup = stubLookup({ "acme/priv": "private", "other/secret": "private" });
    const result = await evaluateGhCommand('gh issue comment 5 -R acme/priv --body "see other/secret#1"', { lookup, readFile: noFile });
    expect(result).toBeNull();
  });

  test("allows a reference to another public repo", async () => {
    const lookup = stubLookup({ "pub/repo": "public", "pub/other": "public" });
    const result = await evaluateGhCommand('gh issue comment 5 -R pub/repo --body "see pub/other#2"', { lookup, readFile: noFile });
    expect(result).toBeNull();
  });

  test("allows a same-repo issue number, bare or fully qualified", async () => {
    const lookup = stubLookup({ "pub/repo": "public" });
    const result = await evaluateGhCommand('gh issue comment 5 -R pub/repo --body "see #12 or pub/repo#12"', { lookup, readFile: noFile });
    expect(result).toBeNull();
  });

  test("blocks gh api writes (-f) that reference a private repo", async () => {
    const lookup = stubLookup({ "pub/r": "public", "acme/priv": "private" });
    const result = await evaluateGhCommand('gh api repos/pub/r/issues/1/comments -f "body=see acme/priv#1"', { lookup, readFile: noFile });
    expect(result).toContain("acme/priv");
  });

  test("allows a gh api GET without touching the lookup", async () => {
    const calls: string[] = [];
    const lookup = stubLookup({ "pub/r": "public" }, calls);
    const result = await evaluateGhCommand("gh api repos/pub/r", { lookup, readFile: noFile });
    expect(result).toBeNull();
    expect(calls).toEqual([]);
  });

  test("resolves the target from the origin remote of the effective cwd when no -R is given", () => {
    mkdirSync(join(root, "repo"));
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", join(root, "repo"), ...args]);
    git("init", "-q");
    git("remote", "add", "origin", "git@github.com:pub/repo.git");
    return (async () => {
      const lookup = stubLookup({ "pub/repo": "public", "acme/priv": "private" });
      const result = await evaluateGhCommand('gh issue comment 5 --body "see acme/priv#1"', { lookup, readFile: noFile, cwd: join(root, "repo") });
      expect(result).toContain("acme/priv");

      const lookupPublicOnly = stubLookup({ "pub/repo": "public", "pub/other": "public" });
      const allowed = await evaluateGhCommand('gh issue comment 5 --body "see pub/other#1"', {
        lookup: lookupPublicOnly,
        readFile: noFile,
        cwd: join(root, "repo"),
      });
      expect(allowed).toBeNull();
    })();
  });

  test("honors a leading cd when resolving the effective cwd", async () => {
    mkdirSync(join(root, "sub"), { recursive: true });
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", join(root, "sub"), ...args]);
    git("init", "-q");
    git("remote", "add", "origin", "https://github.com/pub/repo.git");
    const lookup = stubLookup({ "pub/repo": "public", "acme/priv": "private" });
    const result = await evaluateGhCommand(`cd ${join(root, "sub")} && gh issue comment 5 --body "see acme/priv#1"`, {
      lookup,
      readFile: noFile,
      cwd: root,
    });
    expect(result).toContain("acme/priv");
  });

  test("the GH_REF_GUARD_OK=1 override allows the command without any lookup", async () => {
    const calls: string[] = [];
    const lookup = stubLookup({}, calls);
    const result = await evaluateGhCommand('GH_REF_GUARD_OK=1 gh issue comment 5 -R pub/repo --body "see acme/priv#1"', {
      lookup,
      readFile: noFile,
    });
    expect(result).toBeNull();
    expect(calls).toEqual([]);
  });

  test("fails open when the target's visibility lookup errors", async () => {
    const lookup: VisibilityLookup = async (repo) => {
      if (repo.toLowerCase() === "pub/repo") throw new Error("network error");
      return "private";
    };
    const result = await evaluateGhCommand('gh issue comment 5 -R pub/repo --body "see acme/priv#1"', { lookup, readFile: noFile });
    expect(result).toBeNull();
  });

  test("blocks when a referenced repo 404s (treated as not public)", async () => {
    const lookup = stubLookup({ "pub/repo": "public", "acme/priv": "not-found" });
    const result = await evaluateGhCommand('gh issue comment 5 -R pub/repo --body "see acme/priv#1"', { lookup, readFile: noFile });
    expect(result).toContain("acme/priv");
  });

  test("allows when the target 404s (treated as not public, same bucket as private)", async () => {
    const lookup = stubLookup({ "pub/repo": "not-found", "acme/priv": "private" });
    const result = await evaluateGhCommand('gh issue comment 5 -R pub/repo --body "see acme/priv#1"', { lookup, readFile: noFile });
    expect(result).toBeNull();
  });

  test("a graphql mutation is checked even without a resolvable target", async () => {
    const lookup = stubLookup({ "acme/priv": "private" });
    const result = await evaluateGhCommand("gh api graphql -f query='mutation { addComment(body: \"see acme/priv#1\") }'", {
      lookup,
      readFile: noFile,
    });
    expect(result).toContain("acme/priv");
  });

  test("a non-mutation graphql query is not checked", async () => {
    const calls: string[] = [];
    const lookup = stubLookup({}, calls);
    const result = await evaluateGhCommand("gh api graphql -f query='query { viewer { login } }'", { lookup, readFile: noFile });
    expect(result).toBeNull();
    expect(calls).toEqual([]);
  });

  test("does not crash on garbage input, fails open", async () => {
    const lookup = stubLookup({ "pub/repo": "public" });
    const result = await evaluateGhCommand('gh issue comment -R pub/repo --body "unterminated \\" quote', { lookup, readFile: noFile });
    expect(result).toBeNull();
  });
});

describe("extractReferences", () => {
  test("matches owner/repo#N and github.com links, ignoring reserved paths and the bare #N form", () => {
    const refs = extractReferences("see acme/priv#1 and https://github.com/acme/other/pull/2, but not #3 or github.com/settings/profile");
    expect([...refs.keys()].sort()).toEqual(["acme/other", "acme/priv"]);
  });

  test("dedupes repeated references", () => {
    const refs = extractReferences("acme/priv#1 again in acme/priv#2 and https://github.com/acme/priv/issues/3");
    expect([...refs.keys()]).toEqual(["acme/priv"]);
  });
});

describe("Claude wrapper (gh-reference-guard.sh)", () => {
  const hooksDir = join(import.meta.dir, "..", "harness", "claude", "hooks");

  function run(stdin: string, env: Record<string, string> = {}) {
    const proc = Bun.spawnSync(["bash", join(hooksDir, "gh-reference-guard.sh")], {
      env: { PATH: process.env.PATH!, ...env },
      stdin: new TextEncoder().encode(stdin),
    });
    return { code: proc.exitCode, out: proc.stdout.toString().trim() };
  }

  function fixture(map: Record<string, string>): string {
    const path = join(root, "fixture.json");
    writeFileSync(path, JSON.stringify(map));
    return path;
  }

  test("emits a deny decision for a blocked command", () => {
    const fixturePath = fixture({ "pub/repo": "public", "acme/priv": "private" });
    const stdin = JSON.stringify({ tool_input: { command: 'gh issue comment 5 -R pub/repo --body "see acme/priv#1"' }, cwd: root });
    const r = run(stdin, { GH_REF_GUARD_FIXTURE: fixturePath });
    expect(r.code).toBe(0);
    const decision = JSON.parse(r.out);
    expect(decision.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("acme/priv");
  });

  test("stays silent for an allowed command", () => {
    const fixturePath = fixture({ "pub/repo": "public" });
    const stdin = JSON.stringify({ tool_input: { command: 'gh issue comment 5 -R pub/repo --body "all good"' }, cwd: root });
    expect(run(stdin, { GH_REF_GUARD_FIXTURE: fixturePath })).toEqual({ code: 0, out: "" });
  });

  test("stays silent for a non-gh command", () => {
    expect(run(JSON.stringify({ tool_input: { command: "git status" }, cwd: root }))).toEqual({ code: 0, out: "" });
  });

  test("fails open when stdin isn't valid JSON", () => {
    expect(run("not json")).toEqual({ code: 0, out: "" });
  });
});
