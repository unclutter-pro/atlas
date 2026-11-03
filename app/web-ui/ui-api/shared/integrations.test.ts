import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getIntegrationHealth, resetSupervisorCache } from "./integrations";
import { validateConfigYaml } from "../settings/validate";

test("Talk health requires a fresh connected listener, not just a running process", () => {
  const home = mkdtempSync(join(tmpdir(), "talk-health-"));
  const keys = ["HOME", "ATLAS_SUPERVISORCTL_STATUS_FILE", "TALK_URL", "TALK_USERNAME"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.HOME = home;
    delete process.env.TALK_URL; delete process.env.TALK_USERNAME;
    process.env.ATLAS_SUPERVISORCTL_STATUS_FILE = join(home, "supervisor.txt");
    writeFileSync(process.env.ATLAS_SUPERVISORCTL_STATUS_FILE, "talk-listener RUNNING pid 123, uptime 0:01:00\n");
    writeFileSync(join(home, "config.yml"), "talk:\n  url: https://cloud.example.org\n  username: atlas\n");
    resetSupervisorCache();
    const health = () => getIntegrationHealth().find(item => item.key === "talk")!;
    expect(health()).toMatchObject({ configured: true, state: "degraded" });
    mkdirSync(join(home, ".index/talk"), { recursive: true });
    const status = join(home, ".index/talk/status.json");
    writeFileSync(status, JSON.stringify({ state: "running", updatedAt: Date.now() }));
    expect(health().state).toBe("running");
    writeFileSync(status, JSON.stringify({ state: "auth_failed", updatedAt: Date.now() }));
    expect(health()).toMatchObject({ state: "degraded", detail: "Nextcloud rejected the account credentials" });
    writeFileSync(status, JSON.stringify({ state: "running", updatedAt: Date.now() - 180_000 }));
    expect(health().state).toBe("degraded");
  } finally {
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    resetSupervisorCache(); rmSync(home, { recursive: true, force: true });
  }
});

test("settings validation recognizes Talk and rejects wrongly typed identities and permissions", () => {
  expect(validateConfigYaml("talk:\n  url: https://cloud.example.org\n  username: atlas\n  whitelist: [max]\n").issues).toEqual([]);
  expect(validateConfigYaml("talk:\n  username: 123\n  whitelist: [123]\n").issues.map(issue => issue.path)).toEqual(["talk.username", "talk.whitelist"]);
});
