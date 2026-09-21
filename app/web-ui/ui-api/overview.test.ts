/**
 * Overview API: GET /ui/api/overview.
 * Fixture rows are only written when HOME is a dev-seed workspace (bun dev/seed.ts).
 */

// Pin the zone so "today"/day-boundary assertions don't depend on the machine's zone.
process.env.ATLAS_TIMEZONE = "UTC";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import type { BunRequest } from "bun";
import { routes, type OverviewResponse } from "./overview";
import { getOverview, toSqlite } from "./overview/queries";
import { getDb } from "./shared/env";
import { attentionItems, previousDay } from "../frontend/pages/overview/attention";

describe("attention helpers", () => {
  test("previousDay crosses month and year boundaries", () => {
    expect(previousDay("2026-03-01")).toBe("2026-02-28");
    expect(previousDay("2026-01-01")).toBe("2025-12-31");
  });
});

describe("GET /ui/api/overview", () => {
  const call = (qs = "") => routes["/ui/api/overview"]!.GET!(new Request(`http://x/ui/api/overview${qs}`) as BunRequest);

  test("returns every section with ISO timestamps", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const data = (await res.json()) as OverviewResponse;
    expect(data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof data.paused).toBe("boolean");
    expect(Array.isArray(data.running)).toBe(true);
    expect(Array.isArray(data.upcoming)).toBe(true);
    expect(Array.isArray(data.waiting)).toBe(true);
    expect(Object.keys(data.attention).sort()).toEqual(
      ["failedRuns", "failedRunsTotal", "integrationsDown", "invalidSchedules", "overdueReminders", "stuckRuns", "volumesFull", "webhookFailures"].sort(),
    );
    for (const u of data.upcoming) expect(u.at).toMatch(/Z$/);
    for (const r of data.running) if (r.startedAt) expect(r.startedAt).toMatch(/Z$/);
    // Sorted soonest first
    const times = data.upcoming.map((u) => Date.parse(u.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // Secrets never leave the server
    expect(JSON.stringify(data)).not.toContain("whsec_");
  });

  test("?upcoming caps the list and ignores junk", async () => {
    const one = (await (await call("?upcoming=1")).json()) as OverviewResponse;
    expect(one.upcoming.length).toBeLessThanOrEqual(1);
    const junk = await call("?upcoming=abc");
    expect(junk.status).toBe(200);
  });
});

const seeded = existsSync(join(process.env.HOME ?? "", ".atlas-dev-seed"));

describe.skipIf(!seeded)("overview with fixtures (dev-seed HOME only)", () => {
  const TAG = "overview-test";
  const now = new Date();
  const ago = (ms: number) => toSqlite(new Date(now.getTime() - ms));
  const ids = { runs: [] as number[], reminders: [] as number[], webhooks: [] as number[] };
  let data: OverviewResponse;

  beforeAll(() => {
    const db = getDb();
    db.run(
      `INSERT INTO triggers (name, type, description, channel, schedule, prompt, enabled) VALUES
         ('${TAG}-cron', 'cron', 'Test cron', 'internal', '0 0 1 1 *', 'x', 1),
         ('${TAG}-bad', 'cron', 'Bad schedule', 'internal', 'every day', 'x', 1),
         ('${TAG}-off', 'cron', 'Disabled', 'internal', '* * * * *', 'x', 0)`,
    );
    const run = (session: string | null, startedAgo: number, completed: boolean) =>
      (
        db
          .query(`INSERT INTO trigger_runs (trigger_name, session_key, session_id, started_at, completed_at) VALUES (?, '_default', ?, ?, ?) RETURNING id`)
          .get(`${TAG}-cron`, session, ago(startedAgo), completed ? ago(startedAgo - 1000) : null) as { id: number }
      ).id;
    // Stuck: running 30 min, no session yet
    ids.runs.push(run(null, 30 * 60_000, false));
    // Failed 1h ago
    const sid = `${TAG}-${crypto.randomUUID()}`;
    ids.runs.push(run(sid, 3600_000, true));
    db.run(
      `INSERT INTO session_metrics (session_type, session_id, trigger_name, started_at, ended_at, cost_usd, is_error, created_at)
       VALUES ('trigger', ?, ?, ?, ?, 0.5, 1, ?)`,
      [sid, `${TAG}-cron`, new Date(now.getTime() - 3600_000).toISOString(), new Date(now.getTime() - 3599_000).toISOString(), ago(3599_000)],
    );
    const reminder = (title: string, fireAt: string) =>
      (db.query(`INSERT INTO reminders (title, prompt, fire_at, status) VALUES (?, 'x', ?, 'pending') RETURNING id`).get(title, fireAt) as { id: number }).id;
    ids.reminders.push(reminder(`${TAG} overdue`, ago(3600_000)));
    ids.reminders.push(reminder(`${TAG} soon`, toSqlite(new Date(now.getTime() + 60_000))));
    ids.reminders.push(reminder(`${TAG} event`, "9999-12-31 23:59:59"));
    ids.webhooks.push(
      (
        db
          .query(`INSERT INTO webhook_queue (url, payload, secret, attempts, last_error) VALUES ('https://user:pw@hook.example/x', '{}', 's3cret', 6, 'HTTP 500') RETURNING id`)
          .get() as { id: number }
      ).id,
    );
    data = getOverview(now, { upcomingLimit: 50 });
  });

  afterAll(() => {
    const db = getDb();
    db.run(`DELETE FROM triggers WHERE name LIKE '${TAG}-%'`);
    db.run(`DELETE FROM session_metrics WHERE session_id LIKE '${TAG}-%'`);
    for (const id of ids.runs) db.run("DELETE FROM trigger_runs WHERE id = ?", [id]);
    for (const id of ids.reminders) db.run("DELETE FROM reminders WHERE id = ?", [id]);
    for (const id of ids.webhooks) db.run("DELETE FROM webhook_queue WHERE id = ?", [id]);
  });

  test("stuck run without a session", () => {
    const stuck = data.attention.stuckRuns.find((r) => r.id === ids.runs[0]);
    expect(stuck?.stuck).toBe(true);
    expect(data.running.some((r) => r.id === ids.runs[0])).toBe(true);
  });

  test("failed run in the last 24h", () => {
    const failed = data.attention.failedRuns.find((r) => r.id === ids.runs[1]);
    expect(failed).toBeDefined();
    expect(failed!.costUsd).toBe(0.5);
    expect(data.attention.failedRunsTotal).toBeGreaterThanOrEqual(1);
    expect(data.totals.failed).toBeGreaterThanOrEqual(0);
  });

  test("reminders split into upcoming, overdue and waiting", () => {
    expect(data.attention.overdueReminders.some((r) => r.id === ids.reminders[0])).toBe(true);
    expect(data.upcoming.some((u) => u.kind === "reminder" && u.reminderId === ids.reminders[1])).toBe(true);
    expect(data.waiting.some((w) => w.id === ids.reminders[2])).toBe(true);
    expect(data.upcoming.some((u) => u.reminderId === ids.reminders[0] || u.reminderId === ids.reminders[2])).toBe(false);
  });

  test("cron schedules: next fire, invalid flagged, disabled skipped", () => {
    const cron = data.upcoming.find((u) => u.triggerName === `${TAG}-cron`);
    const jan1 = new Date(now.getFullYear() + 1, 0, 1);
    expect(cron && Date.parse(cron.at)).toBe(jan1.getTime());
    expect(data.attention.invalidSchedules).toContainEqual({ triggerName: `${TAG}-bad`, schedule: "every day" });
    expect(data.upcoming.some((u) => u.triggerName === `${TAG}-off`)).toBe(false);
  });

  test("webhook failures hide credentials and flag give-ups", () => {
    const w = data.attention.webhookFailures.find((x) => x.id === ids.webhooks[0]);
    expect(w?.gaveUp).toBe(true);
    expect(w?.url).toBe("https://hook.example/x");
    expect(JSON.stringify(data)).not.toContain("s3cret");
  });

  test("attentionItems links every item", () => {
    const items = attentionItems(data, now.getTime());
    expect(items.find((i) => i.key === `stuck-${ids.runs[0]}`)?.href).toBe(`/activity/${ids.runs[0]}`);
    expect(items.find((i) => i.key === `failed-${ids.runs[1]}`)?.href).toBe(`/activity/${ids.runs[1]}`);
    expect(items.find((i) => i.key === `schedule-${TAG}-bad`)?.href).toBe(`/automations/${TAG}-bad`);
    expect(items.find((i) => i.key === `overdue-${ids.reminders[0]}`)?.href).toBe("/automations?view=reminders");
  });
});

describe("overview: full volumes", () => {
  test("getOverview passes nearly-full volumes through to attention", async () => {
    const { getOverview } = await import("./overview/queries");
    const full = [{ label: "Workspace", path: "/home/agent", usedPercent: 93.4, freeBytes: 1024, status: "error" as const }];
    expect(getOverview(new Date(), { volumesFull: full }).attention.volumesFull).toEqual(full);
    expect(getOverview(new Date()).attention.volumesFull).toEqual([]);
  });
});
