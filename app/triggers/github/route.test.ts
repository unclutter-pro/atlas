import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROUTE = join(import.meta.dir, "route.ts");
let home: string;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "github-route-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function run(stdin: string) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ATLAS_")));
  const proc = Bun.spawnSync(["bun", ROUTE], {
    stdin: new TextEncoder().encode(stdin),
    env: { ...clean, HOME: home, ATLAS_GITHUB_ROUTER_LOG: join(home, "router.log") },
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const event = JSON.stringify({
  headers: { "x-github-event": "issues", "x-github-delivery": "d-1" },
  body: { action: "opened", repository: { full_name: "acme/webapp" }, issue: { number: 7, title: "x", body: "hi", user: { login: "alice" } }, sender: { login: "alice" } },
});

test("route never exits 0, so the ingress trigger never starts a session", () => {
  expect(run(event).code).toBe(2); // github.login not configured
  writeFileSync(join(home, "config.yml"), "github:\n  login: my-bot\n");
  expect(run(event).code).toBe(1); // not involved → skipped
  expect(run("not json").code).toBe(1);
  rmSync(join(home, ".index", "github"), { recursive: true, force: true });
  writeFileSync(join(home, ".index", "github"), "a file where the ledger directory belongs");
  const broken = run(event);
  expect(broken.code).toBe(3);
  expect(broken.stderr).toContain("ERROR ledger");
});
