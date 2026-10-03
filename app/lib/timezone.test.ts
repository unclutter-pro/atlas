/**
 * Tests for lib/timezone.ts: resolution order, invalid values, and DST day
 * bounds. Never depends on the machine's zone — every case sets it
 * explicitly (config.yml, ATLAS_TIMEZONE, or injected TimezoneDeps).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isValidTimeZone, resolveTimezone, zonedDateString, zonedDayStartUtc, zonedParts, zonedWallClockToUtc } from "./timezone";

function tempHome(configYaml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "atlas-tz-"));
  if (configYaml !== undefined) writeFileSync(join(dir, "config.yml"), configYaml);
  return dir;
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env.ATLAS_TIMEZONE;
});

function home(configYaml?: string): string {
  const dir = tempHome(configYaml);
  dirs.push(dir);
  return dir;
}

// No TZ / /etc/timezone / /etc/localtime candidates resolve — isolates the "runtime" layer.
const NO_RUNTIME_HINTS = { env: {}, etcTimezonePath: "/nonexistent-tz-file", etcLocaltimePath: "/nonexistent-localtime" };

describe("isValidTimeZone", () => {
  test("accepts IANA names", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
  });

  test("rejects garbage and empty", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("resolveTimezone", () => {
  test("defaults to UTC when nothing is configured or detectable", () => {
    const h = home("agent:\n  name: X\n");
    expect(resolveTimezone(h, NO_RUNTIME_HINTS)).toEqual({ timeZone: "UTC", source: "default" });
  });

  test("config.yml timezone wins over the container runtime", () => {
    const h = home("timezone: Europe/Berlin\n");
    expect(resolveTimezone(h, NO_RUNTIME_HINTS)).toEqual({ timeZone: "Europe/Berlin", source: "config" });
  });

  test("ATLAS_TIMEZONE env beats config.yml", () => {
    const h = home("timezone: Europe/Berlin\n");
    process.env.ATLAS_TIMEZONE = "America/New_York";
    expect(resolveTimezone(h, NO_RUNTIME_HINTS)).toEqual({ timeZone: "America/New_York", source: "env" });
  });

  test("invalid explicit value is ignored, reported, and falls back to the runtime", () => {
    const h = home("timezone: Not/AZone\n");
    const r = resolveTimezone(h, { env: { TZ: "Asia/Tokyo" }, etcTimezonePath: "/nonexistent", etcLocaltimePath: "/nonexistent" });
    expect(r).toEqual({ timeZone: "Asia/Tokyo", source: "runtime", invalid: "Not/AZone" });
  });

  test("invalid value with no runtime hints falls all the way to UTC default", () => {
    const h = home("timezone: nope\n");
    const r = resolveTimezone(h, NO_RUNTIME_HINTS);
    expect(r).toEqual({ timeZone: "UTC", source: "default", invalid: "nope" });
  });

  test("runtime layer: TZ env, then /etc/timezone, then /etc/localtime, in that order", () => {
    const h = home("");
    expect(resolveTimezone(h, { env: { TZ: "Europe/Paris" }, etcTimezonePath: "/nonexistent", etcLocaltimePath: "/nonexistent" }).timeZone).toBe(
      "Europe/Paris",
    );

    const etcTz = join(tempHome(), "timezone-file");
    writeFileSync(etcTz, "Asia/Kolkata\n");
    dirs.push(join(etcTz, ".."));
    expect(resolveTimezone(h, { env: {}, etcTimezonePath: etcTz, etcLocaltimePath: "/nonexistent" }).timeZone).toBe("Asia/Kolkata");
    // TZ env still wins over /etc/timezone when both are present.
    expect(resolveTimezone(h, { env: { TZ: "Europe/Paris" }, etcTimezonePath: etcTz, etcLocaltimePath: "/nonexistent" }).timeZone).toBe("Europe/Paris");
  });

  test("invalid TZ env is skipped in favor of a valid /etc/timezone", () => {
    const h = home("");
    const etcTz = join(tempHome(), "timezone-file");
    writeFileSync(etcTz, "Asia/Kolkata\n");
    dirs.push(join(etcTz, ".."));
    const r = resolveTimezone(h, { env: { TZ: "garbage" }, etcTimezonePath: etcTz, etcLocaltimePath: "/nonexistent" });
    expect(r).toEqual({ timeZone: "Asia/Kolkata", source: "runtime" });
  });
});

describe("zonedParts / zonedDateString", () => {
  test("reads wall-clock components in the given zone", () => {
    // 2026-01-01T00:30:00Z is still Dec 31 in New York (UTC-5).
    const d = new Date("2026-01-01T00:30:00Z");
    expect(zonedDateString(d, "America/New_York")).toBe("2025-12-31");
    expect(zonedDateString(d, "UTC")).toBe("2026-01-01");
    const p = zonedParts(d, "America/New_York");
    expect(p).toMatchObject({ year: 2025, month: 12, day: 31, hour: 19, minute: 30 });
  });
});

describe("zonedDayStartUtc — DST transitions (Europe/Berlin 2026)", () => {
  test("spring forward: 2026-03-29, CET (UTC+1) becomes CEST (UTC+2) at 02:00 local", () => {
    const dayBefore = zonedDayStartUtc("2026-03-28", "Europe/Berlin");
    const dstDay = zonedDayStartUtc("2026-03-29", "Europe/Berlin");
    const dayAfter = zonedDayStartUtc("2026-03-30", "Europe/Berlin");
    // Midnight local on the 28th and the 30th are both a plain 23h/25h apart from
    // their neighbors except across the transition, where the gap is 23h (a hour is skipped).
    expect(dstDay.getTime() - dayBefore.getTime()).toBe(24 * 3600_000);
    expect(dayAfter.getTime() - dstDay.getTime()).toBe(23 * 3600_000);
    // Midnight itself is still CET (offset +1) since the gap is at 02:00, not 00:00.
    expect(dstDay.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(dayAfter.toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });

  test("fall back: 2026-10-25, CEST (UTC+2) becomes CET (UTC+1) at 03:00 local", () => {
    const dstDay = zonedDayStartUtc("2026-10-25", "Europe/Berlin");
    const dayAfter = zonedDayStartUtc("2026-10-26", "Europe/Berlin");
    expect(dayAfter.getTime() - dstDay.getTime()).toBe(25 * 3600_000);
    expect(dstDay.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(dayAfter.toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });

  test("UTC has no DST: every day is exactly 24h", () => {
    const a = zonedDayStartUtc("2026-03-29", "UTC");
    const b = zonedDayStartUtc("2026-03-30", "UTC");
    expect(b.getTime() - a.getTime()).toBe(24 * 3600_000);
  });
});

describe("zonedWallClockToUtc — DST gap detection", () => {
  test("02:30 on the Berlin spring-forward day does not exist", () => {
    const { hour } = zonedWallClockToUtc(2026, 2, 29, 2, 30, "Europe/Berlin");
    expect(hour).not.toBe(2);
  });

  test("an ordinary time round-trips exactly", () => {
    // Month is zero-based: 4 = May.
    const { date, hour } = zonedWallClockToUtc(2026, 4, 15, 14, 30, "Europe/Berlin");
    expect(hour).toBe(14);
    expect(zonedDateString(date, "Europe/Berlin")).toBe("2026-05-15");
    expect(zonedParts(date, "Europe/Berlin").hour).toBe(14);
  });
});
