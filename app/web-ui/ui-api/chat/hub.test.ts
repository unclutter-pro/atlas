/**
 * Chat hub: event-driven updates, one source read per change for any number
 * of subscribers, no reads while idle. Needs a seeded HOME:
 *
 *   D=/tmp/atlas-dev-chat; bun dev/seed.ts $D && HOME=$D bun test ui-api/chat
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "fs";
import { getLockPath, getSocketPath } from "../../../lib/trigger-socket";
import type { ChatNotifyKind } from "../../../lib/web-ui-notify";
import { getDb } from "../shared/env";
import { getHub, hubTiming, notifyChat, notifyLocal, peekHub, type HubEvent } from "./hub";
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
  sleep,
  toolResultLine,
  writeTranscript,
} from "./test-helpers";
import { SNAPSHOT_MAX_ITEMS } from "./types";

const ping = (key: string, sid: string | null, kind: ChatNotifyKind, extra: { interrupted?: boolean } = {}) =>
  notifyChat({ v: 1, trigger: "web-chat", sessionKey: key, sessionId: sid, kind, ...extra });

function collector() {
  const events: HubEvent[] = [];
  return { events, listener: (e: HubEvent) => events.push(e), types: () => events.map((e) => e.type) };
}

describe.skipIf(!seeded)("chat hub", () => {
  let chat: ReturnType<typeof makeChat>;
  const extra: string[] = [];

  beforeEach(() => {
    resetHubs();
    hubTiming.flushMs = 20;
    chat = makeChat();
  });

  afterEach(() => {
    resetHubs();
    cleanupChat(chat.key, chat.sid);
    for (const p of extra.splice(0)) rmSync(p, { force: true });
  });

  test("N subscribers: one read per change, everyone gets the event, no reads while idle", async () => {
    writeTranscript(chat.sid, [assistantLine({ uuid: "l0", streamId: "m0", blocks: [{ type: "text", text: "earlier" }], stop: "end_turn", at: iso(60_000) })]);
    const hub = getHub(chat.key);
    const subs = [collector(), collector(), collector()];
    for (const s of subs) hub.subscribe(s.listener);
    await sleep(100); // let any watcher noise from the write settle
    const before = { ...hub.counters };

    insertChunks(chat.sid, "msg_A", ["Hel", "lo"]);
    for (let i = 0; i < 5; i++) ping(chat.key, chat.sid, "chunk");
    await sleep(80);

    expect(hub.counters.chunkReads - before.chunkReads).toBe(1);
    expect(hub.counters.flushes - before.flushes).toBe(1);
    expect(hub.counters.transcriptReads).toBe(before.transcriptReads);
    for (const s of subs) {
      const chunks = s.events.find((e) => e.type === "chunks");
      expect(chunks && chunks.type === "chunks" && chunks.rows.map((r) => r.delta)).toEqual(["Hel", "lo"]);
      // Streamed text proves a turn is running.
      expect(s.events.some((e) => e.type === "run" && e.run.state === "running")).toBe(true);
    }
    expect(hub.snapshot().drafts).toEqual([{ streamId: "msg_A", text: "Hello" }]);

    // Idle: nothing happens, nothing is read.
    const idle = { ...hub.counters };
    const seen = subs.map((s) => s.events.length);
    await sleep(300);
    expect(hub.counters).toEqual(idle);
    expect(subs.map((s) => s.events.length)).toEqual(seen);
  });

  test("flush order: user items, chunks, transcript items, run, session; the final item removes its draft", async () => {
    hubTiming.flushMs = 80;
    writeTranscript(chat.sid, []);
    const hub = getHub(chat.key);
    const c = collector();
    hub.subscribe(c.listener);
    await sleep(50);

    const id = insertUserMessage(chat.key, "What's up?");
    notifyLocal(chat.key, { kind: "user_message", userMessageId: id, clientId: "client-1", triggered: false });
    ping(chat.key, chat.sid, "turn_start");
    insertChunks(chat.sid, "msg_B", ["All ", "good"]);
    ping(chat.key, chat.sid, "chunk");
    appendTranscript(chat.sid, [assistantLine({ uuid: "l1", streamId: "msg_B", blocks: [{ type: "text", text: "All good" }] })]);
    ping(chat.key, chat.sid, "message");
    await sleep(200);

    expect(c.types()).toEqual(["items_added", "chunks", "items_added", "run", "session"]);
    const [users, , assistants, run] = c.events;
    expect(users!.type === "items_added" && users!.items[0]).toMatchObject({ kind: "user", messageId: id, text: "What's up?", clientId: "client-1" });
    expect(assistants!.type === "items_added" && assistants!.items[0]).toMatchObject({ kind: "assistant", id: "a:l1:0", streamId: "msg_B" });
    expect(run!.type === "run" && run!.run.state).toBe("running");

    const snap = hub.snapshot();
    expect(snap.drafts).toEqual([]);
    // clientId only rides on the live event, never in snapshots.
    expect(snap.items.find((i) => i.kind === "user")).not.toHaveProperty("clientId");
  });

  test("tool results arrive as item_updated; a normal turn_end keeps open drafts for the final line; late chunks of a final message are ignored", async () => {
    writeTranscript(chat.sid, []);
    const hub = getHub(chat.key);
    const c = collector();
    hub.subscribe(c.listener);
    await sleep(50);

    ping(chat.key, chat.sid, "turn_start");
    appendTranscript(chat.sid, [assistantLine({ uuid: "l1", streamId: "m1", blocks: [{ type: "tool_use", id: "tu", name: "Bash", input: { command: "ls" } }], stop: "tool_use" })]);
    ping(chat.key, chat.sid, "message");
    await sleep(80);
    appendTranscript(chat.sid, [toolResultLine({ uuid: "r1", toolUseId: "tu", content: "a b c" })]);
    ping(chat.key, chat.sid, "message");
    await sleep(80);
    const upd = c.events.find((e) => e.type === "item_updated");
    expect(upd && upd.type === "item_updated" && upd.item).toMatchObject({ id: "t:tu", result: "a b c", isError: false });

    appendTranscript(chat.sid, [assistantLine({ uuid: "l2", streamId: "m2", blocks: [{ type: "text", text: "done" }], stop: "end_turn" })]);
    ping(chat.key, chat.sid, "message");
    await sleep(80);
    insertChunks(chat.sid, "m2", ["do", "ne"]); // rows read after the final line: dropped
    insertChunks(chat.sid, "m3", ["half"]); // interrupted draft
    ping(chat.key, chat.sid, "chunk");
    await sleep(80);
    const chunkEvents = c.events.filter((e) => e.type === "chunks");
    const rows = chunkEvents.flatMap((e) => (e.type === "chunks" ? e.rows : []));
    expect(rows.map((r) => r.streamId)).toEqual(["m3"]);
    expect(hub.snapshot().drafts).toEqual([{ streamId: "m3", text: "half" }]);

    ping(chat.key, chat.sid, "turn_end");
    await sleep(80);
    const last = c.events[c.events.length - 1]!;
    expect(c.events.some((e) => e.type === "run" && e.run.state === "idle")).toBe(true);
    expect(last.type === "session" || last.type === "run").toBe(true);
    // The final JSONL line may land just after the ping: the draft stays until it does.
    expect(hub.snapshot().drafts).toEqual([{ streamId: "m3", text: "half" }]);
    expect(hub.snapshot().run).toEqual({ state: "idle", since: null, canStop: false });
  });

  test("a stopped turn (turn_end interrupted) drops open drafts and says so", async () => {
    const chat = makeChat();
    const hub = getHub(chat.key);
    const c = collector();
    const sub = hub.subscribe(c.listener);
    try {
      ping(chat.key, chat.sid, "turn_start");
      insertChunks(chat.sid, "m9", ["par", "tial"]);
      ping(chat.key, chat.sid, "chunk");
      await sleep(80);
      expect(hub.snapshot().drafts).toEqual([{ streamId: "m9", text: "partial" }]);
      ping(chat.key, chat.sid, "turn_end", { interrupted: true });
      await sleep(80);
      expect(hub.snapshot().drafts).toEqual([]);
      expect(hub.snapshot().run).toEqual({ state: "idle", since: null, canStop: false, interrupted: true });
    } finally {
      sub.unsubscribe();
      cleanupChat(chat.key);
    }
  });

  test("a session ping with a new session id rebuilds (snapshot) and streams the new session's chunks", async () => {
    const unmapped = makeChat({ mapped: false });
    extra.push(getLockPath("web-chat", unmapped.key));
    try {
      const hub = getHub(unmapped.key);
      const c = collector();
      hub.subscribe(c.listener);
      expect(hub.sessionId).toBeNull();

      getDb().prepare("INSERT INTO trigger_sessions (trigger_name, session_key, session_id) VALUES ('web-chat', ?, ?)").run(unmapped.key, unmapped.sid);
      insertChunks(unmapped.sid, "m1", ["Hi"]);
      ping(unmapped.key, unmapped.sid, "session");
      ping(unmapped.key, unmapped.sid, "chunk");
      await sleep(80);
      expect(c.types().slice(0, 2)).toEqual(["reset", "chunks"]);
      const reset = c.events[0]!;
      expect(reset.type === "reset" && reset.snapshot.session.sessionId).toBe(unmapped.sid);
      expect(hub.history).toBeNull();

      // The history shows up later: found on the next ping.
      writeTranscript(unmapped.sid, [assistantLine({ uuid: "l1", streamId: "m1", blocks: [{ type: "text", text: "Hi" }] })]);
      ping(unmapped.key, unmapped.sid, "message");
      await sleep(80);
      expect(hub.history).not.toBeNull();
      const added = c.events.filter((e) => e.type === "items_added").flatMap((e) => (e.type === "items_added" ? e.items : []));
      expect(added.map((i) => i.id)).toEqual(["a:l1:0"]);
      expect(hub.snapshot().drafts).toEqual([]);
    } finally {
      cleanupChat(unmapped.key, unmapped.sid);
    }
  });

  test("safety net re-derives a stuck non-idle state only while watched", async () => {
    hubTiming.safetyMs = 100;
    hubTiming.startingWindowMs = 0;
    writeTranscript(chat.sid, []);
    const hub = getHub(chat.key);
    const c = collector();
    const sub = hub.subscribe(c.listener);

    ping(chat.key, chat.sid, "turn_start"); // the runner "dies" without a turn_end
    await sleep(60);
    expect(hub.run.state).toBe("running");
    const derives = hub.counters.derives;
    await sleep(200);
    expect(hub.run.state).toBe("idle");
    expect(hub.counters.derives).toBe(derives + 1);

    // Idle: the safety net is off.
    await sleep(250);
    expect(hub.counters.derives).toBe(derives + 1);

    // Unwatched: no timer either.
    sub.unsubscribe();
    ping(chat.key, chat.sid, "turn_start");
    await sleep(250);
    expect(hub.run.state).toBe("running");
    expect(hub.counters.derives).toBe(derives + 1);
  });

  test("cold start while a runner is alive: running, canStop, in-flight draft", () => {
    const lock = getLockPath("web-chat", chat.key);
    const sock = getSocketPath("web-chat", chat.key);
    extra.push(lock, sock);
    writeFileSync(lock, String(process.pid));
    writeFileSync(sock, "");
    writeTranscript(chat.sid, [assistantLine({ uuid: "l1", streamId: "m1", blocks: [{ type: "tool_use", id: "t", name: "Bash", input: {} }], stop: "tool_use" })]);
    insertChunks(chat.sid, "m0", ["old"]);
    insertChunks(chat.sid, "m2", ["Work", "ing"]);

    const snap = getHub(chat.key).snapshot();
    expect(snap.run.state).toBe("running");
    expect(snap.run.canStop).toBe(true);
    expect(snap.drafts).toEqual([{ streamId: "m2", text: "Working" }]);
  });

  test("a triggered send moves idle → starting", async () => {
    const hub = getHub(chat.key);
    const c = collector();
    hub.subscribe(c.listener);
    const id = insertUserMessage(chat.key, "go");
    notifyLocal(chat.key, { kind: "user_message", userMessageId: id, triggered: true });
    await sleep(60);
    const run = c.events.find((e) => e.type === "run");
    expect(run && run.type === "run" && run.run.state).toBe("starting");
    expect(run && run.type === "run" && run.run.since).not.toBeNull();
  });

  test("snapshot keeps the newest SNAPSHOT_MAX_ITEMS items", () => {
    const lines = Array.from({ length: SNAPSHOT_MAX_ITEMS + 10 }, (_, i) =>
      assistantLine({ uuid: `l${i}`, streamId: `m${i}`, blocks: [{ type: "text", text: `#${i}` }], at: iso(1000 - i) }),
    );
    writeTranscript(chat.sid, lines);
    const snap = getHub(chat.key).snapshot();
    expect(snap.truncated).toBe(true);
    expect(snap.items).toHaveLength(SNAPSHOT_MAX_ITEMS);
    expect(snap.items[snap.items.length - 1]!.id).toBe(`a:l${SNAPSHOT_MAX_ITEMS + 9}:0`);
  });

  test("disposed after the last subscriber leaves; deleted closes subscribers", async () => {
    hubTiming.disposeMs = 50;
    const hub = getHub(chat.key);
    const sub = hub.subscribe(() => {});
    await sleep(80);
    expect(peekHub(chat.key)).toBe(hub);
    sub.unsubscribe();
    await sleep(100);
    expect(hub.disposed).toBe(true);
    expect(peekHub(chat.key)).toBeUndefined();

    const next = getHub(chat.key);
    const c = collector();
    next.subscribe(c.listener);
    notifyLocal(chat.key, { kind: "deleted" });
    expect(c.types()).toEqual(["deleted"]);
    expect(next.disposed).toBe(true);
  });

  test("pings for chats without a hub or other triggers cost nothing", () => {
    ping(chat.key, chat.sid, "turn_start");
    expect(peekHub(chat.key)).toBeUndefined();
    const hub = getHub(chat.key);
    const flushes = hub.counters.flushes;
    notifyChat({ v: 1, trigger: "signal-chat", sessionKey: chat.key, sessionId: null, kind: "turn_start" });
    expect(hub.counters.flushes).toBe(flushes);
  });
});
