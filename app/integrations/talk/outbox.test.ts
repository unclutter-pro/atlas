import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TalkLedger } from "../../triggers/talk/ledger.ts";
import type { PrepareSendInput } from "../../triggers/talk/types.ts";
import { TalkClient } from "./client.ts";
import { parseTalkConfig } from "./config.ts";
import { normalizeMessage, normalizeRoom } from "./events.ts";
import { pruneSendBatches, recoverOutbox, sendOutbound, sendText, splitMessage } from "./outbox.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function fixture(maxLength = 8, signal?: AbortSignal, now: () => number = Date.now) {
  const home = mkdtempSync(join(tmpdir(), "atlas-talk-outbox-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  cleanup.push(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; rmSync(home, { recursive: true, force: true }); });
  const config = parseTalkConfig({ talk: { url: "https://example.test", username: "atlas" } }, { env: { TALK_APP_PASSWORD: "private-app-password" }, home });
  const ledger = new TalkLedger(":memory:", now);
  cleanup.push(() => ledger.close());
  ledger.upsertRooms(config.instance, [normalizeRoom({ token: "room1", type: 2 })]);
  const owner = ledger.createConversation({ instance: config.instance, room: "room1", threadId: null });
  const input: PrepareSendInput = { instance: config.instance, room: "room1", threadId: null, conversationId: owner.id, body: "abcdefghijklmno" };
  const posts: any[] = [];
  const messages: any[] = [];
  const state = { maxLength, failAfterSend: false, rejectSend: false, hideHistory: false, missingThread: false, author: "atlas", lastId: 100, afterSend: undefined as undefined | (() => void) };
  const envelope = (data: unknown, status = 200) => Response.json({ ocs: { meta: { status: "ok", statuscode: status }, data } }, { status });
  const client = new TalkClient(config, { signal, fetch: async (url, options) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/capabilities")) return envelope({ capabilities: { spreed: {
      features: ["conversation-v4", "chat-v2", "threads", "chat-replies"], config: { chat: { "max-length": state.maxLength } },
    } } });
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body));
      posts.push(body);
      if (state.rejectSend) return new Response(null, { status: 403 });
      const id = ++state.lastId;
      const threadId = state.missingThread ? id : body.threadTitle ? id : body.threadId ?? id;
      const message = {
        id, token: "room1", actorType: "users", actorId: state.author, actorDisplayName: state.author,
        message: body.message, messageParameters: {}, referenceId: body.referenceId, timestamp: 1700000000,
        threadId, isThread: !state.missingThread && Boolean(body.threadTitle || body.threadId),
        ...(body.replyTo ? { parent: { id: body.replyTo, actorType: "users", actorId: "max", message: "quoted" } } : {}),
      };
      messages.push(message);
      state.afterSend?.();
      if (options.signal?.aborted) throw new Error("Cancelled in flight");
      if (state.failAfterSend) throw new Error("Connection lost after server accepted the message");
      return envelope(message, 201);
    }
    if (u.pathname.includes("/chat/")) return envelope(state.hideHistory ? [] : [...messages].reverse());
    return new Response(null, { status: 404 });
  } });
  return { config, ledger, owner, input, client, posts, messages, state };
}

describe("durable Talk outbox", () => {
  test("a paused recovery can reconcile but waits before sending the next part", async () => {
    const f = fixture(4);
    f.state.failAfterSend = true;
    const result = await sendText(f.ledger, f.client, f.config, { ...f.input, body: "abcdefgh" });
    expect(result.state).toBe("uncertain");
    f.state.failAfterSend = false;
    await recoverOutbox(f.ledger, f.client, f.config, { maySend: () => false });
    expect(f.posts).toHaveLength(1);
    await recoverOutbox(f.ledger, f.client, f.config, { maySend: () => true });
    expect(f.posts).toHaveLength(2);
    expect(f.posts[1].message).toBe("efgh");
  });
  test("splits Unicode within the capability limit and never sends blank-only parts", () => {
    expect(splitMessage("A🙂BC🙂D", 3)).toEqual(["A🙂B", "C🙂D"]);
    expect(splitMessage("abcd    efgh", 4)).toEqual(["abcd", "efgh"]);
    expect(() => splitMessage("   ", 4)).toThrow("empty");
  });

  test("every multipart reply keeps its explicit parent and thread", async () => {
    const f = fixture(4);
    const result = await sendText(f.ledger, f.client, f.config, { ...f.input, replyTo: 42, threadId: 40 });
    expect(result.state).toBe("sent");
    expect(f.posts.map((p) => [p.replyTo, p.threadId, p.threadTitle])).toEqual(Array(4).fill([42, 40, undefined]));
    expect(f.posts.map((p) => p.message).join("")).toBe(f.input.body);
    expect(new Set(f.posts.map((p) => p.referenceId)).size).toBe(4);
  });

  test("a new multipart thread adopts only the server-confirmed ID", async () => {
    const f = fixture(4);
    const result = await sendText(f.ledger, f.client, f.config, { ...f.input, title: "Design" });
    expect(result.state).toBe("sent");
    expect(f.posts[0].threadTitle).toBe("Design");
    expect(f.posts.slice(1).every((p) => p.threadId === result.messageIds[0] && p.threadTitle === undefined && p.replyTo === undefined)).toBe(true);
    expect(f.ledger.lookup(f.config.instance, "room1", "thread", result.messageIds[0])?.id).toBe(f.owner.id);
  });

  test("unknown sends are not retried; an own reference confirms them and resumes remaining parts", async () => {
    const f = fixture(4);
    f.state.failAfterSend = true;
    f.state.hideHistory = true;
    const result = await sendText(f.ledger, f.client, f.config, { ...f.input, title: "Design" });
    expect(result.state).toBe("uncertain");
    expect(f.posts).toHaveLength(1);
    await recoverOutbox(f.ledger, f.client, f.config);
    await recoverOutbox(f.ledger, f.client, f.config);
    expect(f.posts).toHaveLength(1);
    f.state.hideHistory = false;
    f.state.failAfterSend = false;
    await recoverOutbox(f.ledger, f.client, f.config);
    expect(f.posts).toHaveLength(4);
    expect(f.ledger.getOutbound(result.outboundIds[0])?.state).toBe("sent");
    expect(f.posts.slice(1).every((p) => p.threadId === f.messages[0].id)).toBe(true);
    await recoverOutbox(f.ledger, f.client, f.config);
    expect(f.posts).toHaveLength(4);
  });

  test("another user or missing thread metadata cannot confirm an uncertain send", async () => {
    const f = fixture(4);
    f.state.failAfterSend = true;
    const result = await sendText(f.ledger, f.client, f.config, { ...f.input, title: "Design" });
    f.messages[0].actorId = "someone-else";
    await recoverOutbox(f.ledger, f.client, f.config);
    expect(f.ledger.getOutbound(result.outboundIds[0])?.state).toBe("uncertain");
    f.messages[0].actorId = "atlas";
    delete f.messages[0].isThread;
    await recoverOutbox(f.ledger, f.client, f.config);
    expect(f.ledger.getOutbound(result.outboundIds[0])?.state).toBe("uncertain");
    expect(f.posts).toHaveLength(1);
  });

  test("explicit send IDs deduplicate admission and repeat calls without changing the saved plan", async () => {
    const f = fixture(4);
    const input = { ...f.input, id: "review-answer" };
    const results = await Promise.all([sendText(f.ledger, f.client, f.config, input), sendText(f.ledger, f.client, f.config, input)]);
    expect(results[0].batchId).toBe(results[1].batchId);
    expect(f.posts).toHaveLength(4);
    f.state.maxLength = 2;
    await f.client.capabilities(undefined, true);
    const repeated = await sendText(f.ledger, f.client, f.config, input);
    expect(repeated.state).toBe("sent");
    expect(repeated.outboundIds).toHaveLength(4);
    expect(f.posts).toHaveLength(4);
    for (const changed of [{ body: "changed" }, { room: "room2" }, { threadId: 123 }, { replyTo: 123 }, { silent: true }]) {
      await expect(sendText(f.ledger, f.client, f.config, { ...input, ...changed })).rejects.toThrow("already used");
    }
    expect(f.posts).toHaveLength(4);
  });

  test("a repeated question ID cannot silently replace its expected sender or task owner", async () => {
    const f = fixture(100);
    const input = { ...f.input, id: "question", request: { originTrigger: "github", originSessionKey: "issue42", expectedUser: "max", taskId: 42, blocking: true } };
    const result = await sendText(f.ledger, f.client, f.config, input);
    expect(f.ledger.getQuestion(result.requestId!)?.state).toBe("pending");
    await expect(sendText(f.ledger, f.client, f.config, { ...input, request: { ...input.request, expectedUser: "someone" } })).rejects.toThrow("already used");
    expect(f.ledger.getQuestion(result.requestId!)?.expectedUser).toBe("max");
    expect(f.posts).toHaveLength(1);
  });

  test("old uncertain and failed batches cannot starve a later multipart continuation", async () => {
    const f = fixture(4);
    f.state.failAfterSend = true;
    f.state.hideHistory = true;
    for (let i = 0; i < 21; i++) await sendText(f.ledger, f.client, f.config, { ...f.input, body: "old", id: i === 0 ? "newer:child" : `old-${i}` });
    f.state.rejectSend = true;
    const failed = await sendText(f.ledger, f.client, f.config, { ...f.input, body: "fail", id: "failed" });
    expect(failed.state).toBe("failed");
    f.state.rejectSend = false;
    const newer = await sendText(f.ledger, f.client, f.config, { ...f.input, id: "newer", title: "New thread" });
    // Simulate a crash after confirming part one, before preparing part two.
    f.ledger.confirmSend(newer.outboundIds[0], normalizeMessage(f.messages.at(-1), "room1"));
    const before = f.posts.length;
    f.state.failAfterSend = false;
    await recoverOutbox(f.ledger, f.client, f.config);
    expect(f.posts.length - before).toBe(3);
    expect(f.ledger.getOutbound(`${newer.batchId}:3`)?.state).toBe("sent");
    expect(f.ledger.pendingOutbox().filter((out) => out.state === "uncertain")).toHaveLength(21);
  });

  test("recovery applies the current room policy before sending a persisted continuation", async () => {
    const f = fixture(4);
    f.state.failAfterSend = true;
    const result = await sendText(f.ledger, f.client, f.config, f.input);
    f.ledger.confirmSend(result.outboundIds[0], normalizeMessage(f.messages[0], "room1"));
    f.config.rooms = ["anotherRoom"];
    f.state.failAfterSend = false;
    await recoverOutbox(f.ledger, f.client, f.config);
    expect(f.posts).toHaveLength(1);
    expect(f.ledger.getOutbound(`${result.batchId}:1`)?.state).toBe("failed");
  });

  test("rejects secrets and overlong task questions before creating any outgoing intent", async () => {
    const f = fixture(4);
    await expect(sendText(f.ledger, f.client, f.config, { ...f.input, body: f.config.appPassword })).rejects.toThrow("credential");
    await expect(sendText(f.ledger, f.client, f.config, {
      ...f.input, request: { originTrigger: "github", originSessionKey: "issue42", expectedUser: "max" },
    })).rejects.toThrow("one Talk message");
    expect(f.posts).toHaveLength(0);
    expect(f.ledger.pendingOutbox()).toHaveLength(0);
    expect(f.ledger.questions(f.config.instance)).toHaveLength(0);
  });

  test("shutdown before POST preserves the pending intent and preparing question", async () => {
    const shutdown = new AbortController();
    const f = fixture(100, shutdown.signal);
    const out = f.ledger.prepareSend({ ...f.input, request: { originTrigger: "github", originSessionKey: "issue42", expectedUser: "max" } });
    shutdown.abort();
    await expect(sendOutbound(f.ledger, f.client, out)).rejects.toMatchObject({ code: "aborted", unknownOutcome: false });
    expect(f.ledger.getOutbound(out.id)?.state).toBe("pending");
    expect(f.ledger.getQuestion(out.requestId!)?.state).toBe("preparing");
    expect(f.posts).toHaveLength(0);
  });

  test("shutdown during POST preserves uncertainty and stops recovery immediately", async () => {
    const shutdown = new AbortController();
    const f = fixture(4, shutdown.signal);
    f.state.afterSend = () => shutdown.abort();
    await expect(sendText(f.ledger, f.client, f.config, f.input)).rejects.toMatchObject({ code: "aborted", unknownOutcome: true });
    expect(f.ledger.pendingOutbox()[0]?.state).toBe("uncertain");
    await expect(recoverOutbox(f.ledger, f.client, f.config)).rejects.toMatchObject({ code: "aborted" });
    expect(f.posts).toHaveLength(1);
  });

  test("expired completed plans remove text but reserve their send ID and retain delivery anchors", async () => {
    let now = 1_700_000_000_000;
    const f = fixture(100, undefined, () => now);
    const input = { ...f.input, id: "retain-identity", title: "Private title", body: "Private completed message" };
    const result = await sendText(f.ledger, f.client, f.config, input);
    now += 31 * 86_400_000;
    f.ledger.prune();
    expect(pruneSendBatches(f.ledger)).toBe(1);
    const row = f.ledger.db.query("SELECT data FROM talk_send_batches WHERE id=?").get(result.batchId) as { data: string };
    expect(row.data).not.toContain("Private completed message");
    expect(row.data).not.toContain("Private title");
    expect(JSON.parse(row.data)).toMatchObject({ parts: [], input: { conversationId: f.owner.id, body: "", title: null } });
    expect(JSON.parse(row.data).inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.ledger.getOutbound(result.outboundIds[0])).toMatchObject({ state: "sent", messageId: result.messageIds[0], body: "" });
    await expect(sendText(f.ledger, f.client, f.config, input)).rejects.toThrow("expired; this send ID will not resend");
    await expect(sendText(f.ledger, f.client, f.config, { ...input, body: "Different content" })).rejects.toThrow("already used");
    expect(f.posts).toHaveLength(1);
    expect(pruneSendBatches(f.ledger)).toBe(0);
  });

  test("retention preserves incomplete sends and active questions, then expires terminal questions", async () => {
    let now = 1_700_000_000_000;
    const f = fixture(100, undefined, () => now);
    f.state.failAfterSend = true;
    await sendText(f.ledger, f.client, f.config, { ...f.input, id: "incomplete", body: "Private incomplete message" });
    f.state.failAfterSend = false;
    const question = await sendText(f.ledger, f.client, f.config, {
      ...f.input, id: "question", body: "Private unresolved question",
      request: { originTrigger: "github", originSessionKey: "issue42", expectedUser: "max" },
    });
    now += 31 * 86_400_000;
    f.ledger.prune();
    expect(pruneSendBatches(f.ledger)).toBe(0);
    f.ledger.cancelQuestion(question.requestId!);
    expect(pruneSendBatches(f.ledger)).toBe(1);
    const plans = JSON.stringify(f.ledger.db.query("SELECT data FROM talk_send_batches").all());
    expect(plans).toContain("Private incomplete message");
    expect(plans).not.toContain("Private unresolved question");
  });

  test("legacy completed plans without digest or timestamps expire using their outbox activity", async () => {
    let now = 1_700_000_000_000;
    const f = fixture(100, undefined, () => now);
    const input = { ...f.input, id: "legacy", body: "Old private content" };
    const result = await sendText(f.ledger, f.client, f.config, input);
    f.ledger.db.query("UPDATE talk_send_batches SET data=json_remove(data,'$.inputDigest','$.createdAt','$.completedAt') WHERE id=?").run(result.batchId);
    now += 31 * 86_400_000;
    expect(pruneSendBatches(f.ledger)).toBe(1);
    await expect(sendText(f.ledger, f.client, f.config, input)).rejects.toThrow("expired");
    expect(f.posts).toHaveLength(1);
  });
});
