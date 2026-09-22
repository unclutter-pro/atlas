/**
 * Unix socket the trigger runner pings (lib/web-ui-notify.ts) when a chat
 * changes. Only `POST /notify` with a small, strictly validated JSON body is
 * accepted. Pings are hints: they make the chat hub re-read its sources and
 * never carry data themselves, so the socket (0600) grants nothing beyond
 * "please look again".
 */

import { chmodSync, existsSync, unlinkSync } from "fs";
import { notifySocketPath, parseNotifyEvent } from "../../../lib/web-ui-notify";
import { notifyChat } from "./hub";

const MAX_BODY = 1024;

export async function handleNotify(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== "POST" || url.pathname !== "/notify") return new Response(null, { status: 404 });
  const length = Number(req.headers.get("content-length") ?? NaN);
  if (!Number.isFinite(length) || length > MAX_BODY) return new Response(null, { status: 400 });
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return new Response(null, { status: 400 });
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const event = parseNotifyEvent(body);
  if (!event) return new Response(null, { status: 400 });
  notifyChat(event);
  return new Response(null, { status: 204 });
}

const CURRENT = Symbol.for("atlas.web-ui.chat-notify-server");
type NotifyServer = ReturnType<typeof Bun.serve>;

export function startChatNotifyServer(path = notifySocketPath()): NotifyServer {
  // `bun --hot` re-runs the entrypoint: replace the previous server.
  const g = globalThis as unknown as Record<symbol, NotifyServer | undefined>;
  g[CURRENT]?.stop(true);
  if (existsSync(path)) unlinkSync(path); // stale socket from a previous run
  const server = Bun.serve({ unix: path, fetch: handleNotify });
  chmodSync(path, 0o600);
  g[CURRENT] = server;
  return server;
}
