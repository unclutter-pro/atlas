import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createWebUiNotifier, notifySocketPath, parseNotifyEvent, type ChatNotifyEvent } from "../../../lib/web-ui-notify";
import { getHub, type HubEvent } from "./hub";
import { startChatNotifyServer } from "./notify-server";
import { cleanupChat, insertChunks, makeChat, resetHubs, seeded, sleep, writeTranscript } from "./test-helpers";

const dir = mkdtempSync(join(tmpdir(), "chat-notify-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const sockPath = () => join(dir, `s${n++}.sock`);

const valid = { v: 1, trigger: "web-chat", sessionKey: "_default", sessionId: "abc-123", kind: "chunk" };

describe("parseNotifyEvent", () => {
  test("accepts a valid event and normalises it", () => {
    expect(parseNotifyEvent(valid)).toEqual(valid as ChatNotifyEvent);
    expect(parseNotifyEvent({ ...valid, sessionId: undefined, kind: "turn_end", interrupted: true })).toEqual({
      ...valid,
      sessionId: null,
      kind: "turn_end",
      interrupted: true,
    } as ChatNotifyEvent);
  });

  test("rejects anything else", () => {
    for (const bad of [
      null,
      [],
      "x",
      { ...valid, v: 2 },
      { ...valid, kind: "delete_everything" },
      { ...valid, sessionKey: "../etc" },
      { ...valid, sessionKey: "k".repeat(129) },
      { ...valid, sessionId: "a/b" },
      { ...valid, trigger: "" },
      { ...valid, isError: "yes" },
    ]) {
      expect(parseNotifyEvent(bad)).toBeNull();
    }
  });

  test("socket path defaults under ~/.index and can be overridden", () => {
    const prev = process.env.ATLAS_WEB_UI_NOTIFY_SOCKET;
    delete process.env.ATLAS_WEB_UI_NOTIFY_SOCKET;
    expect(notifySocketPath("/home/x")).toBe("/home/x/.index/web-ui.sock");
    process.env.ATLAS_WEB_UI_NOTIFY_SOCKET = "/tmp/other.sock";
    expect(notifySocketPath("/home/x")).toBe("/tmp/other.sock");
    if (prev === undefined) delete process.env.ATLAS_WEB_UI_NOTIFY_SOCKET;
    else process.env.ATLAS_WEB_UI_NOTIFY_SOCKET = prev;
  });
});

describe("createWebUiNotifier", () => {
  test("never throws without a listening socket", async () => {
    const notifier = createWebUiNotifier({ socketPath: join(dir, "nobody-home.sock") });
    expect(() => notifier.ping({ trigger: "web-chat", sessionKey: "_default", sessionId: null, kind: "turn_start" })).not.toThrow();
    const t0 = Date.now();
    await notifier.flush(300);
    expect(Date.now() - t0).toBeLessThan(400);
  });

  test("throttles chunk/message pings per key, keeps order, supersedes pending hints", async () => {
    const path = sockPath();
    const got: ChatNotifyEvent[] = [];
    const server = Bun.serve({
      unix: path,
      fetch: async (req) => {
        got.push((await req.json()) as ChatNotifyEvent);
        return new Response(null, { status: 204 });
      },
    });
    try {
      const notifier = createWebUiNotifier({ socketPath: path, throttleMs: 40 });
      const base = { trigger: "web-chat", sessionKey: "k1", sessionId: "s1" } as const;
      notifier.ping({ ...base, kind: "turn_start" });
      for (let i = 0; i < 30; i++) notifier.ping({ ...base, kind: "chunk" });
      await sleep(60); // trailing chunk ping fires
      for (let i = 0; i < 30; i++) notifier.ping({ ...base, kind: "chunk" });
      notifier.ping({ ...base, kind: "turn_end", isError: false }); // drops the pending chunk ping
      notifier.ping({ ...base, kind: "run_end" });
      await notifier.flush(500);
      const kinds = got.map((e) => e.kind);
      expect(kinds[0]).toBe("turn_start");
      expect(kinds.slice(-2)).toEqual(["turn_end", "run_end"]);
      const chunks = kinds.filter((k) => k === "chunk").length;
      expect(chunks).toBeGreaterThanOrEqual(1);
      expect(chunks).toBeLessThanOrEqual(3);
      expect(got.every((e) => e.v === 1 && e.sessionKey === "k1")).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("drops pings beyond maxInFlight", async () => {
    const path = sockPath();
    let count = 0;
    const server = Bun.serve({
      unix: path,
      fetch: async () => {
        count++;
        await sleep(50);
        return new Response(null, { status: 204 });
      },
    });
    try {
      const notifier = createWebUiNotifier({ socketPath: path, maxInFlight: 2 });
      for (let i = 0; i < 10; i++) notifier.ping({ trigger: "web-chat", sessionKey: `k${i}`, sessionId: null, kind: "turn_start" });
      await notifier.flush(1000);
      expect(count).toBe(2);
    } finally {
      server.stop(true);
    }
  });
});

describe("notify server", () => {
  let server: ReturnType<typeof startChatNotifyServer> | null = null;
  afterEach(() => {
    server?.stop(true);
    server = null;
    resetHubs();
  });

  const post = (path: string, body: string, pathname = "/notify", method = "POST") =>
    fetch(`http://web-ui${pathname}`, { method, unix: path, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : body } as RequestInit);

  test("socket is 0600 and only accepts small valid POST /notify", async () => {
    const path = sockPath();
    server = startChatNotifyServer(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await post(path, JSON.stringify(valid))).status).toBe(204);
    expect((await post(path, JSON.stringify({ ...valid, kind: "nope" }))).status).toBe(400);
    expect((await post(path, "{not json")).status).toBe(400);
    expect((await post(path, JSON.stringify({ ...valid, pad: "x".repeat(2000) }))).status).toBe(400);
    expect((await post(path, JSON.stringify(valid), "/other")).status).toBe(404);
    expect((await post(path, "", "/notify", "GET")).status).toBe(404);
  });

  test("replaces a stale socket file", () => {
    const path = sockPath();
    const first = startChatNotifyServer(path);
    first.stop(true);
    server = startChatNotifyServer(path);
    expect(statSync(path).isSocket()).toBe(true);
  });

  test.skipIf(!seeded)("runner notifier → socket → hub → subscribers", async () => {
    const path = sockPath();
    server = startChatNotifyServer(path);
    const chat = makeChat();
    try {
      writeTranscript(chat.sid, []);
      const events: HubEvent[] = [];
      getHub(chat.key).subscribe((e) => events.push(e));
      insertChunks(chat.sid, "m1", ["pi", "ng"]);
      const notifier = createWebUiNotifier({ socketPath: path });
      notifier.ping({ trigger: "web-chat", sessionKey: chat.key, sessionId: chat.sid, kind: "chunk" });
      await notifier.flush(500);
      await sleep(80);
      const chunks = events.find((e) => e.type === "chunks");
      expect(chunks && chunks.type === "chunks" && chunks.rows.map((r) => r.delta).join("")).toBe("ping");
    } finally {
      cleanupChat(chat.key, chat.sid);
    }
  });
});
