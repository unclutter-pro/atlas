/**
 * Tests for /ui/api/usage/*. Run with an isolated HOME (dev/seed.ts); the
 * assertions are invariants that hold for any session_metrics contents.
 */

// Pin the zone so day-boundary assertions don't depend on the machine's zone.
process.env.ATLAS_TIMEZONE = "UTC";

import { test, describe, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "../server";
import { parseUsageFilter, type UsageResponse } from "./usage";
import { HttpError } from "./shared/http";

let server: ReturnType<typeof createServer>;
const get = (path: string) => fetch(new URL(path, server.url));
const getUsage = async (qs = "") => {
  const res = await get(`/ui/api/usage${qs}`);
  expect(res.status).toBe(200);
  return (await res.json()) as UsageResponse;
};
const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

beforeAll(() => {
  server = createServer(0);
});
afterAll(() => server.stop(true));

describe("parseUsageFilter", () => {
  const now = Date.parse("2026-09-21T12:00:00Z");
  const parse = (qs: string) => parseUsageFilter(new URLSearchParams(qs), now);
  const status = (qs: string) => {
    try {
      parse(qs);
      return 200;
    } catch (e) {
      return e instanceof HttpError ? e.status : 500;
    }
  };

  test("defaults to the last 30 days including today", () => {
    expect(parse("")).toMatchObject({ key: "30d", from: "2026-08-23", to: "2026-09-21", days: 30, trigger: null, type: null });
  });

  test("preset ranges", () => {
    expect(parse("range=7d")).toMatchObject({ from: "2026-09-15", to: "2026-09-21", days: 7 });
    expect(parse("range=90d").days).toBe(90);
  });

  test("from/to without range means custom, inclusive", () => {
    expect(parse("from=2026-09-01&to=2026-09-01")).toMatchObject({ key: "custom", days: 1 });
    expect(parse("from=2026-09-10")).toMatchObject({ key: "custom", from: "2026-09-10", to: "2026-09-21", days: 12 });
  });

  test("filters", () => {
    expect(parse("trigger=dreaming&type=cron")).toMatchObject({ trigger: "dreaming", type: "cron" });
  });

  test.each(["range=1y", "from=2026-02-30", "from=09/01/2026", "from=2026-09-10&to=2026-09-01", "from=2024-01-01&to=2026-01-01", "type=worker"])(
    "rejects %s with 400",
    (qs) => expect(status(qs)).toBe(400),
  );
});

describe("GET /ui/api/usage", () => {
  test("series covers every day of the range and sums to the totals", async () => {
    const d = await getUsage("?range=30d");
    expect(d.series).toHaveLength(30);
    expect(d.series[0]!.date).toBe(d.range.from);
    expect(d.series.at(-1)!.date).toBe(d.range.to);
    close(d.series.reduce((s, x) => s + x.costUsd, 0), d.totals.costUsd);
    expect(d.series.reduce((s, x) => s + x.runs, 0)).toBe(d.totals.runs);
    expect(d.series.reduce((s, x) => s + x.errors, 0)).toBe(d.totals.errors);
  });

  test("breakdowns partition the totals and shares add up", async () => {
    const d = await getUsage("?range=90d");
    for (const rows of [d.byTrigger, d.byType]) {
      expect(rows.reduce((s, r) => s + r.runs, 0)).toBe(d.totals.runs);
      close(rows.reduce((s, r) => s + r.costUsd, 0), d.totals.costUsd);
      if (d.totals.costUsd > 0) close(rows.reduce((s, r) => s + r.share, 0), 1);
      // sorted by cost, most expensive first
      for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.costUsd).toBeGreaterThanOrEqual(rows[i]!.costUsd);
    }
  });

  test("previous period is the same length directly before", async () => {
    const d = await getUsage("?from=2026-09-10&to=2026-09-16");
    expect(d.previous).toEqual({ from: "2026-09-03", to: "2026-09-09" });
  });

  test("derived totals", async () => {
    const { totals: t } = await getUsage("?range=90d");
    expect(t.tokens).toBe(t.inputTokens + t.outputTokens);
    if (t.runs) {
      close(t.errorRate!, t.errors / t.runs);
      close(t.avgCostUsd!, t.costUsd / t.runs);
    } else {
      expect(t.errorRate).toBeNull();
    }
  });

  test("trigger and type filters narrow every aggregate", async () => {
    const all = await getUsage("?range=90d");
    const top = all.byTrigger.find((r) => r.trigger);
    if (!top) return;
    const d = await getUsage(`?range=90d&trigger=${encodeURIComponent(top.trigger!)}`);
    expect(d.filter.trigger).toBe(top.trigger);
    expect(d.totals.runs).toBe(top.runs);
    expect(d.byTrigger.map((r) => r.trigger)).toEqual([top.trigger]);

    const typed = await getUsage(`?range=90d&type=${top.type}`);
    expect(typed.byType.map((r) => r.type)).toEqual([top.type]);
    expect(typed.totals.runs).toBe(all.byType.find((r) => r.type === top.type)!.runs);
  });

  test("every byType bucket matches its own type filter", async () => {
    const all = await getUsage("?range=90d");
    expect(all.byType.length).toBeGreaterThan(0);
    for (const bucket of all.byType) {
      const typed = await getUsage(`?range=90d&type=${bucket.type}`);
      expect({ type: bucket.type, runs: typed.totals.runs }).toEqual({ type: bucket.type, runs: bucket.runs });
    }
  });

  test.each(["?range=nope", "?from=2026-13-01", "?type=nope", "?from=2026-09-10&to=2026-09-01"])("%s returns a JSON 400", async (qs) => {
    const res = await get(`/ui/api/usage${qs}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeString();
  });
});

describe("GET /ui/api/usage/export.csv", () => {
  test("downloads the legacy analytics columns for the range", async () => {
    const res = await get("/ui/api/usage/export.csv?from=2026-09-01&to=2026-09-21");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain('filename="usage-2026-09-01-2026-09-21.csv"');
    const lines = (await res.text()).trim().split("\n");
    expect(lines[0]).toBe(
      "session_type,session_id,trigger_name,started_at,ended_at,duration_ms,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,cost_usd,num_turns,is_error,created_at",
    );
    const usage = await getUsage("?from=2026-09-01&to=2026-09-21");
    expect(lines.length - 1).toBe(usage.totals.runs);
  });

  test("status filter (failed, legacy err, ok)", async () => {
    const usage = await getUsage("?range=90d");
    const count = async (status: string) => (await (await get(`/ui/api/usage/export.csv?range=90d&status=${status}`)).text()).trim().split("\n").length - 1;
    expect(await count("failed")).toBe(usage.totals.errors);
    expect(await count("err")).toBe(usage.totals.errors);
    expect(await count("ok")).toBe(usage.totals.runs - usage.totals.errors);
  });

  test("invalid status is a 400", async () => {
    expect((await get("/ui/api/usage/export.csv?status=maybe")).status).toBe(400);
  });
});
