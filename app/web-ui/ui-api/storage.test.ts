/**
 * /ui/api/storage/* against a throwaway HOME (no DB needed).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { resolveHomePath } from "./storage/browse";
import { resetWorkspaceCacheForTests } from "./storage/workspace";
import { HttpError } from "./shared/http";
import { routes, type BrowseDir, type BrowseFile, type VolumesResponse, type WorkspaceResponse } from "./storage";

const prevHome = process.env.HOME;
let HOME: string;
let server: ReturnType<typeof Bun.serve>;

const url = (p: string) => new URL(p, server.url);
const get = (p: string) => fetch(url(p));

function write(rel: string, content: string | Buffer) {
  const abs = join(HOME, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), "atlas-storage-test-"));
  process.env.HOME = HOME;
  server = Bun.serve({ port: 0, routes: routes as any, fetch: () => new Response("unmatched", { status: 418 }) });
});

afterAll(() => {
  server.stop(true);
  process.env.HOME = prevHome;
  rmSync(HOME, { recursive: true, force: true });
});

afterEach(() => resetWorkspaceCacheForTests());

// ---------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------

describe("GET /ui/api/storage/volumes", () => {
  test("reports the workspace filesystem with sane capacity numbers", async () => {
    const res = await get("/ui/api/storage/volumes");
    expect(res.status).toBe(200);
    const d = (await res.json()) as VolumesResponse;
    expect(d.volumes.length).toBeGreaterThan(0);
    const withWorkspace = d.volumes.find((v) => v.roles.some((r) => r.key === "workspace"));
    expect(withWorkspace).toBeTruthy();
    expect(withWorkspace!.roles.find((r) => r.key === "workspace")!.path).toBe(HOME);
    for (const v of d.volumes) {
      expect(v.totalBytes).toBeGreaterThan(0);
      expect(v.usedBytes).toBeGreaterThanOrEqual(0);
      expect(v.freeBytes).toBeGreaterThanOrEqual(0);
      expect(v.usedPercent).toBeGreaterThanOrEqual(0);
      expect(v.usedPercent).toBeLessThanOrEqual(100.5); // reserved blocks can push slightly over 100 on some filesystems
      const expectedStatus = v.usedPercent >= 90 ? "error" : v.usedPercent >= 80 ? "warn" : "ok";
      expect(v.status).toBe(expectedStatus);
      // /tmp, HOME (under tmpdir) and often / share one filesystem in dev/test — every role must be unique across volumes.
      for (const role of v.roles) expect(["workspace", "logs", "tmp", "root"]).toContain(role.key);
    }
    const allRoleKeys = d.volumes.flatMap((v) => v.roles.map((r) => r.key));
    expect(new Set(allRoleKeys).size).toBe(allRoleKeys.length); // deduplicated: each logical path appears once
  });
});

// ---------------------------------------------------------------------------
// Workspace breakdown
// ---------------------------------------------------------------------------

describe("GET /ui/api/storage/workspace", () => {
  beforeEach(() => {
    for (const d of ["memory", "projects", ".claude", ".index", "secrets"]) rmSync(join(HOME, d), { recursive: true, force: true });
    write("memory/MEMORY.md", "# Memory\n");
    write("memory/entities/jonas.md", "jonas\n");
    write("IDENTITY.md", "identity\n");
    write(".claude/projects/-home-agent/abc-123.jsonl", "x".repeat(500));
    write(".claude/settings.json", "{}");
  });

  test("breaks HOME down per top-level entry, splitting .claude/projects from the rest of .claude", async () => {
    const d = (await (await get("/ui/api/storage/workspace")).json()) as WorkspaceResponse;
    expect(d.truncated).toBe(false);
    expect(d.computedAt).toMatch(/T.*Z$/);

    const byKey = new Map(d.entries.map((e) => [e.key, e]));
    const memory = byKey.get("memory")!;
    expect(memory.kind).toBe("dir");
    expect(memory.fileCount).toBe(2);
    expect(memory.sizeBytes).toBe("# Memory\n".length + "jonas\n".length);
    expect(memory.label).toBe("Long-term memory");

    const identity = byKey.get("IDENTITY.md")!;
    expect(identity.kind).toBe("file");
    expect(identity.fileCount).toBe(1);
    expect(identity.sizeBytes).toBe("identity\n".length);

    const projects = byKey.get(".claude/projects")!;
    expect(projects.sizeBytes).toBe(500);
    expect(projects.fileCount).toBe(1);
    expect(projects.label).toContain("session transcripts");

    const claudeRest = byKey.get(".claude")!;
    expect(claudeRest.sizeBytes).toBe("{}".length);
    expect(claudeRest.fileCount).toBe(1);

    expect(d.totalSizeBytes).toBeGreaterThanOrEqual(memory.sizeBytes + identity.sizeBytes + projects.sizeBytes + claudeRest.sizeBytes);
  });

  test("lists the largest files, biggest first", async () => {
    write("projects/big.txt", "b".repeat(10_000));
    const d = (await (await get("/ui/api/storage/workspace?refresh=1")).json()) as WorkspaceResponse;
    expect(d.largestFiles[0]!.path).toBe("projects/big.txt");
    expect(d.largestFiles[0]!.sizeBytes).toBe(10_000);
    for (let i = 1; i < d.largestFiles.length; i++) expect(d.largestFiles[i - 1]!.sizeBytes).toBeGreaterThanOrEqual(d.largestFiles[i]!.sizeBytes);
  });

  test("reports SQLite DB size including -wal/-shm", async () => {
    write(".index/atlas.db", "d".repeat(300));
    write(".index/atlas.db-wal", "w".repeat(50));
    write(".index/atlas.db-shm", "s".repeat(20));
    const d = (await (await get("/ui/api/storage/workspace?refresh=1")).json()) as WorkspaceResponse;
    expect(d.database).toEqual({ path: "~/.index/atlas.db", sizeBytes: 300, walSizeBytes: 50, shmSizeBytes: 20, totalSizeBytes: 370 });
  });

  test("database is null when there is no DB yet", async () => {
    const d = (await (await get("/ui/api/storage/workspace?refresh=1")).json()) as WorkspaceResponse;
    expect(d.database).toBeNull();
  });

  test("symlinks are never followed or counted", async () => {
    write("projects/real.txt", "x".repeat(5000));
    symlinkSync(join(HOME, "projects/real.txt"), join(HOME, "projects/link.txt"));
    const d = (await (await get("/ui/api/storage/workspace?refresh=1")).json()) as WorkspaceResponse;
    const projects = d.entries.find((e) => e.key === "projects")!;
    expect(projects.fileCount).toBe(1); // real.txt only
    expect(d.largestFiles.some((f) => f.path === "projects/link.txt")).toBe(false);
  });

  test("caches for repeated requests; ?refresh=1 recomputes", async () => {
    const first = (await (await get("/ui/api/storage/workspace")).json()) as WorkspaceResponse;
    write("projects/new-file.txt", "z".repeat(999));
    const cached = (await (await get("/ui/api/storage/workspace")).json()) as WorkspaceResponse;
    expect(cached.computedAt).toBe(first.computedAt);
    expect(cached.totalSizeBytes).toBe(first.totalSizeBytes); // new file not yet reflected
    const refreshed = (await (await get("/ui/api/storage/workspace?refresh=1")).json()) as WorkspaceResponse;
    expect(refreshed.totalSizeBytes).toBe(first.totalSizeBytes + 999);
  });
});

// ---------------------------------------------------------------------------
// Browse: listing
// ---------------------------------------------------------------------------

describe("GET /ui/api/storage/browse (listing)", () => {
  beforeEach(() => {
    rmSync(join(HOME, "memory"), { recursive: true, force: true });
    write("memory/MEMORY.md", "# Memory\n");
    write("memory/.hidden-file.md", "shh\n");
    write("secrets/token", "top-secret\n");
  });

  test("lists the root of HOME, directories first, hidden entries marked but shown", async () => {
    const d = (await (await get("/ui/api/storage/browse")).json()) as BrowseDir;
    expect(d.type).toBe("dir");
    expect(d.path).toBe("");
    const memory = d.entries.find((e) => e.name === "memory")!;
    expect(memory.kind).toBe("dir");
    // The secrets directory itself is flagged too (shown, just as a hint); browsing into it is still allowed.
    const secrets = d.entries.find((e) => e.name === "secrets")!;
    expect(secrets.secret).toBe(true);
    const dirs = d.entries.filter((e) => e.kind === "dir");
    const firstFileIndex = d.entries.findIndex((e) => e.kind === "file");
    if (firstFileIndex !== -1) expect(d.entries.slice(0, dirs.length).every((e) => e.kind === "dir")).toBe(true);
  });

  test("lists a nested directory and flags hidden files", async () => {
    const d = (await (await get("/ui/api/storage/browse/memory")).json()) as BrowseDir;
    const hidden = d.entries.find((e) => e.name === ".hidden-file.md")!;
    expect(hidden.hidden).toBe(true);
    expect(hidden.path).toBe("memory/.hidden-file.md");
    const visible = d.entries.find((e) => e.name === "MEMORY.md")!;
    expect(visible.hidden).toBe(false);
  });

  test("listing shows secret file names and sizes", async () => {
    const d = (await (await get("/ui/api/storage/browse/secrets")).json()) as BrowseDir;
    const token = d.entries.find((e) => e.name === "token")!;
    expect(token.secret).toBe(true);
    expect(token.sizeBytes).toBe("top-secret\n".length);
  });

  test("missing directory is 404", async () => {
    expect((await get("/ui/api/storage/browse/does-not-exist")).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Browse: file preview
// ---------------------------------------------------------------------------

describe("GET /ui/api/storage/browse/* (file preview)", () => {
  beforeEach(() => {
    for (const d of ["memory", "secrets", ".ssh", ".claude"]) rmSync(join(HOME, d), { recursive: true, force: true });
    for (const f of [".env", "id_rsa.pem", "api.key", "app.credentials.json", "config.yml"]) rmSync(join(HOME, f), { force: true });
  });

  test("previews a small text file in full", async () => {
    write("notes.txt", "hello world\n");
    const f = (await (await get("/ui/api/storage/browse/notes.txt")).json()) as BrowseFile;
    expect(f.type).toBe("file");
    expect(f.content).toBe("hello world\n");
    expect(f.denied).toBe(false);
    expect(f.binary).toBe(false);
    expect(f.tooLarge).toBe(false);
  });

  test("denies content for HOME/secrets/**", async () => {
    write("secrets/github-token", "ghp_supersecret\n");
    const f = (await (await get("/ui/api/storage/browse/secrets/github-token")).json()) as BrowseFile;
    expect(f.denied).toBe(true);
    expect(f.content).toBeNull();
  });

  test.each([".ssh/id_rsa", ".claude/.credentials.json", "id_rsa.pem", "api.key", ".env", ".env.local", "app.credentials.json"])(
    "denies content for %s",
    async (rel) => {
      write(rel, "secret-value\n");
      const f = (await (await get(`/ui/api/storage/browse/${rel.split("/").map(encodeURIComponent).join("/")}`)).json()) as BrowseFile;
      expect(f.denied).toBe(true);
      expect(f.content).toBeNull();
    },
  );

  test("config.yml is masked, not denied", async () => {
    write("config.yml", "telegram:\n  bot_token: \"123:abc\"\nsignal:\n  number: \"+491700000000\"\n");
    const f = (await (await get("/ui/api/storage/browse/config.yml")).json()) as BrowseFile;
    expect(f.denied).toBe(false);
    expect(f.masked).toBe(true);
    expect(f.content).not.toContain("123:abc");
    expect(f.content).toContain("+491700000000");
  });

  test("flags binary content and offers no preview", async () => {
    write("blob.bin", Buffer.from([0, 1, 2, 3, 255, 0]));
    const f = (await (await get("/ui/api/storage/browse/blob.bin")).json()) as BrowseFile;
    expect(f.binary).toBe(true);
    expect(f.content).toBeNull();
    expect(f.denied).toBe(false);
  });

  test("large non-log text file has no preview", async () => {
    write("huge.txt", "a".repeat(300_000));
    const f = (await (await get("/ui/api/storage/browse/huge.txt")).json()) as BrowseFile;
    expect(f.tooLarge).toBe(true);
    expect(f.content).toBeNull();
  });

  test("large .log file shows the tail instead of being denied", async () => {
    const head = "HEAD-MARKER\n" + "x".repeat(300_000);
    const tail = "y".repeat(1000) + "\nTAIL-MARKER\n";
    write("app.log", head + tail);
    const f = (await (await get("/ui/api/storage/browse/app.log")).json()) as BrowseFile;
    expect(f.tail).toBe(true);
    expect(f.tooLarge).toBe(false);
    expect(f.content).toContain("TAIL-MARKER");
    expect(f.content).not.toContain("HEAD-MARKER");
  });

  test("links to the better view for memory files and session transcripts", async () => {
    write("memory/entities/jonas.md", "jonas\n");
    write(".claude/projects/-home-agent/sess-42.jsonl", "{}\n");
    const memoryFile = (await (await get("/ui/api/storage/browse/memory/entities/jonas.md")).json()) as BrowseFile;
    expect(memoryFile.betterView).toEqual({ kind: "memory", path: "entities/jonas.md" });
    const session = (await (await get("/ui/api/storage/browse/.claude/projects/-home-agent/sess-42.jsonl")).json()) as BrowseFile;
    expect(session.betterView).toEqual({ kind: "session", sessionId: "sess-42" });
  });

  test("missing file is 404, requesting a directory as a file still returns its listing", async () => {
    expect((await get("/ui/api/storage/browse/nope.txt")).status).toBe(404);
    write("memory/a.md", "a\n");
    const d = await get("/ui/api/storage/browse/memory");
    expect(d.status).toBe(200);
    expect(((await d.json()) as BrowseDir).type).toBe("dir");
  });
});

// ---------------------------------------------------------------------------
// Path traversal / symlink escape
// ---------------------------------------------------------------------------

describe("path traversal", () => {
  beforeEach(() => write("secrets/token", "top-secret\n"));

  test.each(["..%2fsecrets%2ftoken", "%2fetc%2fpasswd", "a%00b.md", "memory%2f..%2f..%2fsecrets%2ftoken", "memory%5c..%5c..%5csecrets%5ctoken"])(
    "GET %s is rejected",
    async (p) => {
      const res = await get(`/ui/api/storage/browse/${p}`);
      expect([400, 404]).toContain(res.status);
      expect(await res.text()).not.toContain("top-secret");
    },
  );

  test.each(["../secrets/token", "memory/../../secrets/token", "/etc/passwd", "./MEMORY.md", "a\\..\\b", "a\0b"])("resolveHomePath(%p) throws 400", (p) => {
    expect(() => resolveHomePath(p)).toThrow(HttpError);
  });

  test("resolveHomePath allows hidden segments (unlike ~/memory) and normalizes duplicate slashes", () => {
    const r = resolveHomePath(".claude//settings.json");
    expect(r.rel).toBe(".claude/settings.json");
    expect(r.abs).toBe(join(HOME, ".claude", "settings.json"));
  });

  test("empty path resolves to HOME itself", () => {
    const r = resolveHomePath("");
    expect(r.abs).toBe(HOME);
    expect(r.rel).toBe("");
  });

  test("symlinks pointing outside HOME are rejected for browse and download", async () => {
    const outside = mkdtempSync(join(tmpdir(), "atlas-storage-outside-"));
    writeFileSync(join(outside, "leaked.txt"), "outside secret\n");
    symlinkSync(outside, join(HOME, "escape-dir"));
    symlinkSync(join(outside, "leaked.txt"), join(HOME, "escape-file.txt"));
    try {
      expect((await get("/ui/api/storage/browse/escape-dir")).status).toBe(400);
      expect((await get("/ui/api/storage/browse/escape-dir/leaked.txt")).status).toBe(400);
      expect((await get("/ui/api/storage/browse/escape-file.txt")).status).toBe(400);
      expect((await get("/ui/api/storage/download/escape-file.txt")).status).toBe(400);
      // Not listed as a followable entry from the parent either.
      const root = (await (await get("/ui/api/storage/browse")).json()) as BrowseDir;
      const link = root.entries.find((e) => e.name === "escape-file.txt")!;
      expect(link.kind).toBe("other");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

describe("GET /ui/api/storage/download/*", () => {
  beforeEach(() => {
    rmSync(join(HOME, "secrets"), { recursive: true, force: true });
    write("secrets/token", "top-secret\n");
    write("report.txt", "plain report\n");
    write("config.yml", 'signal:\n  api_token: "shh"\n');
  });

  test("downloads a regular file with attachment headers", async () => {
    const res = await get("/ui/api/storage/download/report.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('attachment; filename="report.txt"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("plain report\n");
  });

  test("denies download of secrets", async () => {
    const res = await get("/ui/api/storage/download/secrets/token");
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("top-secret");
  });

  test("downloads config.yml masked", async () => {
    const res = await get("/ui/api/storage/download/config.yml");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("shh");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("directories and missing files are rejected", async () => {
    expect((await get("/ui/api/storage/download/secrets")).status).toBe(400);
    expect((await get("/ui/api/storage/download/nope.txt")).status).toBe(404);
  });
});
