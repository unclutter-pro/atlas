import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { summarize } from "./sessions.ts";

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "atlas-sessions-cli-"));
  project = join(home, ".claude", "projects", "-home-agent");
  mkdirSync(project, { recursive: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const now = () => new Date().toISOString();
const user = (text: string, extra: Record<string, unknown> = {}) =>
  line({ type: "user", uuid: crypto.randomUUID(), timestamp: now(), message: { role: "user", content: text }, ...extra });
const assistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  line({ type: "assistant", uuid: crypto.randomUUID(), timestamp: now(), message: { id, content }, ...extra });

function session(id: string, ...lines: string[]): string {
  const file = join(project, `${id}.jsonl`);
  writeFileSync(file, lines.join(""));
  return file;
}

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "sessions.ts"), ...args], {
    env: { ...process.env, HOME: home, ATLAS_HARNESS_BACKEND: "claude-code" }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

function seed() {
  session("main-1",
    user("Please update the invoice template for ACME"),
    assistant("m1", [{ type: "thinking", thinking: "The template lives in documents; I should check the placeholders first." }]),
    assistant("m1", [{ type: "text", text: "I will open the template and adjust the address block." }]),
    assistant("m1", [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/home/agent/invoice.md" } }]),
    line({ type: "user", timestamp: now(), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
    user("<system-reminder>ignore me please</system-reminder>"),
  );
  mkdirSync(join(project, "main-1", "subagents"), { recursive: true });
  writeFileSync(join(project, "main-1", "subagents", "agent-a1.jsonl"),
    user("Research the ACME billing address", { isSidechain: true }) +
    assistant("s1", [{ type: "tool_use", id: "t2", name: "WebFetch", input: { url: "https://acme.test" } }], { isSidechain: true }));
  session("dream-1", user("Consolidate memory from yesterday"));
  mkdirSync(join(home, ".index"), { recursive: true });
  const db = new Database(join(home, ".index", "atlas.db"));
  db.exec("CREATE TABLE trigger_sessions (trigger_name TEXT, session_key TEXT, session_id TEXT); CREATE TABLE session_metrics (trigger_name TEXT, session_id TEXT);");
  db.prepare("INSERT INTO session_metrics VALUES ('dreaming', 'dream-1')").run();
  db.close();
}

describe("sessions CLI", () => {
  test("--list shows main and nested sessions with a reference --session accepts; excluded triggers are left out", async () => {
    seed();
    const { code, out } = await run("--hours", "24", "--list", "--exclude-trigger", "dreaming");
    expect(code).toBe(0);
    const rows = out.split("\n").filter((l) => /^(main|sub) \|/.test(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^main \| main-1 \| 2 turns \| .* \| Edit\(1\) \| Please update the invoice template for ACME \| main-1$/);
    expect(rows[1]).toMatch(/^sub \| agent-a1 \| 2 turns \| .* \| WebFetch\(1\) \| Research the ACME billing address \| main-1\/agent-a1$/);
    expect(out).not.toContain("dream-1");
  });

  test("--session reads a session, a nested agent, or a legacy transcript path", async () => {
    seed();
    const main = await run("--session", "main-1");
    expect(main.code).toBe(0);
    expect(main.out).toContain("### Session main-1");
    expect(main.out).toContain("👤 Please update the invoice template for ACME");
    expect(main.out).toContain("🤖 [thinking: The template lives in documents");
    expect(main.out).toContain("Files: /home/agent/invoice.md");
    expect(main.out).not.toContain("ignore me");

    const nested = await run("--session", "main-1/agent-a1");
    expect(nested.out).toContain("### [subagent] Session agent-a1");
    const legacy = await run("--session", join(project, "main-1", "subagents", "agent-a1.jsonl"));
    expect(legacy.out).toBe(nested.out);
    expect((await run("--session", join(project, "main-1.jsonl"))).out).toBe(main.out);

    const missing = await run("--session", "nope");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("Session not found");
  });

  test("the extract lists main sessions in detail, nested agents condensed, and tool totals", async () => {
    seed();
    const { out } = await run("--hours", "24", "--exclude-trigger", "dreaming");
    expect(out).toContain("1 main sessions, 1 subagent sessions");
    expect(out).toContain("## Main Sessions");
    expect(out).toContain("- **agent-a1**: Research the ACME billing address | Tools: WebFetch(1)");
    expect(out).toContain("- Edit: 1");
  });

  test("--prune-days removes inactive sessions only", async () => {
    const old = session("old-1", user("an old conversation here"));
    const past = new Date(Date.now() - 20 * 86400_000);
    utimesSync(old, past, past);
    session("new-1", user("a current conversation here"));
    const { code, out } = await run("--prune-days", "14");
    expect(code).toBe(0);
    expect(out).toContain("Sessions pruned: 1");
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(project, "new-1.jsonl"))).toBe(true);
  });

  test("rejects unknown options and invalid numbers", async () => {
    expect((await run("--bogus")).code).toBe(2);
    expect((await run("--hours", "abc")).code).toBe(2);
  });
});

test("summarize keeps the first and last turns of long sessions", () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({
    id: `u${i}:0`, at: null, nested: false, kind: "user-text" as const, text: `message number ${i} with enough text`,
  }));
  const s = summarize("s", "s", false, entries);
  expect(s.turnCount).toBe(50);
  expect(s.turnsSkipped).toBe(10);
  expect(s.turns).toHaveLength(41);
  expect(s.turns[20]).toEqual({ role: "gap", text: "[...10 turns skipped...]" });
});
