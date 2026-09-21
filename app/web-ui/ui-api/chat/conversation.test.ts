import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mergeByTime, toolSummary, TranscriptCursor, turnActiveFromTail } from "./conversation";
import type { ChatItem, ChatToolItem } from "./types";

const dir = mkdtempSync(join(tmpdir(), "chat-conv-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const file = () => join(dir, `t${n++}.jsonl`);
const line = (o: unknown) => JSON.stringify(o) + "\n";

const asst = (uuid: string, id: string, blocks: unknown[], stop: string | null = null, at = "2026-01-01T00:00:01.000Z") =>
  line({ type: "assistant", uuid, timestamp: at, message: { id, role: "assistant", content: blocks, stop_reason: stop } });
const result = (uuid: string, toolUseId: string, content: unknown, isError = false) =>
  line({ type: "user", uuid, timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] } });

describe("TranscriptCursor", () => {
  test("never clips assistant text (external /api/v1 clients relay full answers)", () => {
    const f = file();
    const long = "x".repeat(25_000);
    writeFileSync(f, asst("long", "msg_long", [{ type: "text", text: long }], "end_turn"));
    const item = new TranscriptCursor(f).readNew().added[0] as { text: string };
    expect(item.text).toBe(long);
  });

  test("maps blocks to items with stable ids and drops user text", () => {
    const f = file();
    writeFileSync(
      f,
      line({ type: "user", uuid: "u1", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "New event for trigger web-chat ..." } }) +
        asst("l1", "msg_1", [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Hello" }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls  -la\n/tmp", timeout: 5 } }]),
    );
    const r = new TranscriptCursor(f).readNew();
    expect(r.reset).toBe(false);
    expect(r.added.map((i) => [i.kind, i.id])).toEqual([
      ["thinking", "k:l1:0"],
      ["assistant", "a:l1:1"],
      ["tool", "t:tu1"],
    ]);
    const a = r.added[1]!;
    expect(a.kind === "assistant" && a.streamId).toBe("msg_1");
    const t = r.added[2] as ChatToolItem;
    expect(t.summary).toBe("ls -la /tmp");
    expect(t.input).toContain('"timeout": 5');
    expect(t.result).toBeNull();
  });

  test("keeps a partial last line until it is complete", () => {
    const f = file();
    const full = asst("l1", "msg_1", [{ type: "text", text: "partial ok" }]);
    writeFileSync(f, full.slice(0, 20));
    const c = new TranscriptCursor(f);
    expect(c.readNew().added).toEqual([]);
    expect(c.offset).toBe(20);
    appendFileSync(f, full.slice(20));
    const r = c.readNew();
    expect(r.added.map((i) => i.id)).toEqual(["a:l1:0"]);
    expect(c.readNew().added).toEqual([]);
  });

  test("pairs tool results with their call (same read and later reads)", () => {
    const f = file();
    writeFileSync(f, asst("l1", "m", [{ type: "tool_use", id: "a", name: "Read", input: { file_path: "/x" } }]) + result("r1", "a", [{ type: "text", text: "content" }]));
    const c = new TranscriptCursor(f);
    const first = c.readNew();
    expect(first.updated).toEqual([]);
    expect((first.added[0] as ChatToolItem).result).toBe("content");

    appendFileSync(f, asst("l2", "m2", [{ type: "tool_use", id: "b", name: "Bash", input: { command: "false" } }]));
    const second = c.readNew();
    expect((second.added[0] as ChatToolItem).result).toBeNull();
    appendFileSync(f, result("r2", "b", "boom", true));
    const third = c.readNew();
    expect(third.added).toEqual([]);
    expect(third.updated.map((i) => i.id)).toEqual(["t:b"]);
    const t = third.updated[0] as ChatToolItem;
    expect(t.result).toBe("boom");
    expect(t.isError).toBe(true);
  });

  test("skips sidechain lines", () => {
    const f = file();
    writeFileSync(f, line({ type: "assistant", isSidechain: true, uuid: "s", message: { id: "x", content: [{ type: "text", text: "sub" }] } }) + asst("l1", "m", [{ type: "text", text: "main" }]));
    expect(new TranscriptCursor(f).readNew().added.map((i) => (i as { text: string }).text)).toEqual(["main"]);
  });

  test("reads only the tail of a large file and drops the cut line", () => {
    const f = file();
    let body = "";
    for (let i = 0; i < 50; i++) body += asst(`l${i}`, `m${i}`, [{ type: "text", text: `text ${i} ${"x".repeat(100)}` }]);
    writeFileSync(f, body);
    const c = new TranscriptCursor(f, { tailBytes: 1000 });
    const r = c.readNew();
    expect(c.truncated).toBe(true);
    expect(r.added.length).toBeGreaterThan(0);
    expect(r.added.length).toBeLessThan(10);
    expect(r.added[r.added.length - 1]!.id).toBe("a:l49:0");
    // Every parsed item is a whole line (the cut line was dropped, not mis-parsed).
    for (const it of r.added) expect(it.id).toMatch(/^a:l\d+:0$/);
  });

  test("a shrunk file resets the cursor", () => {
    const f = file();
    writeFileSync(f, asst("l1", "m", [{ type: "text", text: "one" }]) + asst("l2", "m", [{ type: "text", text: "two" }]));
    const c = new TranscriptCursor(f);
    expect(c.readNew().added).toHaveLength(2);
    truncateSync(f, 0);
    writeFileSync(f, asst("l3", "m", [{ type: "text", text: "new" }]));
    const r = c.readNew();
    expect(r.reset).toBe(true);
    expect(r.added.map((i) => i.id)).toEqual(["a:l3:0"]);
  });

  test("uses the byte offset when a line has no uuid; clips long thinking", () => {
    const f = file();
    const first = asst("l1", "m", [{ type: "text", text: "a" }]);
    writeFileSync(f, first + line({ type: "assistant", message: { id: "m", content: [{ type: "thinking", thinking: "y".repeat(25_000) }] } }));
    const r = new TranscriptCursor(f).readNew();
    expect(r.added[1]!.id).toBe(`k:@${Buffer.byteLength(first)}:0`);
    expect((r.added[1] as { text: string }).text).toContain("… (5,000 more characters)");
  });

  test("endOffset stops the read there", () => {
    const f = file();
    const a = asst("l1", "m", [{ type: "text", text: "one" }]);
    writeFileSync(f, a + asst("l2", "m", [{ type: "text", text: "two" }]));
    const r = new TranscriptCursor(f, { endOffset: Buffer.byteLength(a) }).readNew();
    expect(r.added.map((i) => i.id)).toEqual(["a:l1:0"]);
  });
});

describe("toolSummary", () => {
  test("first matching input key, one line, max 160 chars", () => {
    expect(toolSummary({ description: "d", command: "c" })).toBe("c");
    expect(toolSummary({ other: 1 })).toBe("");
    expect(toolSummary("raw")).toBe("");
    const s = toolSummary({ prompt: "p".repeat(300) });
    expect(s.length).toBe(160);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("turnActiveFromTail", () => {
  test("user line or tool_use stop means active; end_turn and interrupts are terminal", () => {
    const f = file();
    writeFileSync(f, asst("l1", "m", [{ type: "tool_use", id: "x", name: "Bash", input: {} }], "tool_use"));
    expect(turnActiveFromTail(f)).toBe(true);
    appendFileSync(f, result("r", "x", "ok"));
    expect(turnActiveFromTail(f)).toBe(true);
    appendFileSync(f, asst("l2", "m2", [{ type: "text", text: "done" }], "end_turn") + line({ type: "system", subtype: "x" }));
    expect(turnActiveFromTail(f)).toBe(false);
    appendFileSync(f, line({ type: "user", message: { role: "user", content: "next question" } }));
    expect(turnActiveFromTail(f)).toBe(true);
    appendFileSync(f, line({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }));
    expect(turnActiveFromTail(f)).toBe(false);
  });

  test("no file or no entries counts as active (session starting)", () => {
    expect(turnActiveFromTail(join(dir, "missing.jsonl"))).toBe(true);
    const f = file();
    writeFileSync(f, line({ type: "system" }));
    expect(turnActiveFromTail(f)).toBe(true);
  });

  test("only the tail is read", () => {
    const f = file();
    writeFileSync(f, asst("l1", "m", [{ type: "text", text: "done" }], "end_turn") + line({ type: "system", pad: "z".repeat(70_000) }));
    // The terminal assistant line is outside the 64 KiB tail → nothing found → active.
    expect(turnActiveFromTail(f)).toBe(true);
  });
});

describe("mergeByTime", () => {
  const u = (id: string, at: string): ChatItem => ({ kind: "user", id, at, messageId: 1, text: id, attachments: [] });
  const a = (id: string, at: string | null): ChatItem => ({ kind: "assistant", id, at, text: id, streamId: null });

  test("user first on equal time; second-precision user times sort by value", () => {
    const merged = mergeByTime(
      [u("u1", "2026-01-01T00:00:01Z"), u("u2", "2026-01-01T00:00:05Z")],
      [a("a1", "2026-01-01T00:00:01.000Z"), a("a2", "2026-01-01T00:00:01.500Z"), a("a3", null), a("a4", "2026-01-01T00:00:06Z")],
    );
    expect(merged.map((i) => i.id)).toEqual(["u1", "a1", "a2", "a3", "u2", "a4"]);
  });
});
