import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acceptTriggerReceipt, getTriggerDeliveryOwner, getTriggerReceipt, pruneCompletedTriggerReceipts,
} from "../../lib/trigger-receipts.ts";
import { getLockPath, getSocketPath, isPidAlive, sendSocketMessage } from "../../lib/trigger-socket.ts";
import { TalkLedger } from "../talk/ledger.ts";

const runnerPath = join(import.meta.dir, "../trigger-runner.ts");
const trigger = "delivery-check";

async function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the runner");
    await Bun.sleep(10);
  }
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "atlas-runner-delivery-"));
  const key = crypto.randomUUID();
  const driver = join(home, "driver.ts");
  const seenFile = join(home, "seen.jsonl");
  writeFileSync(driver, `
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDb } from ${JSON.stringify(join(import.meta.dir, "../../lib/atlas-db.ts"))};
import { main, runnerDeps } from ${JSON.stringify(runnerPath)};
import { ClaudeCodeBackend } from ${JSON.stringify(join(import.meta.dir, "claude/backend.ts"))};
const db = getDb();
db.prepare("INSERT INTO triggers (name, type, channel, prompt, session_mode) VALUES (?, 'manual', 'internal', '{{payload}}', 'persistent') ON CONFLICT DO NOTHING").run(${JSON.stringify(trigger)});
if (process.env.DELIVERY_SETUP === "1") process.exit(0);
const query = ((request) => {
  let closed = false;
  async function* events() {
    const input = request.prompt[Symbol.asyncIterator]();
    for (let index = 0; index < Number(process.env.DELIVERY_INPUTS || "2"); index++) {
      const next = await input.next();
      if (next.done || closed) return;
      const text = next.value.message.content;
      appendFileSync(${JSON.stringify(seenFile)}, JSON.stringify({ text }) + "\\n");
      yield { type: "system", subtype: "init", session_id: "delivery-session" };
      while (process.env.DELIVERY_GATES === "1" && !existsSync(join(process.env.HOME!, "gate-" + index))) {
        if (closed) return;
        await Bun.sleep(10);
      }
      yield process.env.DELIVERY_FAIL === "1"
        ? { type: "result", subtype: "error_during_execution", session_id: "delivery-session", num_turns: 1, errors: ["Temporary failure"] }
        : { type: "result", subtype: "success", session_id: "delivery-session", num_turns: 1, result: "done" };
    }
  }
  return Object.assign(events(), { close() { closed = true; }, async interrupt() {} });
}) as any;
runnerDeps.createBackend = () => new ClaudeCodeBackend({ query });
await main();
process.exit(0);
`);
  const env = { ...process.env, HOME: home, TRIGGER_IDLE_TIMEOUT: "3000" };
  const setup = Bun.spawnSync([process.execPath, driver], {
    env: { ...env, DELIVERY_SETUP: "1" }, stdout: "pipe", stderr: "pipe", timeout: 5000,
  });
  if (setup.exitCode !== 0) throw new Error(setup.stderr.toString());
  const db = new Database(join(home, ".index/atlas.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  const talk = new TalkLedger(join(home, ".index/talk/talk.db"));
  talk.setMeta("active-instance", "test-account");
  talk.upsertRooms("test-account", [{ token: "room1", type: 1, name: "Max", displayName: "Max",
    readOnly: false, lastMessageId: 0, lastReadMessage: 0, isFederated: false }]);
  const processes = new Set<Bun.Subprocess>();
  const spawn = (args: string[], options: Record<string, string> = {}) => {
    const proc = Bun.spawn([process.execPath, driver, ...args], {
      env: { ...env, ...options }, stdout: "pipe", stderr: "pipe",
    });
    processes.add(proc);
    const finished = Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]).then(([stdout, stderr, code]) => {
      processes.delete(proc);
      return { stdout, stderr, code };
    });
    return { proc, finished };
  };
  return {
    home, key, db, talk, spawn,
    seen: (): string[] => existsSync(seenFile)
      ? readFileSync(seenFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).text)
      : [],
    receipt: (id: string) => getTriggerReceipt(db, trigger, key, id),
    gate: (index: number) => writeFileSync(join(home, `gate-${index}`), "continue"),
    async close() {
      for (const proc of processes) proc.kill("SIGKILL");
      await Promise.all([...processes].map((proc) => proc.exited));
      db.close();
      talk.close();
      for (const path of [getLockPath(trigger, key), getSocketPath(trigger, key)]) rmSync(path, { force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("acknowledged socket input survives SIGKILL, completes on its own turn, and completed IDs do not replay", async () => {
  const f = fixture();
  try {
    const args = [trigger, "first", f.key, "--event-id", "event-1"];
    const initial = f.spawn(args, { DELIVERY_GATES: "1" });
    await waitFor(() => f.seen().length === 1 && existsSync(getSocketPath(trigger, f.key)));
    expect(f.receipt("event-1")?.state).toBe("accepted");
    // No native transcript exists in this fake backend. Delivery must still
    // reach the live socket instead of waiting for the session-file guard.
    const queued = await f.spawn([trigger, "second", f.key, "--event-id", "event-2"]).finished;
    expect({ code: queued.code, stderr: queued.stderr }).toEqual({ code: 0, stderr: "" });
    const second = { message: "second", channel: "internal", sessionKey: f.key, eventId: "event-2" };
    expect(await sendSocketMessage(getSocketPath(trigger, f.key), second)).toEqual({ ok: true, eventId: "event-2", state: "accepted" });
    expect(await sendSocketMessage(getSocketPath(trigger, f.key), second)).toEqual({ ok: true, eventId: "event-2", state: "accepted" });
    expect(f.seen()).toEqual(["first"]);

    // A process death after the ack must leave both complete payloads recoverable.
    initial.proc.kill("SIGKILL");
    expect((await initial.finished).code).not.toBe(0);
    expect(isPidAlive(getTriggerDeliveryOwner(f.db, trigger, f.key))).toBe(false);
    expect(f.receipt("event-1")?.state).toBe("accepted");
    expect(f.receipt("event-2")?.message).toBe("second");

    f.gate(0);
    const recovery = f.spawn(args, { DELIVERY_GATES: "1" });
    await waitFor(() => f.receipt("event-1")?.state === "completed" && f.seen().length === 3);
    expect(f.receipt("event-2")?.state).toBe("accepted");
    expect(f.seen()).toEqual(["first", "first", "second"]);
    f.gate(1);
    const recovered = await recovery.finished;
    expect({ code: recovered.code, stderr: recovered.stderr }).toEqual({ code: 0, stderr: "" });
    expect(f.receipt("event-2")?.state).toBe("completed");
    expect(f.receipt("event-2")?.sessionId).toBe("delivery-session");

    const duplicate = await f.spawn(args).finished;
    expect({ code: duplicate.code, stderr: duplicate.stderr }).toEqual({ code: 0, stderr: "" });
    expect(f.seen()).toEqual(["first", "first", "second"]);
    const inspection = await f.spawn(["--receipt", trigger, f.key, "event-2"]).finished;
    expect(JSON.parse(inspection.stdout).state).toBe("completed");
  } finally { await f.close(); }
}, 15_000);

test("an idle runner recovers persisted input when the sender died before socket handoff", async () => {
  const f = fixture();
  try {
    const worker = f.spawn([trigger, "legacy", f.key]);
    await waitFor(() => f.seen().length === 1);
    acceptTriggerReceipt(f.db, {
      triggerName: trigger, sessionKey: f.key, eventId: "orphaned", channel: "internal", message: "recover me",
    });
    const result = await worker.finished;
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(f.seen()).toEqual(["legacy", "recover me"]);
    expect(f.receipt("orphaned")?.state).toBe("completed");
  } finally { await f.close(); }
}, 10_000);

test("failed turns retain their receipt and do not consume later input", async () => {
  const f = fixture();
  try {
    for (const [eventId, message] of [["event-1", "first"], ["event-2", "second"]]) {
      acceptTriggerReceipt(f.db, {
        triggerName: trigger, sessionKey: f.key, eventId, channel: "internal", message, payload: message,
      });
    }
    const result = await f.spawn([trigger, "first", f.key, "--event-id", "event-1"], { DELIVERY_FAIL: "1" }).finished;
    expect(result.stderr).toBe("");
    expect(f.seen()).toEqual(["first"]);
    expect(f.receipt("event-1")?.state).toBe("accepted");
    expect(f.receipt("event-2")?.state).toBe("accepted");
  } finally { await f.close(); }
}, 10_000);

test("durable socket delivery rejects another route, changed input, and unsafe retirement", async () => {
  const f = fixture();
  try {
    const worker = f.spawn([trigger, "first", f.key, "--event-id", "event-1"], { DELIVERY_GATES: "1", DELIVERY_INPUTS: "1" });
    await waitFor(() => f.seen().length === 1 && existsSync(getSocketPath(trigger, f.key)));
    const path = getSocketPath(trigger, f.key);
    const message = { message: "first", channel: "internal", sessionKey: f.key, eventId: "event-1" };
    expect((await sendSocketMessage(path, { ...message, sessionKey: "other" }))?.ok).toBe(false);
    expect((await sendSocketMessage(path, { ...message, channel: "email" }))?.ok).toBe(false);
    expect((await sendSocketMessage(path, { ...message, message: "changed" }))?.ok).toBe(false);
    expect((await sendSocketMessage(path, { message: "bye", channel: "internal", sessionKey: f.key, control: "retire" }))?.ok).toBe(false);
    expect(f.seen()).toEqual(["first"]);
    expect(f.receipt("event-1")?.message).toBe("first");
    f.gate(0);
    expect((await worker.finished).stderr).toBe("");
  } finally { await f.close(); }
}, 10_000);

test("a Talk answer accepted while another turn runs is skipped if its task closes before the next turn", async () => {
  const f = fixture();
  try {
    f.db.query("INSERT INTO tasks (id,title,trigger_name,session_key,status) VALUES (42,'Await answer',?,?,'open')").run(trigger, f.key);
    const worker = f.spawn([trigger, "first", f.key, "--event-id", "first"], { DELIVERY_GATES: "1" });
    await waitFor(() => f.seen().length === 1 && existsSync(getSocketPath(trigger, f.key)));
    const answer = JSON.stringify({ type: "talk_message", address: { instance: "test-account", room: "room1" }, request: {
      taskId: 42, originTrigger: trigger, originSessionKey: f.key,
    }, message: { text: "Go ahead" } });
    const queued = await f.spawn([trigger, answer, f.key, "--event-id", "answer"]).finished;
    expect(queued.code).toBe(0);
    expect(f.receipt("answer")?.state).toBe("accepted");
    f.db.query("UPDATE tasks SET status='done' WHERE id=42").run();
    f.gate(0);
    await waitFor(() => f.receipt("answer")?.state === "completed");
    expect(f.receipt("answer")?.completionReason).toContain("skipped:");
    expect(f.receipt("answer")?.completionReason).toContain("no longer active");
    expect(f.seen()).toEqual(["first"]);
    expect((await worker.finished).stderr).toBe("");
  } finally { await f.close(); }
}, 10_000);

test("a Talk message accepted before room revocation is skipped before its queued turn starts", async () => {
  const f = fixture();
  try {
    const worker = f.spawn([trigger, "first", f.key, "--event-id", "first"], { DELIVERY_GATES: "1" });
    await waitFor(() => f.seen().length === 1 && existsSync(getSocketPath(trigger, f.key)));
    const message = JSON.stringify({ type: "talk_message", address: { instance: "test-account", room: "room1" }, message: { text: "Do the next task" } });
    expect((await f.spawn([trigger, message, f.key, "--event-id", "revoked"]).finished).code).toBe(0);
    expect(f.receipt("revoked")?.state).toBe("accepted");
    f.talk.revokeRoom("test-account", "room1");
    f.gate(0);
    await waitFor(() => f.receipt("revoked")?.state === "completed");
    expect(f.receipt("revoked")?.completionReason).toContain("room is no longer enabled");
    expect(f.seen()).toEqual(["first"]);
    expect((await worker.finished).stderr).toBe("");
  } finally { await f.close(); }
}, 10_000);

test("a completed Talk ID remains deduplicated after raw content pruning and prompt configuration changes", async () => {
  const f = fixture();
  try {
    const args = [trigger, "private answer", f.key, "--event-id", "talk:completed"];
    expect((await f.spawn(args, { DELIVERY_INPUTS: "1" }).finished).code).toBe(0);
    f.db.exec("UPDATE trigger_delivery_receipts SET completed_at='2000-01-01T00:00:00.000Z' WHERE state='completed'");
    expect(pruneCompletedTriggerReceipts(f.db)).toBe(1);
    f.db.query("UPDATE triggers SET prompt='Changed renderer: {{payload}}' WHERE name=?").run(trigger);
    const duplicate = await f.spawn(args).finished;
    expect({ code: duplicate.code, stderr: duplicate.stderr }).toEqual({ code: 0, stderr: "" });
    expect(f.seen()).toEqual(["private answer"]);
    expect(f.receipt("talk:completed")?.message).toBe("");
    expect(f.receipt("talk:completed")?.payload).toBeNull();
    const changed = await f.spawn([trigger, "different answer", f.key, "--event-id", "talk:completed"]).finished;
    expect(changed.code).not.toBe(0);
    expect(changed.stderr).toContain("different payload");
    expect(f.seen()).toEqual(["private answer"]);
  } finally { await f.close(); }
}, 10_000);
