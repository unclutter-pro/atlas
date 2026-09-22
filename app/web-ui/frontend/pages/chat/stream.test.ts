import { describe, expect, test } from "bun:test";
import type { ChatStreamEvent } from "../../../ui-api/chat/types";
import { ChatStream, backoffDelay, type Connection } from "./stream";

class FakeEventSource {
  static all: FakeEventSource[] = [];
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  listeners = new Map<string, (ev: MessageEvent) => void>();
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(name: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(name, fn);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  emit(name: string, data: unknown) {
    this.listeners.get(name)?.({ data: JSON.stringify(data) } as unknown as MessageEvent);
  }
  fail(readyState: 0 | 2) {
    this.readyState = readyState;
    this.onerror?.(new Event("error"));
  }
}

function setup(exists: () => "exists" | "missing" | "unknown" = () => "exists") {
  FakeEventSource.all = [];
  const events: ChatStreamEvent[] = [];
  const connections: Connection[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let notFound = 0;
  let checks = 0;
  const stream = new ChatStream({
    url: "/ui/api/chat/sessions/k/stream",
    onEvent: (e) => events.push(e),
    onConnection: (c) => connections.push(c),
    onNotFound: () => notFound++,
    checkExists: async () => {
      checks++;
      return exists();
    },
    createEventSource: (url) => new FakeEventSource(url),
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => {},
  });
  stream.start();
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { stream, events, connections, timers, flush, notFound: () => notFound, checks: () => checks, es: () => FakeEventSource.all[FakeEventSource.all.length - 1]! };
}

describe("ChatStream", () => {
  test("backoff: 1 s × 1.6 up to 10 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(backoffDelay)).toEqual([1000, 1600, 2560, 4096, 6554, 10000, 10000, 10000]);
  });

  test("parses events for every name and reports open", () => {
    const t = setup();
    t.es().open();
    t.es().emit("snapshot", { items: [] });
    t.es().emit("delta", { streamId: "m", text: "x" });
    t.es().listeners.get("run")?.({ data: "not json" } as unknown as MessageEvent);
    expect(t.connections).toEqual(["open"]);
    expect(t.events.map((e) => e.event)).toEqual(["snapshot", "delta"]);
    expect([...t.es().listeners.keys()].sort()).toEqual(["delta", "item", "item_update", "run", "session", "session_deleted", "snapshot"]);
  });

  test("CONNECTING errors are left to the browser's own retry", async () => {
    const t = setup();
    t.es().open();
    t.es().fail(0);
    await t.flush();
    expect(t.connections).toEqual(["open", "reconnecting"]);
    expect(t.checks()).toBe(0);
    expect(FakeEventSource.all).toHaveLength(1);
  });

  test("CLOSED: checks the session, then reopens with growing backoff; open resets it", async () => {
    const t = setup();
    t.es().fail(2);
    await t.flush();
    expect(t.checks()).toBe(1);
    expect(t.timers.map((x) => x.ms)).toEqual([1000]);
    t.timers[0]!.fn();
    expect(FakeEventSource.all).toHaveLength(2);
    t.es().fail(2);
    await t.flush();
    expect(t.timers.map((x) => x.ms)).toEqual([1000, 1600]);
    t.timers[1]!.fn();
    t.es().open();
    t.es().fail(2);
    await t.flush();
    expect(t.timers.map((x) => x.ms)).toEqual([1000, 1600, 1000]);
    expect(FakeEventSource.all[0]!.closed).toBe(true);
  });

  test("CLOSED with a 404 ends in not_found without reopening", async () => {
    const t = setup(() => "missing");
    t.es().fail(2);
    await t.flush();
    expect(t.notFound()).toBe(1);
    expect(t.timers).toHaveLength(0);
  });

  test("session_deleted closes the source; close() ignores late events", () => {
    const t = setup();
    const es = t.es();
    es.open();
    es.emit("session_deleted", { key: "k" });
    expect(es.closed).toBe(true);
    es.emit("item", { item: {} });
    expect(t.events.map((e) => e.event)).toEqual(["session_deleted"]);
  });
});
