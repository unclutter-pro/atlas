/**
 * Tests for the Bun.serve entrypoint — React frontend, /ui/api/*, and the
 * fallthrough to the legacy Hono app.
 * Run with an isolated HOME: see docs/web-ui.md (dev seed).
 */

import { test, describe, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { createServer } from "./server";
import { spaRoutePatterns, areaForPath } from "./frontend/areas";
import { collectApiRoutes } from "./ui-api";

let server: ReturnType<typeof createServer>;
const get = (path: string) => fetch(new URL(path, server.url), { redirect: "manual" });
const postJson = (path: string, body: unknown = {}) =>
  fetch(new URL(path, server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeAll(() => {
  server = createServer(0);
});

afterAll(() => server.stop(true));

describe("React frontend", () => {
  test("GET / serves the bundled SPA shell", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('<div id="root">');
    expect(html).not.toContain("htmx");
  });

  test("the script bundle referenced by the shell is served", async () => {
    const html = await (await get("/")).text();
    const src = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
    expect(src).toBeDefined();
    const res = await get(src!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  test.each([
    "/activity",
    "/activity/42",
    "/activity/session/abc-123",
    "/automations",
    "/automations/daily-digest",
    "/knowledge",
    "/knowledge/file/projects/atlas.md",
    "/knowledge/journal/2026-09-01",
    "/usage",
    "/settings",
    "/settings/secrets",
  ])("area path %s serves the SPA shell", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });

  test("unknown top-level paths are not served by the SPA", async () => {
    expect((await get("/definitely-not-a-page")).status).toBe(404);
  });
});

describe("area registry", () => {
  test("every area owns base and base/*", () => {
    expect(spaRoutePatterns()).toEqual(
      expect.arrayContaining(["/", "/activity", "/activity/*", "/settings", "/settings/*"]),
    );
    expect(areaForPath("/")?.key).toBe("overview");
    expect(areaForPath("/activity/7")?.key).toBe("activity");
    expect(areaForPath("/activityx")).toBeNull();
    expect(areaForPath("/chat")?.key).toBe("chat");
    expect(areaForPath("/chat/_default")?.key).toBe("chat");
  });

  test("area API routes live under their prefix", () => {
    for (const path of Object.keys(collectApiRoutes())) expect(path.startsWith("/ui/api/")).toBe(true);
  });
});

describe("/ui/api", () => {
  test("GET /ui/api/meta returns the agent name and resolved time zone", async () => {
    const res = await get("/ui/api/meta");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { agentName: string; timeZone: string; timeZoneSource: string };
    expect(data.agentName).toBe(process.env.AGENT_NAME || "Atlas");
    expect(typeof data.timeZone).toBe("string");
    expect(data.timeZone.length).toBeGreaterThan(0);
    expect(["config", "env", "runtime", "default"]).toContain(data.timeZoneSource);
  });

  test("GET /ui/api/overview returns state, attention, running, upcoming and today's totals", async () => {
    const res = await get("/ui/api/overview");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof data.paused).toBe("boolean");
    for (const key of ["failedRuns", "webhookFailures", "integrationsDown", "stuckRuns", "overdueReminders", "invalidSchedules"]) {
      expect(Array.isArray(data.attention[key])).toBe(true);
    }
    expect(Array.isArray(data.running)).toBe(true);
    expect(Array.isArray(data.upcoming)).toBe(true);
    expect(Array.isArray(data.waiting)).toBe(true);
    for (const key of ["runs", "failed", "costUsd", "messages"]) expect(typeof data.totals[key]).toBe("number");
    expect(data.inboxTotal).toBeUndefined();
  });

  test("GET /ui/api/status returns control, running runs and health", async () => {
    const res = await get("/ui/api/status");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.control.paused).toBe("boolean");
    expect(Array.isArray(data.running)).toBe(true);
    for (const r of data.running) {
      expect(typeof r.id).toBe("number");
      expect(typeof r.triggerName).toBe("string");
    }
    const keys = data.integrations.map((i: { key: string }) => i.key);
    expect(keys).toEqual(["signal", "email", "whatsapp", "telegram", "web"]);
    for (const i of data.integrations) {
      expect(["running", "degraded", "stopped", "unknown", "not_configured"]).toContain(i.state);
      if (!i.configured) expect(i.state).toBe("not_configured");
    }
    expect(data.services.map((s: { name: string }) => s.name)).toContain("supercronic");
  });

  test("unknown /ui/api paths return JSON 404", async () => {
    const res = await get("/ui/api/nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBeDefined();
  });

  test("non-GET methods are not routed to GET handlers", async () => {
    const res = await fetch(new URL("/ui/api/meta", server.url), { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("/ui/api/control", () => {
  const marker = () => join(process.env.HOME!, ".atlas-paused");

  test("mutations require a JSON body", async () => {
    const res = await fetch(new URL("/ui/api/control/pause", server.url), { method: "POST" });
    expect(res.status).toBe(415);
  });

  test("stop requires confirm: true", async () => {
    const res = await postJson("/ui/api/control/stop", {});
    expect(res.status).toBe(400);
  });

  test("pause then resume toggles the paused marker", async () => {
    const wasPaused = existsSync(marker());
    try {
      const paused = await postJson("/ui/api/control/pause");
      expect(paused.status).toBe(200);
      expect((await paused.json()).control.paused).toBe(true);
      expect(existsSync(marker())).toBe(true);

      const resumed = await postJson("/ui/api/control/resume");
      expect(resumed.status).toBe(200);
      expect((await resumed.json()).control.paused).toBe(false);
      expect(existsSync(marker())).toBe(false);
    } finally {
      if (wasPaused) await postJson("/ui/api/control/pause");
    }
  });
});

describe("legacy", () => {
  test("GET /healthz still reaches the Hono app", async () => {
    const res = await get("/healthz");
    expect([200, 503]).toContain(res.status);
    expect((await res.json()).status).toBeDefined();
  });

  test.each([
    ["/inbox", "/activity"],
    ["/inbox/12", "/activity/message/12"],
    ["/sessions", "/activity"],
    ["/sessions?trigger=daily-digest", "/activity?trigger=daily-digest"],
    ["/sessions/abc-123", "/activity/session/abc-123"],
    ["/triggers", "/automations"],
    ["/analytics", "/usage"],
    ["/analytics?from=2026-09-01&to=2026-09-07&group_by=day", "/usage?from=2026-09-01&to=2026-09-07"],
    ["/analytics.csv?from=2026-09-01&to=2026-09-07", "/ui/api/usage/export.csv?from=2026-09-01&to=2026-09-07"],
    ["/memory", "/knowledge"],
    ["/memory/search?q=jonas", "/knowledge?q=jonas"],
    ["/memory/view?file=entities/jonas.md", "/knowledge/file/entities/jonas.md"],
    ["/journal", "/knowledge/journal"],
    ["/journal?date=2026-09-01", "/knowledge/journal/2026-09-01"],
    ["/journal?date=../x", "/knowledge/journal"],
  ])("old page %s redirects to %s", async (from, to) => {
    const res = await get(from);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(to);
  });

  test("GET /chat and /chat/:key serve the React shell", async () => {
    for (const path of ["/chat", "/chat/_default", "/chat?session=_default"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain('id="root"');
    }
  });
});
