/**
 * sync-crontab.ts is a top-level script (no exported functions to unit
 * test), so these run it as a subprocess against an isolated HOME and
 * inspect the crontab it writes — in particular the CRON_TZ directive that
 * makes supercronic schedule in the resolved Atlas zone regardless of the
 * container's own TZ (see the comment in sync-crontab.ts for why).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "sync-crontab.ts");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "atlas-sync-crontab-"));
  dirs.push(dir);
  return dir;
}

function run(home: string, env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const res = Bun.spawnSync(["bun", "run", SCRIPT], {
    env: { ...process.env, HOME: home, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { stdout: res.stdout.toString(), stderr: res.stderr.toString(), exitCode: res.exitCode ?? 1 };
}

describe("sync-crontab CRON_TZ", () => {
  test("prepends CRON_TZ from the container runtime when nothing is configured explicitly", () => {
    const home = tempHome();
    const { exitCode, stdout } = run(home, { TZ: "Asia/Tokyo" });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("CRON_TZ=Asia/Tokyo");
    const crontab = readFileSync(join(home, "crontab"), "utf-8");
    expect(crontab.split("\n")[0]).toBe("CRON_TZ=Asia/Tokyo");
  });

  test("an explicit config.yml timezone beats the container TZ", () => {
    const home = tempHome();
    writeFileSync(join(home, "config.yml"), "timezone: Europe/Berlin\n");
    const { exitCode, stdout } = run(home, { TZ: "Asia/Tokyo" });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("CRON_TZ=Europe/Berlin");
    expect(readFileSync(join(home, "crontab"), "utf-8").split("\n")[0]).toBe("CRON_TZ=Europe/Berlin");
  });

  test("ATLAS_TIMEZONE env beats config.yml", () => {
    const home = tempHome();
    writeFileSync(join(home, "config.yml"), "timezone: Europe/Berlin\n");
    const { stdout } = run(home, { ATLAS_TIMEZONE: "America/New_York" });
    expect(stdout).toContain("CRON_TZ=America/New_York");
  });

  test("an invalid explicit value warns and falls back instead of failing", () => {
    const home = tempHome();
    writeFileSync(join(home, "config.yml"), "timezone: Not/AZone\n");
    const { exitCode, stdout, stderr } = run(home, { TZ: "Asia/Tokyo" });
    expect(exitCode).toBe(0);
    expect(stderr).toContain('invalid timezone "Not/AZone"');
    expect(stdout).toContain("CRON_TZ=Asia/Tokyo");
  });

  test("does not add a second CRON_TZ when the static crontab already has one", () => {
    const home = tempHome();
    writeFileSync(join(home, "crontab"), "CRON_TZ=Pacific/Auckland\n0 3 * * *  echo hi\n# === AUTO-GENERATED TRIGGERS (do not edit below) ===\n");
    const { exitCode } = run(home, { TZ: "Asia/Tokyo" });
    expect(exitCode).toBe(0);
    const crontab = readFileSync(join(home, "crontab"), "utf-8");
    expect(crontab.match(/CRON_TZ=/g)?.length).toBe(1);
    expect(crontab).toContain("CRON_TZ=Pacific/Auckland");
  });

  test("cron trigger lines still follow the marker", () => {
    const home = tempHome();
    const { exitCode } = run(home, { TZ: "UTC" });
    expect(exitCode).toBe(0);
    const crontab = readFileSync(join(home, "crontab"), "utf-8");
    expect(crontab).toContain("# === AUTO-GENERATED TRIGGERS (do not edit below) ===");
    expect(crontab).toContain("# (no cron triggers configured)");
  });
});
