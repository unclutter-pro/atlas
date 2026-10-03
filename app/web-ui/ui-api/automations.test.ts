/**
 * Tests for /ui/api/automations/* and the cron helpers.
 * Run with a seeded HOME (bun dev/seed.ts <dir>); endpoint tests that write
 * to the DB are skipped unless HOME looks like a dev seed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { routes } from "./automations";
import { getDb } from "./shared/env";
import { describeCron, nextRuns, parseCron } from "./shared/cron";
import { validateTriggerInput } from "./automations/validate";

const HOME = process.env.HOME!;
const seeded = existsSync(join(HOME, ".dev")) && existsSync(join(HOME, ".index", "atlas.db"));

describe("cron helpers", () => {
  const spec = (expr: string) => {
    const p = parseCron(expr);
    if (!p.ok) throw new Error(p.error);
    return p.spec;
  };

  test.each([
    ["0 7 * * *", "Every day at 07:00"],
    ["*/30 * * * *", "Every 30 minutes"],
    ["0 9 * * 1-5", "Weekdays at 09:00"],
    ["0 9 * * 1", "Every Monday at 09:00"],
    ["15 * * * *", "Every hour at :15"],
    ["0 */2 * * *", "Every 2 hours at :00"],
    ["0 8,20 * * *", "Every day at 08:00 and 20:00"],
    ["0 9 1 * *", "On the 1st of every month at 09:00"],
    ["*/15 9-17 * * 1-5", "Every 15 minutes from 09:00 to 17:59 on weekdays"],
    ["0 10 * * 0,6", "Weekends at 10:00"],
    ["0 9 * * 7", "Every Sunday at 09:00"],
  ])("describes %s", (expr, text) => {
    expect(describeCron(spec(expr))).toBe(text);
  });

  test.each([
    ["", "required"],
    ["@daily", "no names"],
    ["0 9 * * MON", "no names"],
    ["0 9 * *", "Expected 5 fields"],
    ["60 * * * *", "minute must be between"],
    ["0 9 * 13 *", "month must be between"],
    ["5-1 * * * *", "invalid minute range"],
    ["*/0 * * * *", "step must be at least 1"],
  ])("rejects %p", (expr, msg) => {
    const p = parseCron(expr);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toContain(msg);
  });

  test("next runs are strictly after `from`, in local time", () => {
    const from = new Date(2026, 0, 5, 9, 0, 0); // Monday 09:00 local
    const runs = nextRuns(spec("0 9 * * 1-5"), 3, from);
    expect(runs.map((d) => [d.getDate(), d.getHours(), d.getMinutes()])).toEqual([
      [6, 9, 0],
      [7, 9, 0],
      [8, 9, 0],
    ]);
  });

  test("day-of-month and day-of-week restricted together match either (vixie cron)", () => {
    const from = new Date(2026, 0, 1, 0, 0, 0); // Thu Jan 1
    const runs = nextRuns(spec("0 0 13 * 5"), 3, from); // the 13th or any Friday
    expect(runs.map((d) => d.getDate())).toEqual([2, 9, 13]);
  });

  test("validation mirrors triggers/manage.ts", () => {
    expect(validateTriggerInput({ name: "ok_name-1", type: "manual" }, "create")).toEqual({});
    expect(validateTriggerInput({ name: "Nope", type: "manual" }, "create").name).toBeDefined();
    expect(validateTriggerInput({ name: "x", type: "cron" }, "create").schedule).toBeDefined();
    expect(validateTriggerInput({ modelKey: "bad key" }, "update", "manual").modelKey).toBeDefined();
    expect(validateTriggerInput({ webhookSecret: "has space" }, "update", "webhook").webhookSecret).toBeDefined();
    // Schedule only matters for cron triggers.
    expect(validateTriggerInput({ schedule: "garbage" }, "update", "manual")).toEqual({});
  });
});

describe.skipIf(!seeded)("/ui/api/automations endpoints", () => {
  let server: ReturnType<typeof Bun.serve>;
  const NAME = `ui-test-${process.pid}`;
  const url = (p: string) => new URL(p, server.url);
  const get = (p: string) => fetch(url(p));
  const send = (method: string, p: string, body: unknown = {}) =>
    fetch(url(p), { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  beforeAll(() => {
    server = Bun.serve({ port: 0, routes });
  });

  afterAll(async () => {
    await send("DELETE", `/ui/api/automations/triggers/${NAME}`);
    await send("DELETE", `/ui/api/automations/triggers/${NAME}-cron`);
    rmSync(join(HOME, "triggers", NAME), { recursive: true, force: true });
    rmSync(join(HOME, "triggers", `${NAME}-cron`), { recursive: true, force: true });
    rmSync(join(HOME, ".atlas-paused"), { force: true });
    server.stop(true);
  });

  test("list groups every trigger with last run, schedule text and 7-day stats", async () => {
    const res = await get("/ui/api/automations");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.triggers.length).toBeGreaterThan(0);
    const digest = body.triggers.find((t: any) => t.name === "daily-digest");
    expect(digest.schedule).toMatchObject({ expr: "0 7 * * *", valid: true, text: "Every day at 07:00" });
    expect(digest.nextRunAt).toMatch(/Z$/);
    const hook = body.triggers.find((t: any) => t.type === "webhook");
    expect(hook.webhookPath).toBe(`/api/webhook/${hook.name}`);
    const disabled = body.triggers.find((t: any) => !t.enabled && t.type === "cron");
    if (disabled) expect(disabled.nextRunAt).toBeNull();
    expect(typeof body.reminders.pending).toBe("number");
  });

  test("unknown trigger → 404, mutations without JSON → 415", async () => {
    expect((await get("/ui/api/automations/triggers/does-not-exist")).status).toBe(404);
    expect((await get("/ui/api/automations/triggers/Bad%20Name")).status).toBe(404);
    const res = await fetch(url("/ui/api/automations/triggers"), { method: "POST", body: "name=x" });
    expect(res.status).toBe(415);
  });

  test("create validates input and rejects duplicates", async () => {
    let res = await send("POST", "/ui/api/automations/triggers", { name: "Bad Name", type: "manual" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toStartWith("name:");
    res = await send("POST", "/ui/api/automations/triggers", { name: `${NAME}-cron`, type: "cron", schedule: "0 25 * * *" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("hour");
    res = await send("POST", "/ui/api/automations/triggers", { name: "daily-digest", type: "manual" });
    expect(res.status).toBe(409);
  });

  test("webhook trigger lifecycle: create, secret, edit, toggle, run guards, delete", async () => {
    let res = await send("POST", "/ui/api/automations/triggers", {
      name: NAME,
      type: "webhook",
      description: "test",
      prompt: "Got {{payload}}",
      webhookSecret: "topsecret",
      sessionMode: "persistent",
    });
    expect(res.status).toBe(201);
    let t = await res.json();
    expect(t.webhook).toMatchObject({ path: `/api/webhook/${NAME}`, hasSecret: true });
    expect(t.webhook.secretMasked).not.toContain("topsecret");
    expect(t.promptSource).toBe("file");
    // Same convention as the CLI: prompt in ~/triggers/<name>/prompt.md.
    expect(readFileSync(join(HOME, "triggers", NAME, "prompt.md"), "utf8")).toBe("Got {{payload}}");

    res = await send("POST", `/ui/api/automations/triggers/${NAME}/secret`);
    expect(await res.json()).toEqual({ secret: "topsecret" });

    res = await send("PUT", `/ui/api/automations/triggers/${NAME}`, { prompt: "Updated", webhookSecret: null, description: "changed" });
    expect(res.status).toBe(200);
    t = await res.json();
    expect(t.description).toBe("changed");
    expect(t.webhook.hasSecret).toBe(false);
    expect(readFileSync(join(HOME, "triggers", NAME, "prompt.md"), "utf8")).toBe("Updated");

    res = await send("PUT", `/ui/api/automations/triggers/${NAME}`, { type: "cron" });
    expect(res.status).toBe(400);

    res = await send("POST", `/ui/api/automations/triggers/${NAME}/toggle`, { enabled: false });
    expect(await res.json()).toMatchObject({ enabled: false });
    res = await send("POST", `/ui/api/automations/triggers/${NAME}/run`, {});
    expect(res.status).toBe(409);
    res = await send("POST", `/ui/api/automations/triggers/${NAME}/toggle`);
    expect(await res.json()).toMatchObject({ enabled: true });

    writeFileSync(join(HOME, ".atlas-paused"), "");
    res = await send("POST", `/ui/api/automations/triggers/${NAME}/run`, { payload: "x" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("paused");
    rmSync(join(HOME, ".atlas-paused"));

    res = await send("POST", `/ui/api/automations/triggers/${NAME}/run`, { payload: "x" });
    expect(res.status).toBe(503);

    res = await send("DELETE", `/ui/api/automations/triggers/${NAME}`);
    expect(res.status).toBe(200);
    expect((await get(`/ui/api/automations/triggers/${NAME}`)).status).toBe(404);
  });

  test("cron trigger: schedule preview, next runs, update schedule", async () => {
    let res = await send("POST", "/ui/api/automations/triggers", { name: `${NAME}-cron`, type: "cron", schedule: "0  7 * * *", enabled: true });
    expect(res.status).toBe(201);
    let t = await res.json();
    expect(t.schedule.expr).toBe("0 7 * * *");
    expect(t.nextRuns.length).toBe(5);
    res = await send("PUT", `/ui/api/automations/triggers/${NAME}-cron`, { schedule: "*/15 * * * *" });
    t = await res.json();
    expect(t.schedule.text).toBe("Every 15 minutes");
    res = await send("PUT", `/ui/api/automations/triggers/${NAME}-cron`, { schedule: "" });
    expect(res.status).toBe(400);

    res = await get("/ui/api/automations/cron?expr=" + encodeURIComponent("0 9 * * 1-5"));
    expect(await res.json()).toMatchObject({ valid: true, text: "Weekdays at 09:00" });
    res = await get("/ui/api/automations/cron?expr=nope");
    expect(await res.json()).toMatchObject({ valid: false, next: [] });
  });

  test("detail and run history link runs to metrics", async () => {
    const list = await (await get("/ui/api/automations")).json();
    const withRuns = list.triggers.find((t: any) => t.runCount > 1)!;
    const detail = await (await get(`/ui/api/automations/triggers/${withRuns.name}`)).json();
    expect(detail.stats.d7).toHaveProperty("costUsd");
    expect(detail.model).toHaveProperty("model");
    const runs = await (await get(`/ui/api/automations/triggers/${withRuns.name}/runs?pageSize=2`)).json();
    expect(runs.items.length).toBeLessThanOrEqual(2);
    expect(runs.total).toBeGreaterThanOrEqual(runs.items.length);
    for (const r of runs.items) expect(["ok", "failed", "running"]).toContain(r.status);
  });

  test("reminders: pending first, cancel only pending", async () => {
    const res = await get("/ui/api/automations/reminders");
    const body = await res.json();
    const statuses = body.items.map((r: any) => r.status);
    const firstDone = statuses.findIndex((s: string) => s !== "pending");
    if (firstDone >= 0) expect(statuses.slice(firstDone)).not.toContain("pending");
    const event = body.items.find((r: any) => r.status === "pending" && r.fireAt === null);
    if (event) expect(event.triggerType).not.toBe("time");

    const pending = body.items.find((r: any) => r.status === "pending");
    if (pending) {
      const r = await send("POST", `/ui/api/automations/reminders/${pending.id}/cancel`);
      expect(await r.json()).toMatchObject({ ok: true, status: "cancelled" });
      getDb().query("UPDATE reminders SET status = 'pending' WHERE id = ?").run(pending.id);
    }

    const done = body.items.find((r: any) => r.status !== "pending");
    if (done) expect((await send("POST", `/ui/api/automations/reminders/${done.id}/cancel`)).status).toBe(409);
    expect((await send("POST", "/ui/api/automations/reminders/999999/cancel")).status).toBe(404);
    expect((await send("POST", "/ui/api/automations/reminders/abc/cancel")).status).toBe(404);
  });
});
