/**
 * Next-fire computation of the shared cron parser (used by Overview and Automations).
 * Description and validation messages are covered in automations.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { nextRuns, parseCron } from "./cron";

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

function next(expr: string, after: Date): Date | undefined {
  const p = parseCron(expr);
  if (!p.ok) throw new Error(p.error);
  return nextRuns(p.spec, 1, after)[0];
}

describe("nextRuns", () => {
  test.each([
    ["*/30 * * * *", local(2026, 9, 21, 10, 5), local(2026, 9, 21, 10, 30)],
    ["*/30 * * * *", local(2026, 9, 21, 10, 30), local(2026, 9, 21, 11, 0)],
    ["0 7 * * *", local(2026, 9, 21, 7, 0), local(2026, 9, 22, 7, 0)],
    ["0 7 * * *", local(2026, 9, 21, 6, 59), local(2026, 9, 21, 7, 0)],
    // 2026-09-21 is a Monday
    ["0 9 * * 1", local(2026, 9, 21, 9, 0), local(2026, 9, 28, 9, 0)],
    ["0 9 * * 1-5", local(2026, 9, 25, 10, 0), local(2026, 9, 28, 9, 0)],
    ["0 0 * * 7", local(2026, 9, 21), local(2026, 9, 27)],
    ["15,45 8-10 * * *", local(2026, 9, 21, 10, 50), local(2026, 9, 22, 8, 15)],
    ["5/20 * * * *", local(2026, 9, 21, 10, 26), local(2026, 9, 21, 10, 45)],
    ["0 0 1 */3 *", local(2026, 9, 21), local(2026, 10, 1)],
    ["0 0 29 2 *", local(2026, 3, 1), local(2028, 2, 29)],
    // Both day fields restricted: either matches (1st of month OR Friday)
    ["0 12 1 * 5", local(2026, 9, 21), local(2026, 9, 25, 12)],
  ])("%s after %s", (expr, after, expected) => {
    expect(next(expr, after)?.getTime()).toBe(expected.getTime());
  });

  // sync-crontab.ts drops these, so they must never look schedulable.
  test.each(["@daily", "0 9 * * mon-fri", "a b c d e", "* * * * * *", "* * 0 * *", "* 24 * * *"])("rejects %p", (expr) => {
    expect(parseCron(expr).ok).toBe(false);
  });

  test("impossible dates have no next run", () => {
    expect(next("0 0 31 2 *", local(2026, 1, 1))).toBeUndefined();
  });
});

describe("nextRuns with an explicit time zone (DST, Europe/Berlin 2026)", () => {
  const zoned = (expr: string, after: Date, count = 1) => {
    const p = parseCron(expr);
    if (!p.ok) throw new Error(p.error);
    return nextRuns(p.spec, count, after, "Europe/Berlin");
  };

  test("matches the ambient result for an ordinary day (no transition nearby)", () => {
    const after = new Date("2026-06-01T10:00:00Z");
    const p = parseCron("30 14 * * *");
    if (!p.ok) throw new Error(p.error);
    const [zonedRun] = nextRuns(p.spec, 1, after, "Europe/Berlin");
    // 14:30 CEST (UTC+2) in June.
    expect(zonedRun?.toISOString()).toBe("2026-06-01T12:30:00.000Z");
  });

  test("spring forward: a 02:30 daily job skips the day the hour does not exist", () => {
    // 2026-03-29: clocks jump 02:00 -> 03:00 in Europe/Berlin.
    const runs = zoned("30 2 * * *", new Date("2026-03-27T12:00:00Z"), 3);
    const days = runs.map((d) => d.toISOString().slice(0, 10));
    expect(days).not.toContain("2026-03-29");
    expect(days).toEqual(["2026-03-28", "2026-03-30", "2026-03-31"]);
  });

  test("fall back: a 02:30 daily job still fires exactly once on the ambiguous day", () => {
    // 2026-10-25: 02:00-03:00 CEST happens, then repeats as 02:00-03:00 CET.
    const runs = zoned("30 2 * * *", new Date("2026-10-24T12:00:00Z"), 2);
    const days = runs.map((d) => d.toISOString().slice(0, 10));
    expect(days).toEqual(["2026-10-25", "2026-10-26"]);
    // Exactly one 02:30 fire on the fall-back day itself.
    expect(runs.filter((d) => d.toISOString().slice(0, 10) === "2026-10-25")).toHaveLength(1);
  });

  test("a UTC offset that differs from the ambient zone changes the computed instant", () => {
    const p = parseCron("0 9 * * *");
    if (!p.ok) throw new Error(p.error);
    const from = new Date("2026-05-31T23:00:00Z"); // 08:00 JST / 01:00 CEST on June 1st in each zone
    const tokyo = nextRuns(p.spec, 1, from, "Asia/Tokyo")[0]!;
    const berlin = nextRuns(p.spec, 1, from, "Europe/Berlin")[0]!;
    expect(tokyo.getTime()).not.toBe(berlin.getTime());
    expect(tokyo.toISOString()).toBe("2026-06-01T00:00:00.000Z"); // 09:00 JST = 00:00 UTC
    expect(berlin.toISOString()).toBe("2026-06-01T07:00:00.000Z"); // 09:00 CEST = 07:00 UTC
  });
});
