import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TalkClient, TalkError } from "./client.ts";
import { actorAllowed, isTalkConfigured, loadTalkConfig, parseTalkConfig } from "./config.ts";
import { mentionsUser, normalizeMessage, normalizeRoom } from "./events.ts";
import { TalkListener, type TalkListenerHooks } from "./listener.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const FEATURES = ["conversation-v4", "chat-v2", "chat-replies", "chat-get-context", "chat-keep-notifications", "threads", "reactions", "silent-send"];
const rawMessage = (id: number, token = "room1", data: Record<string, any> = {}) => ({
  id, token, actorType: "users", actorId: "max", actorDisplayName: "Max", timestamp: 1700000000 + id,
  message: `Message ${id}`, messageParameters: {}, referenceId: "", systemMessage: "", threadId: id, ...data,
});
const rawRoom = (token = "room1", data: Record<string, any> = {}) => ({
  token, type: 2, name: token, displayName: token, readOnly: 0, lastReadMessage: 0, lastMessage: { id: 0 }, ...data,
});
const ocs = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json({
  ocs: { meta: { status: "ok", statuscode: status }, data },
}, { status, headers });

function fakeTalk() {
  const rooms = new Map<string, any>();
  const messages = new Map<string, any[]>();
  const requests: { url: URL; method: string; headers: Headers; body: any }[] = [];
  const state = {
    features: [...FEATURES],
    intercept: null as null | ((request: Request, url: URL) => Response | undefined | Promise<Response | undefined>),
  };
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "GET" ? null : await request.clone().json() as Record<string, any>;
      requests.push({ url, method: request.method, headers: request.headers, body });
      const intercepted = await state.intercept?.(request, url);
      if (intercepted) return intercepted;
      if (url.pathname.endsWith("/cloud/capabilities")) {
        return ocs({ capabilities: { spreed: { features: state.features, config: { chat: { "max-length": 32000 }, signaling: { mode: "external" } } } } });
      }
      if (url.pathname.endsWith("/v4/room")) {
        if (request.method === "GET") return ocs([...rooms.values()]);
        const token = `dm${body.invite}`;
        const existing = rooms.get(token);
        const room = existing ?? rawRoom(token, { type: 1, name: body.invite });
        rooms.set(token, room);
        return ocs(room, existing ? 200 : 201);
      }
      if (url.pathname.includes("/reaction/")) return ocs({ actorType: "users", actorId: "atlas" }, request.method === "POST" ? 201 : 200);
      const route = url.pathname.match(/\/chat\/([a-zA-Z0-9]+)(?:\/(\d+)\/(context))?$/);
      if (!route) return new Response("Not found", { status: 404 });
      const token = route[1];
      if (!rooms.has(token)) return new Response("Not found", { status: 404 });
      const stored = messages.get(token) ?? [];
      if (request.method === "POST") {
        const id = Math.max(0, ...[...messages.values()].flat().map((m) => m.id)) + 1;
        const parent = stored.find((m) => m.id === body.replyTo);
        const threadId = body.threadTitle ? id : body.threadId ?? parent?.threadId ?? id;
        const sent = rawMessage(id, token, {
          message: body.message, actorId: "atlas", referenceId: body.referenceId,
          threadId, isThread: Boolean(body.threadTitle || body.threadId || parent?.isThread), ...(parent ? { parent } : {}),
        });
        messages.set(token, [...stored, sent]);
        return ocs(sent, 201);
      }
      if (route[3]) return ocs(stored.filter((m) => Math.abs(m.id - Number(route[2])) <= Number(url.searchParams.get("limit"))));
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const after = Number(url.searchParams.get("lastKnownMessageId") ?? 0);
      const forward = url.searchParams.get("lookIntoFuture") === "1";
      const selected = forward ? stored.filter((m) => m.id > after).slice(0, limit)
        : stored.filter((m) => !after || m.id < after).slice(-limit).reverse();
      return selected.length ? ocs(selected, 200, { "X-Chat-Last-Given": String(selected.at(-1)!.id) }) : new Response(null, { status: 304 });
    },
  });
  cleanup.push(() => server.stop(true));
  const config = parseTalkConfig({ talk: { url: `http://127.0.0.1:${server.port}/nextcloud`, username: "atlas", allow_insecure_http: true } }, { env: { TALK_APP_PASSWORD: "test-app-password" } });
  return { rooms, messages, requests, state, config, client: new TalkClient(config) };
}

function ledgerHooks() {
  const cursors = new Map<string, number>();
  const deliveries: { room: string; ids: number[]; historyOnly: boolean; cursor: number }[] = [];
  const revoked: string[] = [];
  const hooks: TalkListenerHooks = {
    getCursor: (room) => cursors.get(room) ?? null,
    persist: (room, messages, cursor, options) => {
      deliveries.push({ room: room.token, ids: messages.map((m) => m.id), cursor, historyOnly: Boolean(options?.historyOnly) });
      cursors.set(room.token, cursor);
    },
    onRevokedRoom: (room) => { revoked.push(room); },
  };
  return { hooks, cursors, deliveries, revoked };
}

describe("Talk settings and identities", () => {
  test("isolates instance/account namespaces and validates settings without reading credentials", () => {
    const raw = { talk: { url: "https://example.test/cloud/", username: "atlas", password_file: "/missing-secret", rooms: ["team1"], whitelist: ["max"] } };
    const config = parseTalkConfig(raw, { env: { TALK_APP_PASSWORD: "must-not-leak" }, requirePassword: false });
    expect(config.appPassword).toBe("");
    expect(config.url).toBe("https://example.test/cloud");
    expect(isTalkConfigured({}, { env: {} })).toBe(false);
    expect(isTalkConfigured(raw, { env: {} })).toBe(true);
    expect(parseTalkConfig(raw, { env: {}, requirePassword: false }).instance).toBe(config.instance);
    expect(parseTalkConfig(raw, { env: { TALK_USERNAME: "other" }, requirePassword: false }).instance).not.toBe(config.instance);
    expect(() => parseTalkConfig({ talk: { ...raw.talk, url: "https://secret@example.test" } }, { requirePassword: false })).toThrow("credentials");
    expect(() => parseTalkConfig({ talk: { ...raw.talk, url: "http://example.test" } }, { requirePassword: false })).toThrow("HTTPS");
    expect(() => parseTalkConfig({ talk: { ...raw.talk, app_password: "secret" } }, { requirePassword: false })).toThrow("not config.yml");
    expect(() => parseTalkConfig({ talk: { ...raw.talk, max_connections: 0 } }, { requirePassword: false })).toThrow("max_connections");
    expect(actorAllowed(config, "users", "max")).toBe(true);
    expect(actorAllowed(config, "guests", "max")).toBe(false);
    expect(actorAllowed({ whitelist: [] }, "users", "team-member")).toBe(true);
    expect(actorAllowed({ whitelist: [] }, "guests", "external")).toBe(false);
    expect(actorAllowed({ whitelist: ["federated_users/max@remote"] }, "federated_users", "max@remote")).toBe(false);
  });

  test("loads separate password files and env overrides", () => {
    const home = mkdtempSync(join(tmpdir(), "atlas-talk-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const secret = join(home, "password");
    writeFileSync(secret, "file-secret\n");
    writeFileSync(join(home, "config.yml"), `talk:\n  url: https://example.test\n  username: atlas\n  password_file: ${secret}\n`);
    expect(loadTalkConfig(undefined, { home, env: {} }).appPassword).toBe("file-secret");
    expect(loadTalkConfig(undefined, { home, env: { TALK_APP_PASSWORD: "env-secret" } }).appPassword).toBe("env-secret");
  });

  test("does not turn ordinary Talk threadId values into distinct conversations", () => {
    const plain = normalizeMessage(rawMessage(10), "room1");
    expect(plain.threadId).toBeNull();
    expect(plain.replyRootId).toBe(10);
    const quote = normalizeMessage(rawMessage(11, "room1", { threadId: 10, parent: rawMessage(10) }), "room1");
    expect(quote.threadId).toBeNull();
    expect(quote.parentId).toBe(10);
    const thread = normalizeMessage(rawMessage(12, "room1", { threadId: 10, isThread: true }), "room1");
    expect(thread.threadId).toBe(10);
    expect(() => normalizeMessage(rawMessage(10, "different"), "room1")).toThrow("different conversation");
  });

  test("matches rich mention IDs and preserves edit parent and attachments", () => {
    const message = normalizeMessage(rawMessage(11, "room1", {
      message: "{mention-user1} see {file1}",
      messageParameters: { "mention-user1": { type: "user", id: "atlas", name: "Assistant" }, file1: { type: "file", id: "12", name: "spec.pdf" } },
      parent: { ...rawMessage(10), message: "edited text", lastEditTimestamp: 1700001000 }, systemMessage: "message_edited",
    }), "room1");
    expect(message.text).toBe("@Assistant (atlas) see [file: spec.pdf]");
    expect(mentionsUser(message, "atlas")).toBe(true);
    expect(mentionsUser(message, "Assistant")).toBe(false);
    expect(message.parent?.editedAt).toBe(1700001000);
    expect(mentionsUser(normalizeMessage(rawMessage(12, "room1", { message: "@atlas-other" }), "room1"), "atlas")).toBe(false);
    expect(mentionsUser(normalizeMessage(rawMessage(13, "room1", { message: "@atlas.other" }), "room1"), "atlas")).toBe(false);
  });
});

describe("regular-user OCS transport", () => {
  test("authenticates, preserves pagination, and can start receiving at zero", async () => {
    const api = fakeTalk();
    api.rooms.set("room1", rawRoom());
    api.messages.set("room1", [rawMessage(1), rawMessage(2), rawMessage(3)]);
    expect((await api.client.capabilities()).features).toContain("threads");
    expect((await api.client.rooms())[0].token).toBe("room1");
    const first = await api.client.receive("room1", { after: 0, limit: 2, wait: false });
    expect(first.messages.map((m) => m.id)).toEqual([1, 2]);
    expect(first.cursor).toBe(2);
    expect((await api.client.receive("room1", { after: 3, wait: false })).cursor).toBe(3);
    expect((await api.client.history("room1", { before: 3, limit: 1 })).messages.map((m) => m.id)).toEqual([2]);
    const request = api.requests.find((r) => r.url.searchParams.get("lastKnownMessageId") === "0")!;
    expect(request.url.pathname).toBe("/nextcloud/ocs/v2.php/apps/spreed/api/v1/chat/room1");
    expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("atlas:test-app-password").toString("base64")}`);
    expect(request.headers.get("ocs-apirequest")).toBe("true");
    expect(request.url.searchParams.get("setReadMarker")).toBe("0");
    expect(request.url.searchParams.get("markNotificationsAsRead")).toBe("0");
    expect((await api.client.context("room1", 2, 1)).map((m) => m.id)).toEqual([1, 2, 3]);
  });

  test("uses authoritative IDs for DMs, threads, replies and reactions", async () => {
    const api = fakeTalk();
    const room = await api.client.createDirectConversation("max");
    expect((await api.client.createDirectConversation("max")).token).toBe(room.token);
    expect(api.rooms.size).toBe(1);
    const opening = await api.client.send(room.token, { message: "Please review", threadTitle: "Review", referenceId: "stable-reference" });
    expect(opening.threadId).toBe(opening.id);
    const reply = await api.client.send(room.token, { message: "More context", replyTo: opening.id });
    expect(reply.parentId).toBe(opening.id);
    expect(reply.threadId).toBe(opening.id);
    const threadReply = await api.client.send(room.token, { message: "Thread response", threadId: opening.id });
    expect(threadReply.threadId).toBe(opening.id);
    await api.client.react(room.token, reply.id, "👍");
    await api.client.unreact(room.token, reply.id, "👍");
    expect(api.requests.filter((r) => r.url.pathname.includes("/reaction/")).map((r) => r.method)).toEqual(["POST", "DELETE"]);
    expect((await api.client.history(room.token)).messages[0].referenceId).toBe("stable-reference");
  });

  test("checks capabilities before a send and treats missing send identity as uncertain", async () => {
    const api = fakeTalk();
    api.rooms.set("room1", rawRoom());
    api.state.features = FEATURES.filter((f) => f !== "threads");
    await expect(api.client.send("room1", { message: "hello", threadTitle: "topic" })).rejects.toMatchObject({ code: "unsupported", unknownOutcome: false });
    expect(api.requests.some((r) => r.method === "POST")).toBe(false);
    api.state.intercept = (request) => request.method === "POST" ? ocs({}) : undefined;
    await expect(api.client.send("room1", { message: "hello" })).rejects.toMatchObject({ code: "protocol", unknownOutcome: true });
  });

  test("classifies authentication, server and rate errors without logging bodies", async () => {
    const api = fakeTalk();
    await api.client.capabilities();
    api.state.intercept = () => Response.json({ ocs: { meta: { status: "failure", statuscode: 997, message: "test-app-password" }, data: [] } });
    let error: any;
    try { await api.client.send("room1", { message: "hello" }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "auth", unknownOutcome: false });
    expect(String(error)).not.toContain("test-app-password");
    api.state.intercept = () => new Response("test-app-password", { status: 429, headers: { "Retry-After": "9" } });
    await expect(api.client.send("room1", { message: "hello" })).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 9000, unknownOutcome: false });
    api.state.intercept = () => new Response("test-app-password", { status: 503 });
    await expect(api.client.send("room1", { message: "hello" })).rejects.toMatchObject({ code: "unavailable", unknownOutcome: true });
  });

  test("does not advance over malformed messages and honors invisible-message cursors", async () => {
    const api = fakeTalk();
    api.state.intercept = () => ocs([rawMessage(2, "other")], 200, { "X-Chat-Last-Given": "10" });
    await expect(api.client.receive("room1", { after: 1, wait: false })).rejects.toMatchObject({ code: "protocol" });
    api.state.intercept = () => ocs([], 200, { "X-Chat-Last-Given": "10" });
    expect(await api.client.receive("room1", { after: 1, wait: false })).toEqual({ messages: [], cursor: 10 });
    api.state.intercept = () => ocs([rawMessage(2)], 200, { "X-Chat-Last-Given": "1" });
    await expect(api.client.receive("room1", { after: 1, wait: false })).rejects.toMatchObject({ code: "protocol" });
  });

  test("aborts deadlines and never follows redirects with account credentials", async () => {
    const api = fakeTalk();
    const slow = new TalkClient({ ...api.config, requestTimeoutMs: 15 }, {
      fetch: (_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("secret-url")))),
    });
    await expect(slow.rooms()).rejects.toMatchObject({ code: "timeout", unknownOutcome: false });
    api.state.intercept = () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/do-not-follow" } });
    await expect(api.client.rooms()).rejects.toMatchObject({ code: "network" });
    const controller = new AbortController();
    controller.abort();
    await expect(api.client.receive("room1", { after: 0, signal: controller.signal })).rejects.toMatchObject({ code: "aborted", unknownOutcome: false });
  });

  test("a network failure after POST has an unknown outcome and no automatic retry", async () => {
    const api = fakeTalk();
    let posts = 0;
    const client = new TalkClient(api.config, { fetch: async (url, init) => {
      if (init?.method === "POST") { posts++; throw new Error("secret request details"); }
      return fetch(url, init);
    } });
    await expect(client.send("room1", { message: "hello" })).rejects.toMatchObject({ code: "network", unknownOutcome: true });
    expect(posts).toBe(1);
  });

  test("service cancellation aborts a send even with its own signal and preserves the unknown outcome", async () => {
    const api = fakeTalk();
    const shutdown = new AbortController();
    const operation = new AbortController();
    let startPost!: () => void;
    const posted = new Promise<void>((resolve) => { startPost = resolve; });
    let posts = 0;
    const client = new TalkClient(api.config, { signal: shutdown.signal, fetch: async (url, init) => {
      if (init?.method === "POST") {
        posts++;
        startPost();
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("cancelled in flight")), { once: true });
        });
      }
      return fetch(url, init);
    } });
    await client.capabilities();
    const sending = client.send("room1", { message: "hello", signal: operation.signal });
    await posted;
    shutdown.abort();
    await expect(sending).rejects.toMatchObject({ code: "aborted", unknownOutcome: true });
    expect(operation.signal.aborted).toBe(false);
    await expect(client.rooms()).rejects.toMatchObject({ code: "aborted", unknownOutcome: false });
    await expect(client.send("room1", { message: "later" })).rejects.toMatchObject({ code: "aborted", unknownOutcome: false });
    expect(posts).toBe(1);
  });
});

describe("durable Talk reception", () => {
  test("bootstraps read context, imports unread, and resumes from the saved cursor", async () => {
    const api = fakeTalk();
    api.rooms.set("room1", rawRoom("room1", { lastReadMessage: 5, lastMessage: { id: 8 } }));
    api.messages.set("room1", Array.from({ length: 8 }, (_, i) => rawMessage(i + 1)));
    const ledger = ledgerHooks();
    const listener = new TalkListener(api.config, api.client, ledger.hooks);
    await listener.refreshRooms();
    await listener.pollRound();
    expect(ledger.deliveries).toEqual([
      { room: "room1", ids: [1, 2, 3, 4, 5], cursor: 5, historyOnly: true },
      { room: "room1", ids: [6, 7, 8], cursor: 8, historyOnly: false },
    ]);
    api.messages.get("room1")!.push(rawMessage(9));
    const restarted = new TalkListener(api.config, api.client, ledger.hooks);
    await restarted.refreshRooms();
    await restarted.pollRound();
    expect(ledger.deliveries.at(-1)?.ids).toEqual([9]);
    expect(ledger.cursors.get("room1")).toBe(9);
  });

  test("discovers an already-written new DM without baselining away its first message", async () => {
    const api = fakeTalk();
    const ledger = ledgerHooks();
    const listener = new TalkListener(api.config, api.client, ledger.hooks);
    await listener.refreshRooms();
    api.rooms.set("newdm", rawRoom("newdm", { type: 1, lastMessage: { id: 20 } }));
    api.messages.set("newdm", [rawMessage(20, "newdm")]);
    await listener.refreshRooms();
    await listener.pollRound();
    expect(ledger.deliveries.at(-1)).toEqual({ room: "newdm", ids: [20], cursor: 20, historyOnly: false });
    expect(api.requests.find((r) => r.url.pathname.endsWith("/chat/newdm"))?.url.searchParams.get("lastKnownMessageId")).toBe("0");
  });

  test("replays after failed persistence; cursor advances only with a successful save", async () => {
    const api = fakeTalk();
    api.rooms.set("room1", rawRoom());
    api.messages.set("room1", [rawMessage(1)]);
    const ledger = ledgerHooks();
    let fail = true;
    let now = 0;
    const listener = new TalkListener(api.config, api.client, {
      ...ledger.hooks,
      persist: (room, messages, cursor, options) => {
        if (!options?.historyOnly && fail) throw new Error("disk full");
        return ledger.hooks.persist(room, messages, cursor, options);
      },
    }, { now: () => now, random: () => 0.5 });
    await listener.refreshRooms();
    await listener.pollRound();
    expect(ledger.cursors.get("room1")).toBe(0);
    expect(listener.status().lastError?.code).toBe("persistence");
    fail = false;
    now = 10000;
    await listener.pollRound();
    expect(ledger.cursors.get("room1")).toBe(1);
    expect(ledger.deliveries.filter((d) => !d.historyOnly)).toHaveLength(1);
    expect(api.requests.filter((r) => r.url.pathname.endsWith("/chat/room1")).map((r) => r.url.searchParams.get("lastKnownMessageId"))).toEqual(["0", "0"]);
  });

  test("bounds parallel receives and gives every room a turn despite a busy room and discovery", async () => {
    const api = fakeTalk();
    for (const name of ["room1", "room2", "room3", "room4"]) {
      api.rooms.set(name, rawRoom(name));
      api.messages.set(name, name === "room1" ? Array.from({ length: 201 }, (_, i) => rawMessage(i + 1, name)) : [rawMessage(300, name)]);
    }
    let active = 0;
    let peak = 0;
    api.state.intercept = async (_request, url) => {
      if (url.pathname.includes("/chat/")) {
        active++; peak = Math.max(peak, active);
        await Bun.sleep(20);
        active--;
      }
      return undefined;
    };
    const ledger = ledgerHooks();
    const listener = new TalkListener({ ...api.config, maxConnections: 2 }, api.client, ledger.hooks);
    await listener.refreshRooms();
    const round = listener.pollRound();
    await Bun.sleep(5);
    await listener.refreshRooms();
    await round;
    expect(peak).toBe(2);
    expect(ledger.cursors.size).toBe(4);
    expect(ledger.cursors.get("room1")).toBe(200);
    expect(ledger.cursors.get("room4")).toBe(300);
    expect(listener.status().estimatedMaxPollDelayMs).toBe(50000);
    expect(listener.status().signaling).toBe("not-implemented");
  });

  test("pauses on rate limits and removes revoked rooms without cursor movement", async () => {
    const api = fakeTalk();
    api.rooms.set("room1", rawRoom());
    api.rooms.set("room2", rawRoom("room2"));
    let now = 0;
    api.state.intercept = (_request, url) => url.pathname.endsWith("/chat/room1") ? new Response(null, { status: 429, headers: { "Retry-After": "10" } }) : undefined;
    const ledger = ledgerHooks();
    const listener = new TalkListener({ ...api.config, maxConnections: 1 }, api.client, ledger.hooks, { now: () => now, random: () => 0.5 });
    await listener.refreshRooms();
    await listener.pollRound();
    expect(listener.status().lastError?.retryAt).toBe(10000);
    expect(api.requests.filter((r) => r.url.pathname.endsWith("/chat/room2"))).toHaveLength(0);
    await listener.pollRound();
    expect(api.requests.filter((r) => r.url.pathname.endsWith("/chat/room1"))).toHaveLength(1);
    now = 10001;
    api.state.intercept = (_request, url) => url.pathname.endsWith("/chat/room1") ? new Response(null, { status: 404 }) : undefined;
    await listener.pollRound();
    expect(ledger.revoked).toContain("room1");
    expect(ledger.cursors.get("room1")).toBe(0);
    expect(listener.status().roomCount).toBe(1);
    api.rooms.delete("room2");
    api.rooms.delete("room1");
    await listener.refreshRooms();
    expect(ledger.revoked).toContain("room2");
  });

  test("stops all polling on revoked credentials and reports unsupported federation", async () => {
    const api = fakeTalk();
    api.rooms.set("room1", rawRoom());
    api.rooms.set("remote", rawRoom("remote", { remoteServer: "https://remote.example" }));
    api.state.intercept = (_request, url) => url.pathname.includes("/chat/") ? new Response(null, { status: 401 }) : undefined;
    const ledger = ledgerHooks();
    const listener = new TalkListener(api.config, api.client, ledger.hooks);
    await expect(listener.run()).rejects.toMatchObject({ code: "auth" });
    expect(listener.status()).toMatchObject({ state: "auth_failed", activePolls: 0, unsupportedFederatedRooms: ["remote"] });
    expect(api.requests.filter((r) => r.url.pathname.includes("/chat/remote"))).toHaveLength(0);
  });

  test("retries initial outages and shuts down cleanly", async () => {
    const api = fakeTalk();
    let failed = false;
    api.state.intercept = (_request, url) => {
      if (!failed && url.pathname.endsWith("/capabilities")) { failed = true; return new Response(null, { status: 503 }); }
      return undefined;
    };
    const seen: string[] = [];
    const controller = new AbortController();
    const listener = new TalkListener(api.config, api.client, {
      ...ledgerHooks().hooks,
      onStatus: (status) => { seen.push(status.state); if (status.state === "running") controller.abort(); },
    }, { sleep: async () => {}, random: () => 0.5 });
    await listener.run(controller.signal);
    expect(seen).toContain("backoff");
    expect(seen).toContain("running");
    expect(listener.status().state).toBe("stopped");
  });
});
