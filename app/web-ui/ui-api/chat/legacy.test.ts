/**
 * /api/v1/chat/* contract on top of the hub (needs a seeded HOME).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChatNotifyKind } from "../../../lib/web-ui-notify";
import { app } from "../../index";
import { hubTiming, notifyChat } from "./hub";
import { sendMessage } from "./service";
import {
  appendTranscript,
  assistantLine,
  cleanupChat,
  insertChunks,
  insertUserMessage,
  iso,
  makeChat,
  resetHubs,
  seeded,
  sseReader,
  toolResultLine,
  writeTranscript,
} from "./test-helpers";

const auth = { "X-API-Key": process.env.ATLAS_API_KEY || "test-key" };
const ping = (key: string, sid: string, kind: ChatNotifyKind) => notifyChat({ v: 1, trigger: "web-chat", sessionKey: key, sessionId: sid, kind });

async function openStream(query: string) {
  const res = await app.fetch(new Request(`http://localhost/api/v1/chat/stream?${query}`, { headers: auth }));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  return sseReader(res.body!);
}

describe.skipIf(!seeded)("/api/v1/chat on the hub", () => {
  let chat: ReturnType<typeof makeChat>;

  beforeEach(() => {
    resetHubs();
    hubTiming.flushMs = 10;
    chat = makeChat();
    insertUserMessage(chat.key, "first question");
    writeTranscript(chat.sid, [
      assistantLine({ uuid: "l1", streamId: "m1", blocks: [{ type: "thinking", thinking: "..." }, { type: "tool_use", id: "t1", name: "Grep", input: { pattern: "x" } }], stop: "tool_use", at: iso(-1000) }),
      toolResultLine({ uuid: "r1", toolUseId: "t1", content: "found", at: iso(-1500) }),
      assistantLine({ uuid: "l2", streamId: "m2", blocks: [{ type: "text", text: "first answer" }], stop: "end_turn", at: iso(-2000) }),
    ]);
  });

  afterEach(() => {
    resetHubs();
    cleanupChat(chat.key, chat.sid);
  });

  test("init, then user/chunk/tool/assistant events, agent_started/agent_ended, then close", async () => {
    const s = await openStream(`sessionKey=${chat.key}`);
    const init = await s.next("init");
    expect(init).toEqual({
      messages: [
        { role: "user", content: "first question", timestamp: expect.any(String) },
        { role: "tool", content: "Grep", timestamp: expect.any(String), toolName: "Grep" },
        { role: "assistant", content: "first answer", timestamp: expect.any(String) },
      ],
      isAgentRunning: false,
      toolSteps: 1,
    });

    await sendMessage(chat.key, { content: "second question", surface: "v1" });
    expect(await s.next("user_message")).toEqual({ content: "second question", timestamp: expect.stringMatching(/Z$/) });

    ping(chat.key, chat.sid, "turn_start");
    expect(await s.next("agent_started")).toEqual({});

    insertChunks(chat.sid, "m3", ["Sec", "ond"]);
    ping(chat.key, chat.sid, "chunk");
    expect(await s.next("assistant_message_chunk")).toEqual({ messageId: "m3", index: 0, delta: "Sec" });
    expect(await s.next("assistant_message_chunk")).toEqual({ messageId: "m3", index: 1, delta: "ond" });

    appendTranscript(chat.sid, [
      assistantLine({ uuid: "l3", streamId: "m3", blocks: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }] }),
      assistantLine({ uuid: "l4", streamId: "m3", blocks: [{ type: "text", text: "Second answer" }], stop: "end_turn" }),
    ]);
    ping(chat.key, chat.sid, "message");
    expect(await s.next("tool_activity")).toEqual({ toolName: "Bash", totalSteps: 2 });
    expect(await s.next("assistant_message")).toEqual({ content: "Second answer", timestamp: expect.any(String), messageId: "m3" });

    ping(chat.key, chat.sid, "turn_end");
    expect(await s.next("agent_ended")).toEqual({});
    const t0 = Date.now();
    await s.untilClosed(3000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
  });

  test("stream=false leaves out chunk events", async () => {
    const s = await openStream(`sessionKey=${chat.key}&stream=false`);
    await s.next("init");
    ping(chat.key, chat.sid, "turn_start");
    await s.next("agent_started");
    insertChunks(chat.sid, "m9", ["x"]);
    ping(chat.key, chat.sid, "chunk");
    appendTranscript(chat.sid, [assistantLine({ uuid: "l9", streamId: "m9", blocks: [{ type: "text", text: "x" }] })]);
    ping(chat.key, chat.sid, "message");
    await s.next("assistant_message");
    expect(s.raw.some((f) => f.includes("assistant_message_chunk"))).toBe(false);
    await s.cancel();
  });

  test("keys without a chat row still stream (no 404)", async () => {
    const s = await openStream(`sessionKey=nobody-${Date.now()}`);
    expect(await s.next("init")).toEqual({ messages: [], isAgentRunning: false, toolSteps: 0 });
    await s.cancel();
  });

  test("GET /api/v1/chat/messages keeps its shape", async () => {
    const res = await app.fetch(new Request(`http://localhost/api/v1/chat/messages?sessionKey=${chat.key}`, { headers: auth }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      messages: [
        { role: "user", content: "first question", timestamp: expect.any(String) },
        { role: "tool", content: "Grep", timestamp: expect.any(String), toolName: "Grep" },
        { role: "assistant", content: "first answer", timestamp: expect.any(String) },
      ],
      isAgentRunning: false,
      isTyping: false,
      toolSteps: 1,
    });
  });

  test("session CRUD keeps the v1 shapes", async () => {
    const json = (method: string, path: string, body?: unknown) =>
      app.fetch(new Request(`http://localhost/api/v1${path}`, { method, headers: { ...auth, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));

    const created = await json("POST", "/chat/sessions", { title: "  v1 chat " });
    expect(created.status).toBe(201);
    const c = (await created.json()) as Record<string, unknown>;
    expect(Object.keys(c).sort()).toEqual(["created_at", "session_key", "title", "updated_at"]);
    expect(c.title).toBe("v1 chat");
    const key = c.session_key as string;
    try {
      const list = (await (await app.fetch(new Request("http://localhost/api/v1/chat/sessions", { headers: auth }))).json()) as { sessions: Record<string, unknown>[] };
      const row = list.sessions.find((r) => r.session_key === key)!;
      expect(Object.keys(row).sort()).toEqual(["archived_at", "created_at", "last_message_at", "message_count", "session_key", "title", "updated_at"]);
      expect(row.message_count).toBe(0);
      expect(row.last_message_at).toBeNull();

      const patched = await json("PATCH", `/chat/sessions/${key}`, { title: "Renamed", archived: true });
      expect(patched.status).toBe(200);
      const p = (await patched.json()) as Record<string, unknown>;
      expect(p.title).toBe("Renamed");
      expect(p.archived_at).toEqual(expect.stringMatching(/Z$/));
      expect((await json("PATCH", "/chat/sessions/nope-404", { title: "x" })).status).toBe(404);

      expect((await json("DELETE", "/chat/sessions/_default")).status).toBe(400);
      expect((await json("DELETE", `/chat/sessions/${key}`)).status).toBe(200);
      expect((await json("DELETE", `/chat/sessions/${key}`)).status).toBe(404);
    } finally {
      cleanupChat(key);
    }
  });

  test("POST multipart voice (STT stubbed) keeps the v1 response and German placeholders", async () => {
    const { sttDeps } = await import("./stt");
    const orig = sttDeps.transcribe;
    sttDeps.transcribe = async () => null;
    try {
      const form = new FormData();
      form.append("file", new File([new Uint8Array([1, 2, 3])], "note.webm", { type: "audio/webm" }));
      const res = await app.fetch(new Request(`http://localhost/api/v1/chat/messages?sessionKey=${chat.key}`, { method: "POST", headers: auth, body: form }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
      expect(body.message.content).toBe("(Datei: note.webm)");
      expect(body.message.attachments[0]).toMatchObject({ file_name: "note.webm", file_size: 3, url: expect.stringMatching(/^\/api\/v1\/attachments\//) });

      const empty = await app.fetch(
        new Request(`http://localhost/api/v1/chat/messages?sessionKey=${chat.key}`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ message: "  " }) }),
      );
      expect(empty.status).toBe(400);
      expect(await empty.json()).toEqual({ error: "Missing 'message' field" });
    } finally {
      sttDeps.transcribe = orig;
    }
  });
});
