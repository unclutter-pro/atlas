import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cli.ts");
let home: string;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "github-cli-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function run(args: string[], stdin = "", env: Record<string, string> = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ATLAS_")));
  const proc = Bun.spawnSync(["bun", CLI, ...args], {
    stdin: new TextEncoder().encode(stdin),
    env: { ...clean, HOME: home, ATLAS_GITHUB_ROUTER_LOG: join(home, "router.log"), ...env },
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const event = JSON.stringify({
  headers: { "x-github-event": "issues", "x-github-delivery": "d-1" },
  body: { action: "opened", repository: { full_name: "acme/webapp" }, issue: { number: 7, title: "x", body: "hi", user: { login: "alice" } }, sender: { login: "alice" } },
});

test("route never exits 0, so the ingress trigger never starts a session", () => {
  expect(run(["route"], event).code).toBe(2); // github.login not configured
  writeFileSync(join(home, "config.yml"), "github:\n  login: my-bot\n");
  expect(run(["route"], event).code).toBe(1); // not involved → skipped
  expect(run(["route"], "not json").code).toBe(1);
  rmSync(join(home, ".index", "github"), { recursive: true, force: true });
  writeFileSync(join(home, ".index", "github"), "a file where the ledger directory belongs");
  const broken = run(["route"], event);
  expect(broken.code).toBe(3);
  expect(broken.stderr).toContain("ERROR ledger");
});

test("link, topics and unlink manage the ledger", () => {
  expect(run(["link", "Acme/WebApp#42", "login-bug"]).stdout).toContain("acme/webapp#42 → 'login-bug'");
  expect(run(["link", "acme/webapp#43"], "", { ATLAS_TRIGGER_SESSION_KEY: "login-bug" }).code).toBe(0);
  const topics = JSON.parse(run(["topics", "--json"]).stdout);
  expect(topics).toMatchObject([{ slug: "login-bug", refs: ["acme/webapp#42", "acme/webapp#43"] }]);
  expect(run(["link", "acme/webapp#44"], "", { ATLAS_TRIGGER_SESSION_KEY: "_default" }).code).toBe(1);
  expect(run(["link", "not-a-ref", "x"]).code).toBe(1);
  run(["unlink", "acme/webapp#42"]);
  expect(run(["unlink", "acme/webapp#43"]).stdout).toContain("topic now empty, dropped");
});
