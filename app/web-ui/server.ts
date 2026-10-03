/**
 * Web-UI entrypoint: native Bun.serve.
 *
 * - React frontend (frontend/) is bundled by Bun via the HTML import and
 *   served on every area path (frontend/areas.ts).
 * - /ui/api/* are native route handlers (ui-api/).
 * - Old server-rendered page URLs redirect to the area that replaced them.
 * - Everything else falls through to the legacy Hono app in index.ts
 *   (/api/v1/*, /api/webhook/:name, /healthz).
 * - Unknown hostnames are refused on /ui/api (and on /api/v1 without an API
 *   key) as a DNS-rebinding guard (ui-api/shared/host.ts).
 * - A Unix socket (~/.index/web-ui.sock) receives chat pings from the
 *   trigger runner (ui-api/chat/notify-server.ts).
 */

import frontend from "./frontend/index.html";
import { spaRoutePatterns } from "./frontend/areas";
import { app as legacyApp } from "./index";
import { apiRoutes } from "./ui-api";
import { hostRejection } from "./ui-api/shared/host";
import { startChatNotifyServer } from "./ui-api/chat/notify-server";
import { applyProcessTimeZone } from "../lib/timezone";

/**
 * Old server-rendered pages → the area that replaced them, keeping the object
 * a bookmark pointed at where there is one.
 */
type LegacyRedirect = (url: URL, params: Record<string, string>) => string;
const enc = encodeURIComponent;
const withSearch = (path: string, q: URLSearchParams) => (q.size ? `${path}?${q}` : path);
const pick = (q: URLSearchParams, keys: string[]) => {
  const out = new URLSearchParams();
  for (const k of keys) if (q.get(k)) out.set(k, q.get(k)!);
  return out;
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const LEGACY_REDIRECTS: Record<string, LegacyRedirect> = {
  "/inbox": () => "/activity",
  "/inbox/:id": (_, p) => `/activity/message/${enc(p.id!)}`,
  "/sessions": (u) => withSearch("/activity", pick(u.searchParams, ["trigger"])),
  "/sessions/:sessionId": (_, p) => `/activity/session/${enc(p.sessionId!)}`,
  "/triggers": () => "/automations",
  "/analytics": (u) => withSearch("/usage", pick(u.searchParams, ["from", "to", "trigger"])),
  "/analytics.csv": (u) => withSearch("/ui/api/usage/export.csv", pick(u.searchParams, ["from", "to", "trigger", "status"])),
  "/memory": () => "/knowledge",
  "/memory/search": (u) => withSearch("/knowledge", pick(u.searchParams, ["q"])),
  "/memory/view": (u) => {
    const file = u.searchParams.get("file");
    return file ? `/knowledge/file/${file.split("/").map(enc).join("/")}` : "/knowledge";
  },
  "/journal": (u) => {
    const date = u.searchParams.get("date");
    return date && DATE.test(date) ? `/knowledge/journal/${date}` : "/knowledge/journal";
  },
};

export function createServer(port: number) {
  return Bun.serve({
    port,
    development: process.env.NODE_ENV === "development",
    routes: {
      ...Object.fromEntries(spaRoutePatterns().map((path) => [path, frontend])),
      ...Object.fromEntries(
        Object.entries(LEGACY_REDIRECTS).map(([from, to]) => [
          from,
          {
            // Relative Location: correct behind the nginx proxy whatever the public scheme/host.
            GET: (req: Request & { params: Record<string, string> }) =>
              new Response(null, { status: 302, headers: { Location: to(new URL(req.url), req.params) } }),
          },
        ]),
      ),
      ...apiRoutes,
    },
    fetch: (req) => {
      // /api/v1 is open when ATLAS_API_KEY is unset: apply the DNS-rebinding
      // guard then (with a key, the key protects it and any hostname works).
      if (!process.env.ATLAS_API_KEY && new URL(req.url).pathname.startsWith("/api/v1/")) {
        const badHost = hostRejection(req);
        if (badHost) return Response.json({ error: badHost }, { status: 421 });
      }
      return legacyApp.fetch(req);
    },
  });
}

if (import.meta.main) {
  // Set ambient TZ once at startup so anything reading the process zone
  // (cron.ts's nextRuns without an explicit zone, log timestamps) agrees
  // with the zone ui-api computes explicitly via resolveTimezone().
  const tz = applyProcessTimeZone();
  if (tz.invalid) console.warn(`[timezone] Invalid "${tz.invalid}" (source: ${tz.source}) — using ${tz.timeZone}.`);
  const server = createServer(Number(process.env.PORT) || 3000);
  // Runner → web-ui pings for the live chat. Without it chat streams fall
  // back to watching the transcript plus the run-state safety net.
  try {
    startChatNotifyServer();
  } catch (err) {
    console.warn(`[chat] notify socket not started (${(err as Error).message}); live chat updates degrade to file watching`);
  }
  console.log(`${process.env.AGENT_NAME || "Atlas"} Web-UI running on ${server.url} (zone: ${tz.timeZone}, source: ${tz.source})`);
}
