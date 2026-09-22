/**
 * /ui/api/knowledge/* against a throwaway HOME (no DB needed).
 */

import { test, describe, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { resolveMemoryPath } from "./knowledge/files";
import { HttpError } from "./shared/http";
import { routes, type JournalDayResponse, type KnowledgeOverviewResponse, type MemoryFileResponse, type SearchResponse } from "./knowledge";

const prevHome = process.env.HOME;
let HOME: string;
let server: ReturnType<typeof Bun.serve>;

const url = (p: string) => new URL(p, server.url);
const get = (p: string) => fetch(url(p));
const send = (method: string, p: string, body: unknown = {}, contentType = "application/json") =>
  fetch(url(p), { method, headers: { "Content-Type": contentType }, body: JSON.stringify(body) });

function write(rel: string, content: string) {
  const abs = join(HOME, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), "atlas-knowledge-test-"));
  process.env.HOME = HOME;
  server = Bun.serve({ port: 0, routes: routes as any, fetch: () => new Response("unmatched", { status: 418 }) });
});

afterAll(() => {
  server.stop(true);
  process.env.HOME = prevHome;
  rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(HOME, "memory"), { recursive: true, force: true });
  rmSync(join(HOME, "MEMORY.md"), { force: true });
  write("memory/MEMORY.md", "# Memory\n\n- Jonas is co-founder. See [jonas](entities/jonas.md)\n");
  write("memory/entities/jonas.md", "# Jonas\n\nEmail jonas@example.com\n");
  write("memory/projects/atlas.md", "# Atlas\n\nNothing about him here.\n");
  write("memory/journal/2026-09-10.md", "# 2026-09-10\n\nMet Jonas for lunch.\n");
  write("memory/journal/2026-09-12.md", "# 2026-09-12\n\nQuiet day.\n");
  write("memory/2026-09-01.md", "# legacy\n");
  write("memory/.hidden/secret.md", "hidden jonas\n");
  write("secrets/token", "top-secret\n");
});

describe("GET /ui/api/knowledge", () => {
  test("returns MEMORY.md, the file tree without journals, and a journal summary", async () => {
    const res = await get("/ui/api/knowledge");
    expect(res.status).toBe(200);
    const d = (await res.json()) as KnowledgeOverviewResponse;
    expect(d.memory?.content).toContain("Jonas is co-founder");
    expect(d.memory?.editable).toBe(true);
    expect(d.memory?.deletable).toBe(false);
    expect(d.memory?.modifiedAt).toMatch(/Z$/);
    expect(d.files.map((f) => f.path)).toEqual(["entities/jonas.md", "projects/atlas.md"]);
    expect(d.journal.count).toBe(3);
    expect(d.journal.latest?.date).toBe("2026-09-12");
  });

  test("falls back to a read-only legacy ~/MEMORY.md", async () => {
    rmSync(join(HOME, "memory/MEMORY.md"));
    write("MEMORY.md", "# old place\n");
    const d = (await (await get("/ui/api/knowledge")).json()) as KnowledgeOverviewResponse;
    expect(d.memory?.legacyLocation).toBe(true);
    expect(d.memory?.editable).toBe(false);
  });

  test("works without a memory directory", async () => {
    rmSync(join(HOME, "memory"), { recursive: true, force: true });
    const d = (await (await get("/ui/api/knowledge")).json()) as KnowledgeOverviewResponse;
    expect(d.memory).toBeNull();
    expect(d.files).toEqual([]);
    expect(d.journal.count).toBe(0);
  });
});

describe("search", () => {
  test("finds content and path matches with line numbers and ranges, MEMORY.md first", async () => {
    const r = (await (await get("/ui/api/knowledge/search?q=JONAS")).json()) as SearchResponse;
    const paths = r.hits.map((h) => h.path);
    expect(paths[0]).toBe("MEMORY.md");
    expect(paths).toContain("entities/jonas.md");
    expect(paths).toContain("journal/2026-09-10.md");
    expect(paths).not.toContain(".hidden/secret.md");
    const jonas = r.hits.find((h) => h.path === "entities/jonas.md")!;
    expect(jonas.pathMatch).toBe(true);
    expect(jonas.lines[0]).toEqual({ line: 1, text: "# Jonas", ranges: [[2, 7]] });
    const journal = r.hits.find((h) => h.path === "journal/2026-09-10.md")!;
    expect(journal.kind).toBe("journal");
    expect(journal.date).toBe("2026-09-10");
  });

  test("empty query returns no hits; overlong query is rejected", async () => {
    const r = (await (await get("/ui/api/knowledge/search?q=")).json()) as SearchResponse;
    expect(r.hits).toEqual([]);
    expect((await get(`/ui/api/knowledge/search?q=${"x".repeat(201)}`)).status).toBe(400);
  });

  test("long lines are trimmed around the match with shifted ranges", async () => {
    write("memory/notes/long.md", `${"a".repeat(500)} needle ${"b".repeat(500)}\n`);
    const r = (await (await get("/ui/api/knowledge/search?q=needle")).json()) as SearchResponse;
    const line = r.hits[0]!.lines[0]!;
    expect(line.text.length).toBeLessThan(260);
    const [s, e] = line.ranges[0]!;
    expect(line.text.slice(s, e)).toBe("needle");
  });
});

describe("GET /ui/api/knowledge/file/*", () => {
  test("reads a nested file", async () => {
    const res = await get("/ui/api/knowledge/file/entities/jonas.md");
    expect(res.status).toBe(200);
    const f = (await res.json()) as MemoryFileResponse;
    expect(f.path).toBe("entities/jonas.md");
    expect(f.content).toContain("jonas@example.com");
    expect(f.editable).toBe(true);
    expect(f.deletable).toBe(true);
    expect(typeof f.mtimeMs).toBe("number");
  });

  test("journal files are marked read-only", async () => {
    const f = (await (await get("/ui/api/knowledge/file/journal/2026-09-10.md")).json()) as MemoryFileResponse;
    expect(f.kind).toBe("journal");
    expect(f.editable).toBe(false);
    const legacy = (await (await get("/ui/api/knowledge/file/2026-09-01.md")).json()) as MemoryFileResponse;
    expect(legacy.editable).toBe(false);
  });

  test("missing file is 404, directory is 400", async () => {
    expect((await get("/ui/api/knowledge/file/nope.md")).status).toBe(404);
    expect((await get("/ui/api/knowledge/file/entities")).status).toBe(400);
  });
});

describe("path traversal", () => {
  // URL parsing already collapses "..", "%2e%2e" and "." segments, so the
  // handler-level checks are also tested directly on resolveMemoryPath below.
  test.each([
    "entities%2f..%2f..%2fsecrets%2ftoken",
    "..%2fsecrets%2ftoken",
    "%2fetc%2fpasswd",
    ".hidden/secret.md",
    "a%00b.md",
    "entities%5c..%5c..%5csecrets%5ctoken",
  ])("GET %s is rejected", async (p) => {
    const res = await get(`/ui/api/knowledge/file/${p}`);
    expect([400, 404]).toContain(res.status);
    expect(await res.text()).not.toContain("top-secret");
  });

  test.each(["../secrets/token", "entities/../../secrets/token", "/etc/passwd", "./MEMORY.md", ".hidden/x.md", "a\\..\\b", "", "a\0b"])(
    "resolveMemoryPath(%p) throws 400",
    (p) => {
      expect(() => resolveMemoryPath(p)).toThrow(HttpError);
    },
  );

  test("resolveMemoryPath normalizes duplicate slashes and stays inside ~/memory", () => {
    const r = resolveMemoryPath("entities//jonas.md");
    expect(r.rel).toBe("entities/jonas.md");
    expect(r.abs).toBe(join(HOME, "memory", "entities", "jonas.md"));
  });

  test("encoded traversal cannot write outside ~/memory", async () => {
    const res = await send("PUT", "/ui/api/knowledge/file/..%2fescaped.md", { content: "x", baseMtimeMs: null });
    expect(res.status).toBe(400);
    expect(existsSync(join(HOME, "escaped.md"))).toBe(false);
  });

  test("symlinks pointing outside ~/memory are rejected for read and write", async () => {
    symlinkSync(join(HOME, "secrets"), join(HOME, "memory/leak"));
    symlinkSync(join(HOME, "secrets/token"), join(HOME, "memory/token.md"));
    expect((await get("/ui/api/knowledge/file/leak/token")).status).toBe(400);
    expect((await get("/ui/api/knowledge/file/token.md")).status).toBe(400);
    const put = await send("PUT", "/ui/api/knowledge/file/leak/new.md", { content: "x", baseMtimeMs: null });
    expect(put.status).toBe(400);
    expect(existsSync(join(HOME, "secrets/new.md"))).toBe(false);
    // Symlinks are not listed in the tree either.
    const d = (await (await get("/ui/api/knowledge")).json()) as KnowledgeOverviewResponse;
    expect(d.files.map((f) => f.path).some((p) => p.startsWith("leak") || p === "token.md")).toBe(false);
  });
});

describe("PUT /ui/api/knowledge/file/*", () => {
  const load = async (p: string) => (await (await get(`/ui/api/knowledge/file/${p}`)).json()) as MemoryFileResponse;

  test("saves with a matching mtime and returns the new version", async () => {
    const f = await load("MEMORY.md");
    const res = await send("PUT", "/ui/api/knowledge/file/MEMORY.md", { content: "# Memory\n\nnew\n", baseMtimeMs: f.mtimeMs });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as MemoryFileResponse;
    expect(saved.content).toBe("# Memory\n\nnew\n");
    expect(readFileSync(join(HOME, "memory/MEMORY.md"), "utf-8")).toBe("# Memory\n\nnew\n");
  });

  test("rejects a stale mtime with 409 and the current version", async () => {
    const f = await load("entities/jonas.md");
    // Someone else writes the file after we loaded it.
    write("memory/entities/jonas.md", "changed by agent\n");
    utimesSync(join(HOME, "memory/entities/jonas.md"), new Date(), new Date(f.mtimeMs + 5000));
    const res = await send("PUT", "/ui/api/knowledge/file/entities/jonas.md", { content: "mine", baseMtimeMs: f.mtimeMs });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { conflict: boolean; current: MemoryFileResponse };
    expect(body.conflict).toBe(true);
    expect(body.current.content).toBe("changed by agent\n");
    expect(readFileSync(join(HOME, "memory/entities/jonas.md"), "utf-8")).toBe("changed by agent\n");
  });

  test("409 when the file was deleted meanwhile", async () => {
    const f = await load("projects/atlas.md");
    rmSync(join(HOME, "memory/projects/atlas.md"));
    const res = await send("PUT", "/ui/api/knowledge/file/projects/atlas.md", { content: "x", baseMtimeMs: f.mtimeMs });
    expect(res.status).toBe(409);
  });

  test("creates new files (baseMtimeMs null) but never overwrites an existing one", async () => {
    const res = await send("PUT", "/ui/api/knowledge/file/notes/new.md", { content: "# New\n", baseMtimeMs: null });
    expect(res.status).toBe(200);
    expect(readFileSync(join(HOME, "memory/notes/new.md"), "utf-8")).toBe("# New\n");
    const again = await send("PUT", "/ui/api/knowledge/file/notes/new.md", { content: "other", baseMtimeMs: null });
    expect(again.status).toBe(409);
    expect((await send("PUT", "/ui/api/knowledge/file/notes/run.sh", { content: "x", baseMtimeMs: null })).status).toBe(400);
  });

  test("leaves no temp files behind", async () => {
    const f = await load("MEMORY.md");
    await send("PUT", "/ui/api/knowledge/file/MEMORY.md", { content: "x", baseMtimeMs: f.mtimeMs });
    const { readdirSync } = await import("fs");
    expect(readdirSync(join(HOME, "memory")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("journals are read-only (both locations)", async () => {
    for (const p of ["journal/2026-09-10.md", "2026-09-01.md", "journal/notes.md"]) {
      const res = await send("PUT", `/ui/api/knowledge/file/${p}`, { content: "x", baseMtimeMs: 1 });
      expect(res.status).toBe(403);
    }
    expect(readFileSync(join(HOME, "memory/journal/2026-09-10.md"), "utf-8")).toContain("Met Jonas");
  });

  test("validates the body and requires JSON", async () => {
    expect((await send("PUT", "/ui/api/knowledge/file/MEMORY.md", { baseMtimeMs: null })).status).toBe(400);
    expect((await send("PUT", "/ui/api/knowledge/file/MEMORY.md", { content: "x" })).status).toBe(400);
    const form = await fetch(url("/ui/api/knowledge/file/MEMORY.md"), {
      method: "PUT",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "content=x",
    });
    expect(form.status).toBe(415);
  });
});

describe("DELETE /ui/api/knowledge/file/*", () => {
  test("deletes a memory file", async () => {
    const res = await send("DELETE", "/ui/api/knowledge/file/projects/atlas.md");
    expect(res.status).toBe(200);
    expect(existsSync(join(HOME, "memory/projects/atlas.md"))).toBe(false);
    expect((await send("DELETE", "/ui/api/knowledge/file/projects/atlas.md")).status).toBe(404);
  });

  test("refuses MEMORY.md, journals, directories and non-JSON requests", async () => {
    expect((await send("DELETE", "/ui/api/knowledge/file/MEMORY.md")).status).toBe(403);
    expect((await send("DELETE", "/ui/api/knowledge/file/journal/2026-09-10.md")).status).toBe(403);
    expect((await send("DELETE", "/ui/api/knowledge/file/entities")).status).toBe(400);
    expect((await fetch(url("/ui/api/knowledge/file/entities/jonas.md"), { method: "DELETE" })).status).toBe(415);
    expect(existsSync(join(HOME, "memory/entities/jonas.md"))).toBe(true);
  });
});

describe("journal", () => {
  test("lists days newest first, preferring journal/ over the legacy location", async () => {
    write("memory/2026-09-10.md", "# legacy duplicate\n");
    const r = (await (await get("/ui/api/knowledge/journal")).json()) as { days: Array<{ date: string; path: string }> };
    expect(r.days.map((d) => d.date)).toEqual(["2026-09-12", "2026-09-10", "2026-09-01"]);
    expect(r.days.find((d) => d.date === "2026-09-10")!.path).toBe("journal/2026-09-10.md");
  });

  test("one day with prev/next", async () => {
    const d = (await (await get("/ui/api/knowledge/journal/2026-09-10")).json()) as JournalDayResponse;
    expect(d.entry?.content).toContain("Met Jonas");
    expect(d.prev).toBe("2026-09-01");
    expect(d.next).toBe("2026-09-12");
    expect(d.latest).toBe("2026-09-12");
  });

  test("legacy-location day and a day without entry", async () => {
    const legacy = (await (await get("/ui/api/knowledge/journal/2026-09-01")).json()) as JournalDayResponse;
    expect(legacy.entry?.legacyLocation).toBe(true);
    expect(legacy.prev).toBeNull();
    const gap = (await (await get("/ui/api/knowledge/journal/2026-09-11")).json()) as JournalDayResponse;
    expect(gap.entry).toBeNull();
    expect(gap.prev).toBe("2026-09-10");
    expect(gap.next).toBe("2026-09-12");
  });

  test("rejects invalid dates", async () => {
    for (const d of ["2026-02-30", "yesterday", "2026-9-1", "..%2f..%2fsecrets"]) {
      expect((await get(`/ui/api/knowledge/journal/${d}`)).status).toBe(400);
    }
  });
});
