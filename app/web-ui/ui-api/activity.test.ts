/**
 * Activity API tests. Endpoint tests need the dev seed (they read and write
 * the DB), so they only run when HOME is a seeded workspace:
 *
 *   D=/tmp/atlas-dev-activity; bun dev/seed.ts $D && HOME=$D bun test ui-api/activity.test.ts
 */

// Pin the zone so from/to day-boundary assertions don't depend on the machine's zone.
process.env.ATLAS_TIMEZONE = "UTC";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import type { BunRequest } from "bun";
import { routes, type ActivityListResponse, type MessageDetailResponse, type RunDetailResponse, type SessionDetailResponse } from "./activity";
import { payloadMessageIds, payloadSummary } from "./activity/queries";
import { parseTranscript } from "./activity/transcript";

const seeded = existsSync(join(process.env.HOME ?? "", ".atlas-dev-seed"));

async function call(path: string, params: Record<string, string> = {}): Promise<Response> {
  const url = new URL(path, "http://test");
  const pattern = Object.keys(routes).find((p) => {
    const a = p.split("/");
    const b = url.pathname.split("/");
    return a.length === b.length && a.every((s, i) => s.startsWith(":") || s === b[i]);
  });
  if (!pattern) throw new Error(`no route for ${path}`);
  const req = Object.assign(new Request(url), { params }) as unknown as BunRequest;
  return routes[pattern]!.GET!(req);
}

async function getJson<T>(path: string, params?: Record<string, string>): Promise<{ status: number; body: T }> {
  const res = await call(path, params);
  return { status: res.status, body: (await res.json()) as T };
}

async function all(qs: string, limit: number): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 500; i++) {
    const url: string = `/ui/api/activity?limit=${limit}&${qs}${cursor ? `&cursor=${cursor}` : ""}`;
    const body = (await getJson<ActivityListResponse>(url)).body;
    keys.push(...body.items.map((x) => x.key));
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  return keys;
}

describe("pure helpers", () => {
  test("payloadMessageIds reads signal and JSON inbox ids", () => {
    expect(payloadMessageIds('<signal-message from="+49" inbox-id="12">hi</signal-message>')).toEqual([12]);
    expect(payloadMessageIds(JSON.stringify({ inbox_message_id: 7, message: "x" }))).toEqual([7]);
    expect(payloadMessageIds(null)).toEqual([]);
    expect(payloadMessageIds("no ids here")).toEqual([]);
  });

  test("payloadSummary prefers message/subject, else key: value pairs", () => {
    expect(payloadSummary(JSON.stringify({ message: "hello  there" }))).toBe("hello there");
    expect(payloadSummary(JSON.stringify({ action: "push", ref: "main", nested: { a: 1 } }))).toBe("action: push · ref: main");
    expect(payloadSummary("plain text")).toBe("plain text");
  });

  test("parseTranscript pairs tool calls with their results", () => {
    const lines = [
      { type: "user", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "do it" } },
      { type: "assistant", timestamp: "2026-01-01T00:00:01Z", message: { model: "claude-x", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", timestamp: "2026-01-01T00:00:02Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }] } },
      { type: "assistant", timestamp: "2026-01-01T00:00:03Z", message: { content: [{ type: "text", text: "failed" }] } },
    ];
    const { entries, model } = parseTranscript(lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n");
    expect(model).toBe("claude-x");
    expect(entries.map((e) => e.kind)).toEqual(["user", "tool", "assistant"]);
    const tool = entries[1]!;
    expect(tool.kind === "tool" && tool.result === "boom" && tool.isError).toBe(true);
  });
});

describe.skipIf(!seeded)("GET /ui/api/activity (seeded HOME)", () => {
  test("lists runs, runless sessions and unlinked messages, newest first", async () => {
    const { status, body } = await getJson<ActivityListResponse>("/ui/api/activity?limit=200");
    expect(status).toBe(200);
    const kinds = new Set(body.items.map((i) => i.kind));
    expect(kinds).toEqual(new Set(["run", "session", "message"]));
    const times = body.items.map((i) => Date.parse(i.at!));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(body.items.filter((i) => i.outcome === "running")).toHaveLength(2);
    // Messages that started a run appear as its cause, not on their own.
    for (const m of body.items.filter((i) => i.kind === "message")) expect(["injected", "unhandled"]).toContain(m.outcome);
    const signalRun = body.items.find((i) => i.kind === "run" && i.trigger === "signal-chat" && i.outcome !== "running")!;
    expect(signalRun.cause).toBe("message");
    expect(signalRun.messageId).not.toBeNull();
  });

  test("cursor pagination returns the same events as one big page", async () => {
    for (const qs of ["", "status=failed", "channel=signal", "type=cron", "q=invoice"]) {
      const big = await all(qs, 200);
      const small = await all(qs, 4);
      expect(small).toEqual(big);
    }
  });

  test("filters", async () => {
    const failed = await getJson<ActivityListResponse>("/ui/api/activity?status=failed&limit=200");
    expect(failed.body.items.length).toBeGreaterThan(0);
    for (const i of failed.body.items) {
      expect(i.outcome).toBe("failed");
      expect(i.error).toBeTruthy();
    }
    const direct = await getJson<ActivityListResponse>("/ui/api/activity?type=direct");
    expect(direct.body.items.length).toBe(3);
    expect(direct.body.items.every((i) => i.kind === "session" && i.cause === "direct")).toBe(true);
    const cron = await getJson<ActivityListResponse>("/ui/api/activity?type=cron&limit=200");
    expect(cron.body.items.every((i) => i.cause === "cron")).toBe(true);
    const trig = await getJson<ActivityListResponse>("/ui/api/activity?trigger=dreaming&limit=200");
    expect(trig.body.items.every((i) => i.trigger === "dreaming")).toBe(true);
    const future = await getJson<ActivityListResponse>("/ui/api/activity?from=2999-01-01");
    expect(future.body).toEqual({ items: [], nextCursor: null });
    const today = new Date().toISOString().slice(0, 10);
    const day = await getJson<ActivityListResponse>(`/ui/api/activity?from=${today}&to=${today}&tz=0&limit=200`);
    expect(day.body.items.every((i) => i.at!.startsWith(today))).toBe(true);
  });

  test.each([
    ["status=bogus", 400],
    ["type=bogus", 400],
    ["from=2026-13-40", 400],
    ["to=tomorrow", 400],
    ["cursor=abc", 400],
  ])("rejects %s", async (qs, code) => {
    const { status, body } = await getJson<{ error: string }>(`/ui/api/activity?${qs}`);
    expect(status).toBe(code);
    expect(body.error).toBeTruthy();
  });

  test("filters endpoint lists triggers and channels", async () => {
    const { body } = await getJson<{ triggers: Array<{ name: string }>; channels: string[] }>("/ui/api/activity/filters");
    expect(body.triggers.map((t) => t.name)).toContain("signal-chat");
    expect(body.channels).toEqual(expect.arrayContaining(["signal", "email", "web", "whatsapp"]));
  });
});

describe.skipIf(!seeded)("detail endpoints (seeded HOME)", () => {
  test("run detail: cause message, metrics, transcript with paired tools", async () => {
    const list = await getJson<ActivityListResponse>("/ui/api/activity?trigger=web-chat&status=ok");
    const run = list.body.items[0]!;
    const { status, body } = await getJson<RunDetailResponse>(`/ui/api/activity/runs/${run.runId}`, { id: String(run.runId) });
    expect(status).toBe(200);
    expect(body.cause).toBe("message");
    expect(body.message?.channel).toBe("web");
    expect(body.chatSessionKey).toBe(body.run.sessionKey);
    expect(body.metrics!.inputTokens).toBeGreaterThan(0);
    expect(body.transcript!.entries.some((e) => e.kind === "tool" && e.result != null)).toBe(true);
  });

  test("running run without a session id", async () => {
    const list = await getJson<ActivityListResponse>("/ui/api/activity?status=running");
    const starting = list.body.items.find((i) => !i.sessionId)!;
    const { body } = await getJson<RunDetailResponse>(`/ui/api/activity/runs/${starting.runId}`, { id: String(starting.runId) });
    expect(body.run.outcome).toBe("running");
    expect(body.metrics).toBeNull();
    expect(body.transcript).toBeNull();
    expect(body.run.durationMs).toBeGreaterThan(0);
  });

  test("failed run carries the reason", async () => {
    const list = await getJson<ActivityListResponse>("/ui/api/activity?status=failed");
    const id = String(list.body.items[0]!.runId);
    const { body } = await getJson<RunDetailResponse>(`/ui/api/activity/runs/${id}`, { id });
    expect(body.error).toContain("couldn't finish");
  });

  test("session detail for a direct session", async () => {
    const list = await getJson<ActivityListResponse>("/ui/api/activity?type=direct");
    const sid = list.body.items[0]!.sessionId!;
    const { status, body } = await getJson<SessionDetailResponse>(`/ui/api/activity/sessions/${sid}`, { sessionId: sid });
    expect(status).toBe(200);
    expect(body.sessionType).toBe("direct");
    expect(body.metrics).toHaveLength(1);
    expect(body.runs).toHaveLength(0);
  });

  test("message detail: caused vs unhandled", async () => {
    const list = await getJson<ActivityListResponse>("/ui/api/activity?limit=200");
    const caused = list.body.items.find((i) => i.kind === "run" && i.messageId != null)!;
    const a = await getJson<MessageDetailResponse>(`/ui/api/activity/messages/${caused.messageId}`, { id: String(caused.messageId) });
    expect(a.body.link.mode).toBe("caused");
    expect(a.body.link.run?.id).toBe(caused.runId!);
    const loose = list.body.items.find((i) => i.kind === "message" && i.outcome === "unhandled")!;
    const b = await getJson<MessageDetailResponse>(`/ui/api/activity/messages/${loose.messageId}`, { id: String(loose.messageId) });
    expect(b.body.link).toEqual({ mode: "none", run: null });
    expect(b.body.handler).toBeTruthy();
  });

  test.each([
    ["/ui/api/activity/runs/999999", { id: "999999" }, 404],
    ["/ui/api/activity/runs/abc", { id: "abc" }, 400],
    ["/ui/api/activity/messages/999999", { id: "999999" }, 404],
    ["/ui/api/activity/messages/x", { id: "x" }, 400],
    ["/ui/api/activity/sessions/does-not-exist", { sessionId: "does-not-exist" }, 404],
    ["/ui/api/activity/sessions/x", { sessionId: "../../etc/passwd" }, 400],
    ["/ui/api/activity/attachments/nope", { id: "nope" }, 404],
    ["/ui/api/activity/attachments/x", { id: "../x" }, 400],
  ])("%s -> %d", async (path, params, code) => {
    const res = await call(path, params);
    expect(res.status).toBe(code);
  });
});

describe.skipIf(!seeded)("persistent sessions (seeded HOME)", () => {
  // Two runs share one session_id; each must get its own metrics row.
  const sid = "test-persistent-activity";
  let ids: number[] = [];
  let db: import("bun:sqlite").Database;

  beforeAll(async () => {
    db = (await import("../../lib/atlas-db")).getDb();
    for (const [start, cost, err] of [
      ["2020-01-01 10:00:00", 0.1, 0],
      ["2020-01-01 10:30:00", 0.2, 1],
    ] as const) {
      const r = db
        .query("INSERT INTO trigger_runs (trigger_name, session_key, session_mode, session_id, payload, started_at, completed_at) VALUES ('signal-chat', 'k', 'persistent', ?, 'p', ?, ?) RETURNING id")
        .get(sid, start, start.replace(":00:00", ":01:00").replace(":30:00", ":31:00")) as { id: number };
      ids.push(r.id);
      db.run(
        "INSERT INTO session_metrics (session_type, session_id, trigger_name, started_at, ended_at, duration_ms, cost_usd, is_error) VALUES ('trigger', ?, 'signal-chat', ?, ?, 60000, ?, ?)",
        [sid, start.replace(" ", "T") + "Z", start.replace(" ", "T").replace(":00:00", ":01:00").replace(":30:00", ":31:00") + "Z", cost, err],
      );
    }
  });

  afterAll(() => {
    db.run(`DELETE FROM trigger_runs WHERE session_id = ?`, [sid]);
    db.run(`DELETE FROM session_metrics WHERE session_id = ?`, [sid]);
  });

  test("each run is matched to its own metrics row", async () => {
    const [a, b] = await Promise.all(ids.map((id) => getJson<RunDetailResponse>(`/ui/api/activity/runs/${id}`, { id: String(id) })));
    expect(a!.body.run.costUsd).toBe(0.1);
    expect(a!.body.run.outcome).toBe("ok");
    expect(b!.body.run.costUsd).toBe(0.2);
    expect(b!.body.run.outcome).toBe("failed");
    expect(a!.body.sessionRuns.map((r) => r.id)).toEqual([ids[1]!]);
    const s = await getJson<SessionDetailResponse>(`/ui/api/activity/sessions/${sid}`, { sessionId: sid });
    expect(s.body.totals.runs).toBe(2);
    expect(s.body.totals.costUsd).toBeCloseTo(0.3);
  });
});
