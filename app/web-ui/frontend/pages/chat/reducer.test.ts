import { describe, expect, test } from "bun:test";
import type { ChatAssistantItem, ChatItem, ChatSessionDetail, ChatSnapshot, ChatStreamEvent, ChatToolItem, ChatUserItem } from "../../../ui-api/chat/types";
import { bucketSessions, sessionTitle, ymdInZone } from "./days";
import { activityHint, chatReducer, groupItems, initialChatState, type ChatAction, type ChatViewState, type PendingSend } from "./reducer";

const session: ChatSessionDetail = {
  key: "k1",
  title: "T",
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z",
  archivedAt: null,
  lastActivityAt: "2026-09-20T10:00:00.000Z",
  messageCount: 1,
  preview: "hi",
  sessionId: "s1",
  isDefault: false,
  stats: { costUsd: 0.1, runs: 1 },
};

const user = (id: number, text = `msg ${id}`, clientId?: string): ChatUserItem => ({ kind: "user", id: `u:${id}`, messageId: id, text, attachments: [], at: "2026-09-20T10:00:00.000Z", ...(clientId ? { clientId } : {}) });
const asst = (id: string, streamId: string | null, text = "answer"): ChatAssistantItem => ({ kind: "assistant", id, text, streamId, at: "2026-09-20T10:00:01.000Z" });
const tool = (id: string, result: string | null = null, name = "Bash"): ChatToolItem => ({ kind: "tool", id, toolUseId: id, name, summary: "", input: "{}", result, isError: false, at: null });
const pending = (clientId: string, over: Partial<PendingSend> = {}): PendingSend => ({ clientId, kind: "text", text: "hi", status: "sending", at: "2026-09-20T10:00:00.000Z", ...over });

const ev = (event: ChatStreamEvent): ChatAction => ({ type: "event", event });
const snapshot = (over: Partial<ChatSnapshot> = {}): ChatAction =>
  ev({ event: "snapshot", data: { session, items: [], drafts: [], run: { state: "idle", since: null, canStop: false }, truncated: false, ...over } });
const reduce = (actions: ChatAction[], start: ChatViewState = initialChatState) => actions.reduce(chatReducer, start);
const ids = (items: ChatItem[]) => items.map((i) => i.id);

describe("chatReducer", () => {
  test("snapshot replaces state, keeps unconfirmed pending sends and becomes ready", () => {
    const s = reduce([
      { type: "pending_add", pending: pending("c1") },
      ev({ event: "item", data: { item: user(9) } }),
      snapshot({ items: [user(1)], drafts: [{ streamId: "m1", text: "par" }], truncated: true, run: { state: "running", since: "x", canStop: true } }),
    ]);
    expect(s.status).toBe("ready");
    expect(ids(s.items)).toEqual(["u:1"]);
    expect(s.drafts).toEqual([{ streamId: "m1", text: "par" }]);
    expect(s.truncated).toBe(true);
    expect(s.run.state).toBe("running");
    expect(s.pending.map((p) => p.clientId)).toEqual(["c1"]);
  });

  test("snapshot drops pending entries whose clientId is on an item", () => {
    const s = reduce([{ type: "pending_add", pending: pending("c1") }, { type: "pending_add", pending: pending("c2") }, snapshot({ items: [user(1, "hi", "c1")] })]);
    expect(s.pending.map((p) => p.clientId)).toEqual(["c2"]);
  });

  test("item appends, and replaces an existing id instead of duplicating", () => {
    const s = reduce([snapshot({ items: [user(1)] }), ev({ event: "item", data: { item: user(2) } }), ev({ event: "item", data: { item: user(2, "edited") } })]);
    expect(ids(s.items)).toEqual(["u:1", "u:2"]);
    expect((s.items[1] as ChatUserItem).text).toBe("edited");
  });

  test("a stream replay after reconnect does not duplicate bubbles", () => {
    const items = [user(1), asst("a:1:0", "m1"), user(2)];
    const s = reduce([snapshot({ items }), ev({ event: "item", data: { item: user(2) } }), snapshot({ items }), ev({ event: "item", data: { item: asst("a:1:0", "m1") } })]);
    expect(ids(s.items)).toEqual(["u:1", "a:1:0", "u:2"]);
  });

  test("optimistic send: the stream item with the clientId swaps the pending bubble", () => {
    let s = reduce([snapshot(), { type: "pending_add", pending: pending("c1", { text: "hello" }) }]);
    expect(s.pending).toHaveLength(1);
    s = chatReducer(s, ev({ event: "item", data: { item: user(5, "hello", "c1") } }));
    expect(s.pending).toHaveLength(0);
    expect(ids(s.items)).toEqual(["u:5"]);
    // The POST response arriving afterwards changes nothing.
    s = chatReducer(s, { type: "sent", response: { item: user(5, "hello", "c1"), triggered: true } });
    expect(ids(s.items)).toEqual(["u:5"]);
    expect(s.pending).toHaveLength(0);
  });

  test("optimistic send: POST response first, then the stream item", () => {
    let s = reduce([snapshot(), { type: "pending_add", pending: pending("c1") }]);
    s = chatReducer(s, { type: "sent", response: { item: user(5, "hi", "c1"), triggered: true } });
    expect(s.pending).toHaveLength(0);
    s = chatReducer(s, ev({ event: "item", data: { item: user(5, "hi", "c1") } }));
    expect(ids(s.items)).toEqual(["u:5"]);
  });

  test("optimistic send: a reconnect snapshot that already has the message, then the POST response", () => {
    let s = reduce([snapshot(), { type: "pending_add", pending: pending("c1") }, snapshot({ items: [user(5, "hi")] })]);
    // Snapshot items carry no clientId, so the pending bubble stays until the response names it.
    expect(s.pending).toHaveLength(1);
    s = chatReducer(s, { type: "sent", response: { item: user(5, "hi", "c1"), triggered: true } });
    expect(s.pending).toHaveLength(0);
    expect(ids(s.items)).toEqual(["u:5"]);
  });

  test("pending update and remove", () => {
    let s = reduce([{ type: "pending_add", pending: pending("c1") }, { type: "pending_update", clientId: "c1", patch: { status: "failed", error: "Atlas is paused" } }]);
    expect(s.pending[0]).toMatchObject({ status: "failed", error: "Atlas is paused" });
    s = chatReducer(s, { type: "pending_add", pending: pending("c1") });
    expect(s.pending).toHaveLength(1);
    expect(s.pending[0]!.status).toBe("sending");
    s = chatReducer(s, { type: "pending_remove", clientId: "c1" });
    expect(s.pending).toHaveLength(0);
  });

  test("item_update replaces by id and ignores unknown ids", () => {
    let s = reduce([snapshot({ items: [tool("t:1")] })]);
    s = chatReducer(s, ev({ event: "item_update", data: { item: tool("t:1", "ok") } }));
    expect((s.items[0] as ChatToolItem).result).toBe("ok");
    const before = s;
    s = chatReducer(s, ev({ event: "item_update", data: { item: tool("t:404", "x") } }));
    expect(s).toBe(before);
  });

  test("delta appends to a draft, creating it at the end when missing", () => {
    const s = reduce([
      snapshot({ drafts: [{ streamId: "m1", text: "a" }] }),
      ev({ event: "delta", data: { streamId: "m2", text: "x" } }),
      ev({ event: "delta", data: { streamId: "m1", text: "b" } }),
      ev({ event: "delta", data: { streamId: "m2", text: "y" } }),
    ]);
    expect(s.drafts).toEqual([
      { streamId: "m1", text: "ab", interrupted: false },
      { streamId: "m2", text: "xy", interrupted: false },
    ]);
  });

  test("draft → item: an assistant item removes the draft with its streamId", () => {
    const s = reduce([
      snapshot({ run: { state: "running", since: null, canStop: true } }),
      ev({ event: "delta", data: { streamId: "m1", text: "Hel" } }),
      ev({ event: "delta", data: { streamId: "m2", text: "other" } }),
      ev({ event: "item", data: { item: asst("a:1:0", "m1", "Hello") } }),
    ]);
    expect(s.drafts.map((d) => d.streamId)).toEqual(["m2"]);
    expect(ids(s.items)).toEqual(["a:1:0"]);
  });

  test("run: a stopped turn marks remaining drafts interrupted", () => {
    const s = reduce([
      snapshot({ run: { state: "running", since: null, canStop: true } }),
      ev({ event: "delta", data: { streamId: "m1", text: "partial" } }),
      ev({ event: "run", data: { state: "idle", since: null, canStop: false, interrupted: true } }),
    ]);
    expect(s.run.state).toBe("idle");
    expect(s.drafts).toEqual([{ streamId: "m1", text: "partial", interrupted: true }]);
  });

  test("run: a normal end keeps the draft until its final item arrives", () => {
    let s = reduce([
      snapshot({ run: { state: "running", since: null, canStop: true } }),
      ev({ event: "delta", data: { streamId: "m1", text: "partial" } }),
      ev({ event: "run", data: { state: "idle", since: null, canStop: false } }),
    ]);
    expect(s.drafts).toEqual([{ streamId: "m1", text: "partial" }]);
    s = chatReducer(s, ev({ event: "item", data: { item: { kind: "assistant", id: "a:1:0", at: null, text: "partial answer", streamId: "m1" } } }) as any);
    expect(s.drafts).toEqual([]);
  });

  test("expire_drafts marks idle drafts interrupted; the next turn drops them", () => {
    let s = reduce([
      snapshot({ run: { state: "running", since: null, canStop: true } }),
      ev({ event: "delta", data: { streamId: "m1", text: "partial" } }),
      ev({ event: "run", data: { state: "idle", since: null, canStop: false } }),
    ]);
    s = chatReducer(s, { type: "expire_drafts" });
    expect(s.drafts).toEqual([{ streamId: "m1", text: "partial", interrupted: true }]);
    s = chatReducer(s, ev({ event: "run", data: { state: "running", since: null, canStop: true } }) as any);
    expect(s.drafts).toEqual([]);
  });

  test("session and session_deleted", () => {
    let s = reduce([snapshot(), ev({ event: "session", data: { ...session, title: "Renamed" } })]);
    expect(s.session?.title).toBe("Renamed");
    s = chatReducer(s, ev({ event: "session_deleted", data: { key: "k1" } }));
    expect(s.status).toBe("deleted");
  });

  test("connection and not_found", () => {
    let s = chatReducer(initialChatState, { type: "connection", connection: "open" });
    expect(s.connection).toBe("open");
    expect(chatReducer(s, { type: "connection", connection: "open" })).toBe(s);
    s = chatReducer(s, { type: "not_found" });
    expect(s.status).toBe("not_found");
  });
});

describe("groupItems / activityHint", () => {
  test("consecutive tool calls form one group", () => {
    const blocks = groupItems([user(1), tool("t:1"), tool("t:2"), asst("a:1", "m"), tool("t:3")]);
    expect(blocks.map((b) => (b.kind === "tools" ? b.tools.map((t) => t.id).join("+") : b.item.id))).toEqual(["u:1", "t:1+t:2", "a:1", "t:3"]);
  });

  test("typing only while not idle and no live draft; a running tool shows its name", () => {
    const running = { state: "running" as const, since: null, canStop: true };
    expect(activityHint({ run: { state: "idle", since: null, canStop: false }, items: [], drafts: [] })).toEqual({ kind: "none" });
    expect(activityHint({ run: running, items: [user(1)], drafts: [] })).toEqual({ kind: "typing" });
    expect(activityHint({ run: running, items: [], drafts: [{ streamId: "m", text: "x" }] })).toEqual({ kind: "none" });
    expect(activityHint({ run: running, items: [tool("t:1", null, "Grep")], drafts: [] })).toEqual({ kind: "tool", name: "Grep" });
    expect(activityHint({ run: running, items: [tool("t:1", "done")], drafts: [] })).toEqual({ kind: "typing" });
  });
});

describe("sidebar day buckets", () => {
  const mk = (key: string, lastActivityAt: string) => ({ ...session, key, lastActivityAt });

  test("Today / Yesterday / Earlier keep order and omit empty groups", () => {
    const list = [mk("a", "2026-09-21T09:00:00Z"), mk("b", "2026-09-21T01:00:00Z"), mk("c", "2026-09-20T23:00:00Z"), mk("d", "2026-08-01T12:00:00Z")];
    const groups = bucketSessions(list, { today: "2026-09-21", yesterday: "2026-09-20", ymd: (iso) => ymdInZone(iso, "UTC") });
    expect(groups.map((g) => [g.label, g.sessions.map((s) => s.key)])).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      ["Earlier", ["d"]],
    ]);
    expect(bucketSessions([mk("d", "2026-08-01T12:00:00Z")], { today: "2026-09-21", yesterday: "2026-09-20" }).map((g) => g.label)).toEqual(["Earlier"]);
  });

  test("days follow the Atlas zone, not UTC", () => {
    // 23:30 UTC on the 20th is already the 21st in Berlin.
    expect(ymdInZone("2026-09-20T23:30:00Z", "Europe/Berlin")).toBe("2026-09-21");
    expect(ymdInZone("2026-09-20T23:30:00Z", "UTC")).toBe("2026-09-20");
    expect(ymdInZone(null, "UTC")).toBeNull();
    const groups = bucketSessions([mk("late", "2026-09-20T23:30:00Z")], { today: "2026-09-21", yesterday: "2026-09-20", ymd: (iso) => ymdInZone(iso, "Europe/Berlin") });
    expect(groups[0]!.label).toBe("Today");
  });

  test("title fallback", () => {
    expect(sessionTitle({ title: null, isDefault: true })).toBe("Default chat");
    expect(sessionTitle({ title: "  ", isDefault: false })).toBe("New chat");
    expect(sessionTitle({ title: "Trip", isDefault: false })).toBe("Trip");
  });
});
