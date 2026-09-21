/**
 * /ui/api/chat/* endpoints. DB-backed, so they need a seeded HOME:
 *
 *   D=/tmp/atlas-dev-chat; bun dev/seed.ts $D && HOME=$D bun test ui-api/chat
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { BunRequest } from "bun";
import { getLockPath } from "../../lib/trigger-socket";
import { routes } from "./chat";
import { deriveRunState, hubDeps, hubTiming, notifyChat } from "./chat/hub";
import { heartbeatState } from "./chat/sse";
import { sttDeps } from "./chat/stt";
import {
  appendTranscript,
  assistantLine,
  cleanupChat,
  insertChunks,
  makeChat,
  resetHubs,
  seeded,
  sleep,
  sseReader,
  writeTranscript,
} from "./chat/test-helpers";
import {
  MAX_VOICE_BYTES,
  UI_CLIENT_HEADER,
  UI_CLIENT_HEADER_VALUE,
  type ChatSessionsResponse,
  type ChatSnapshot,
  type CreateChatSessionResponse,
  type SendChatMessageResponse,
  type UpdateChatSessionResponse,
} from "./chat/types";
import { getDb, home } from "./shared/env";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

function call(method: Method, path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(path, "http://localhost");
  let params: Record<string, string> = {};
  const pattern = Object.keys(routes).find((p) => {
    const a = p.split("/");
    const b = url.pathname.split("/");
    if (a.length !== b.length) return false;
    const found: Record<string, string> = {};
    const ok = a.every((s, i) => (s.startsWith(":") ? ((found[s.slice(1)] = decodeURIComponent(b[i]!)), true) : s === b[i]));
    if (ok) params = found;
    return ok;
  });
  if (!pattern) throw new Error(`no route for ${path}`);
  const fn = routes[pattern]![method];
  if (!fn) throw new Error(`no ${method} for ${pattern}`);
  const req = Object.assign(new Request(url, { method, ...init }), { params }) as unknown as BunRequest;
  return Promise.resolve(fn(req));
}

const jsonInit = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

async function body<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function voiceForm(opts: { name?: string; type?: string; bytes?: number; message?: string; clientId?: string } = {}): FormData {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(opts.bytes ?? 16)], opts.name ?? "voice.webm", { type: opts.type ?? "audio/webm" }));
  if (opts.message !== undefined) form.append("message", opts.message);
  if (opts.clientId) form.append("clientId", opts.clientId);
  return form;
}

describe.skipIf(!seeded)("/ui/api/chat", () => {
  const created: string[] = [];
  let chat: ReturnType<typeof makeChat>;
  const origTranscribe = sttDeps.transcribe;

  beforeEach(() => {
    resetHubs();
    hubTiming.flushMs = 10;
    chat = makeChat({ title: "Test chat" });
  });

  afterEach(() => {
    resetHubs();
    sttDeps.transcribe = origTranscribe;
    cleanupChat(chat.key, chat.sid);
    for (const k of created.splice(0)) cleanupChat(k);
    rmSync(join(home(), ".atlas-paused"), { force: true });
  });

  afterAll(() => resetHubs());

  test("create, list (sorted, search, archived filter), get, rename, archive", async () => {
    const res = await call("POST", "/ui/api/chat/sessions", jsonInit({ title: "  Fresh idea  " }));
    expect(res.status).toBe(201);
    const { session } = await body<CreateChatSessionResponse>(res);
    created.push(session.key);
    expect(session).toMatchObject({ title: "Fresh idea", messageCount: 0, preview: null, sessionId: null, isDefault: false, archivedAt: null });
    expect(session.key).toMatch(/^[0-9a-f-]{36}$/);

    // A message makes chat newest by activity and searchable by content.
    getDb().prepare("UPDATE chat_sessions SET created_at = datetime('now', '-1 minute') WHERE session_key = ?").run(session.key);
    const sent = await call("POST", `/ui/api/chat/sessions/${chat.key}/messages`, jsonInit({ content: "Needle   in the\nhaystack" }));
    expect(sent.status).toBe(201);

    const list = await body<ChatSessionsResponse>(await call("GET", "/ui/api/chat/sessions"));
    const keys = list.sessions.map((s) => s.key);
    expect(keys.indexOf(chat.key)).toBeLessThan(keys.indexOf(session.key));
    const mine = list.sessions.find((s) => s.key === chat.key)!;
    expect(mine).toMatchObject({ messageCount: 1, preview: "Needle in the haystack", sessionId: chat.sid });
    for (let i = 1; i < list.sessions.length; i++) expect(list.sessions[i - 1]!.lastActivityAt >= list.sessions[i]!.lastActivityAt).toBe(true);

    const search = await body<ChatSessionsResponse>(await call("GET", "/ui/api/chat/sessions?q=NEEDLE"));
    expect(search.sessions.map((s) => s.key)).toEqual([chat.key]);
    const byTitle = await body<ChatSessionsResponse>(await call("GET", "/ui/api/chat/sessions?q=fresh%20idea"));
    expect(byTitle.sessions.map((s) => s.key)).toEqual([session.key]);
    const escaped = await body<ChatSessionsResponse>(await call("GET", "/ui/api/chat/sessions?q=%25"));
    expect(escaped.sessions.map((s) => s.key)).not.toContain(chat.key);

    const renamed = await call("PATCH", `/ui/api/chat/sessions/${session.key}`, jsonInit({ title: "Renamed", archived: true }));
    expect(renamed.status).toBe(200);
    const r = await body<UpdateChatSessionResponse>(renamed);
    expect(r.session).toMatchObject({ title: "Renamed", stats: null });
    expect(r.session.archivedAt).toMatch(/Z$/);
    const excluded = await body<ChatSessionsResponse>(await call("GET", "/ui/api/chat/sessions"));
    expect(excluded.sessions.map((s) => s.key)).not.toContain(session.key);
    const only = await body<ChatSessionsResponse>(await call("GET", "/ui/api/chat/sessions?archived=only"));
    expect(only.sessions.every((s) => s.archivedAt)).toBe(true);
    expect(only.sessions.map((s) => s.key)).toContain(session.key);

    // Fresh message, nothing answered it: "starting", but only when a runner can start at all.
    const derive = () => deriveRunState(chat.key, { file: null, answeredAfter: () => false });
    const runnerAvailable = hubDeps.runnerAvailable;
    try {
      hubDeps.runnerAvailable = () => false;
      expect(derive()).toBe("idle");
      hubDeps.runnerAvailable = () => true;
      expect(derive()).toBe("starting");
      const snap = await body<ChatSnapshot>(await call("GET", `/ui/api/chat/sessions/${chat.key}`));
      expect(snap.session).toMatchObject({ key: chat.key, title: "Test chat", sessionId: chat.sid, stats: { costUsd: 0, runs: 0 } });
      expect(snap.items.map((i) => i.kind)).toEqual(["user"]);
      expect(snap.run.state).toBe("starting");
    } finally {
      hubDeps.runnerAvailable = runnerAvailable;
    }
  });

  test("validation: bad keys, unknown chats, _default rules, JSON-only mutations", async () => {
    expect((await call("GET", "/ui/api/chat/sessions/bad%20key")).status).toBe(400);
    expect((await call("GET", "/ui/api/chat/sessions/does-not-exist")).status).toBe(404);
    expect((await call("GET", "/ui/api/chat/sessions/_default")).status).toBe(200);
    expect((await call("PATCH", "/ui/api/chat/sessions/does-not-exist", jsonInit({ title: "x" }))).status).toBe(404);
    expect((await call("PATCH", "/ui/api/chat/sessions/_default", jsonInit({ archived: true }))).status).toBe(400);
    expect((await call("PATCH", `/ui/api/chat/sessions/${chat.key}`, jsonInit({ title: 5 }))).status).toBe(400);
    expect((await call("DELETE", "/ui/api/chat/sessions/_default", jsonInit({}))).status).toBe(400);
    expect((await call("DELETE", "/ui/api/chat/sessions/does-not-exist", jsonInit({}))).status).toBe(404);
    const form = await call("POST", `/ui/api/chat/sessions/${chat.key}/messages`, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "content=hi",
    });
    expect(form.status).toBe(415);
    const cross = await call("POST", "/ui/api/chat/sessions", jsonInit({}, { Origin: "https://evil.example" }));
    expect(cross.status).toBe(403);
  });

  test("a chat with web messages but no row is created on first read", async () => {
    const key = `orphan-${Date.now()}`;
    created.push(key);
    getDb().prepare("INSERT INTO messages (channel, sender, content, session_key) VALUES ('web', 'web-ui', 'hi', ?)").run(key);
    const snap = await body<ChatSnapshot>(await call("GET", `/ui/api/chat/sessions/${key}`));
    expect(snap.session).toMatchObject({ key, title: null, messageCount: 1 });
  });

  test("send: 201 item with clientId; paused → 409, archived → 409, empty → 400 (in that order)", async () => {
    const res = await call("POST", `/ui/api/chat/sessions/${chat.key}/messages`, jsonInit({ content: "  hello  ", clientId: "c-1" }));
    expect(res.status).toBe(201);
    const sent = await body<SendChatMessageResponse>(res);
    expect(sent.item).toMatchObject({ kind: "user", text: "hello", clientId: "c-1", attachments: [] });
    expect(sent.item.id).toBe(`u:${sent.item.messageId}`);
    expect(sent.triggered).toBe(false); // no trigger.sh outside the container

    getDb().prepare("UPDATE chat_sessions SET archived_at = datetime('now') WHERE session_key = ?").run(chat.key);
    writeFileSync(join(home(), ".atlas-paused"), "test");
    const paused = await call("POST", `/ui/api/chat/sessions/${chat.key}/messages`, jsonInit({ content: "" }));
    expect(paused.status).toBe(409);
    expect(await body<unknown>(paused)).toEqual({ error: "Atlas is paused" });
    rmSync(join(home(), ".atlas-paused"));
    const archived = await call("POST", `/ui/api/chat/sessions/${chat.key}/messages`, jsonInit({ content: "" }));
    expect(archived.status).toBe(409);
    expect(await body<unknown>(archived)).toEqual({ error: "Chat is archived" });
    getDb().prepare("UPDATE chat_sessions SET archived_at = NULL WHERE session_key = ?").run(chat.key);
    expect((await call("POST", `/ui/api/chat/sessions/${chat.key}/messages`, jsonInit({ content: "   " }))).status).toBe(400);
    expect((await call("POST", `/ui/api/chat/sessions/${chat.key}/messages`, jsonInit({ content: 1 }))).status).toBe(400);
  });

  test("voice: multipart needs the UI header; STT result or fallback text; 413 over the cap", async () => {
    const url = `/ui/api/chat/sessions/${chat.key}/messages`;
    expect((await call("POST", url, { body: voiceForm() })).status).toBe(403);
    expect((await call("POST", url, { body: voiceForm(), headers: { [UI_CLIENT_HEADER]: UI_CLIENT_HEADER_VALUE, "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);

    const ui = { [UI_CLIENT_HEADER]: UI_CLIENT_HEADER_VALUE };
    sttDeps.transcribe = async () => "transcribed words";
    const ok = await call("POST", url, { body: voiceForm({ clientId: "v-1" }), headers: ui });
    expect(ok.status).toBe(201);
    const sent = await body<SendChatMessageResponse>(ok);
    expect(sent.item).toMatchObject({ text: "transcribed words", clientId: "v-1" });
    expect(sent.item.attachments[0]).toMatchObject({ fileName: "voice.webm", kind: "audio", mimeType: expect.stringMatching(/^audio\//), transcription: "transcribed words", url: expect.stringMatching(/^\/ui\/api\/activity\/attachments\//) });

    sttDeps.transcribe = async () => null;
    const failed = await body<SendChatMessageResponse>(await call("POST", url, { body: voiceForm(), headers: ui }));
    expect(failed.item.text).toBe("(Voice message, transcription failed)");
    const captioned = await body<SendChatMessageResponse>(await call("POST", url, { body: voiceForm({ message: "my caption" }), headers: ui }));
    expect(captioned.item.text).toBe("my caption");

    expect((await call("POST", url, { body: voiceForm({ name: "doc.pdf", type: "application/pdf" }), headers: ui })).status).toBe(400);
    const two = voiceForm();
    two.append("file", new File([new Uint8Array(4)], "b.webm", { type: "audio/webm" }));
    expect((await call("POST", url, { body: two, headers: ui })).status).toBe(400);
    const big = await call("POST", url, { body: voiceForm(), headers: { ...ui, "Content-Length": String(MAX_VOICE_BYTES + 1) } });
    expect(big.status).toBe(413);
  });

  test("stop: not_running while idle, unreachable without a control socket", async () => {
    const idle = await call("POST", `/ui/api/chat/sessions/${chat.key}/stop`, jsonInit({}));
    expect(await body<unknown>(idle)).toEqual({ stopped: false, reason: "not_running" });
    const lock = getLockPath("web-chat", chat.key);
    writeFileSync(lock, String(process.pid));
    try {
      const res = await call("POST", `/ui/api/chat/sessions/${chat.key}/stop`, jsonInit({}));
      expect(await body<unknown>(res)).toEqual({ stopped: false, reason: "unreachable" });
      // ...and a running chat can't be deleted.
      const del = await call("DELETE", `/ui/api/chat/sessions/${chat.key}`, jsonInit({}));
      expect(del.status).toBe(409);
      expect(await body<unknown>(del)).toEqual({ error: "Stop the current turn first" });
    } finally {
      rmSync(lock, { force: true });
    }
  });

  test("stream: headers, retry + snapshot first, live events, session_deleted closes it", async () => {
    writeTranscript(chat.sid, []);
    expect((await call("GET", "/ui/api/chat/sessions/does-not-exist/stream")).status).toBe(404);

    const res = await call("GET", `/ui/api/chat/sessions/${chat.key}/stream`);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const s = sseReader(res.body!);
    const snap = (await s.next("snapshot")) as ChatSnapshot;
    expect(s.raw[0]).toBe("retry: 2000");
    expect(snap.session.key).toBe(chat.key);
    expect(heartbeatState()).toEqual({ streams: 1, running: true });

    await call("POST", `/ui/api/chat/sessions/${chat.key}/messages`, jsonInit({ content: "hi there", clientId: "cid" }));
    expect((await s.next("item")).item).toMatchObject({ kind: "user", text: "hi there", clientId: "cid" });
    expect(await s.next("session")).toMatchObject({ key: chat.key, messageCount: 1 });

    const ping = (kind: "turn_start" | "chunk" | "message" | "turn_end") => notifyChat({ v: 1, trigger: "web-chat", sessionKey: chat.key, sessionId: chat.sid, kind });
    ping("turn_start");
    expect(await s.next("run")).toMatchObject({ state: "running", canStop: false });
    insertChunks(chat.sid, "m1", ["Hel", "lo", "!"]);
    ping("chunk");
    expect(await s.next("delta")).toEqual({ streamId: "m1", text: "Hello!" });
    appendTranscript(chat.sid, [assistantLine({ uuid: "l1", streamId: "m1", blocks: [{ type: "text", text: "Hello!" }] })]);
    ping("message");
    expect((await s.next("item")).item).toMatchObject({ kind: "assistant", streamId: "m1", text: "Hello!" });
    ping("turn_end");
    expect(await s.next("run")).toEqual({ state: "idle", since: null, canStop: false });

    // Deleting from "another tab" closes the stream.
    expect((await call("DELETE", `/ui/api/chat/sessions/${chat.key}`, jsonInit({}))).status).toBe(200);
    expect(await s.next("session_deleted")).toEqual({ key: chat.key });
    await s.untilClosed(1000);
    await sleep(10);
    expect(heartbeatState()).toEqual({ streams: 0, running: false });
    expect(getDb().query("SELECT 1 FROM chat_sessions WHERE session_key = ?").get(chat.key)).toBeNull();
  });

  test("closing a stream unsubscribes and stops the heartbeat", async () => {
    const res = await call("GET", `/ui/api/chat/sessions/${chat.key}/stream`);
    const s = sseReader(res.body!);
    await s.next("snapshot");
    expect(heartbeatState().streams).toBe(1);
    await s.cancel();
    await sleep(10);
    expect(heartbeatState()).toEqual({ streams: 0, running: false });
  });
});
