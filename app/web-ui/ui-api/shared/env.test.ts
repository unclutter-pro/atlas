import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isTestRun, trySpawn, trySpawnSync } from "./env";

describe("spawn guard under the test runner", () => {
  test("bun test is detected", () => {
    expect(isTestRun()).toBe(true);
  });

  test("no spawn happens even when the target exists and is executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-spawn-guard-"));
    const marker = join(dir, "marker");
    const script = join(dir, "touch.sh");
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(script, 0o755);

    expect(trySpawn([script])).toBe(false);
    expect(trySpawnSync([script])).toBe(false);
    Bun.sleepSync(150);
    expect(existsSync(marker)).toBe(false);
  });
});
