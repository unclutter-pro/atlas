import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("/new retire hands the chat over at once and runs the farewell as the last turn", async () => {
  const home = mkdtempSync(join(tmpdir(), "atlas-retire-"));
  const driver = join(home, "driver.ts");
  const key = `retire-${Date.now()}`;
  writeFileSync(driver, `
import { existsSync } from "node:fs";
import { getDb } from ${JSON.stringify(join(import.meta.dir, "../../lib/atlas-db.ts"))};
import { getLockPath, getRetiringPath, getSocketPath, readLockPid } from ${JSON.stringify(join(import.meta.dir, "../../lib/trigger-socket.ts"))};
import { injectIntoRunner, main, runnerDeps } from ${JSON.stringify(join(import.meta.dir, "../trigger-runner.ts"))};
import { ClaudeCodeBackend } from ${JSON.stringify(join(import.meta.dir, "claude/backend.ts"))};
const KEY = ${JSON.stringify(key)};
const db = getDb();
db.prepare("INSERT INTO triggers (name, type, channel, prompt, session_mode) VALUES ('retire-check', 'manual', 'internal', '{{payload}}', 'persistent')").run();
const received: string[] = [];
let firstTurnDone!: () => void;
const firstTurn = new Promise<void>((resolve) => { firstTurnDone = resolve; });
// Holds the farewell turn open until the handover was checked.
let releaseFarewell!: () => void;
const farewellGate = new Promise<void>((resolve) => { releaseFarewell = resolve; });
const query = ((request) => {
  async function* events() {
    const input = request.prompt[Symbol.asyncIterator]();
    await input.next();
    yield { type: "system", subtype: "init", session_id: "old-session" };
    yield { type: "result", subtype: "success", session_id: "old-session", num_turns: 1, result: "first" };
    firstTurnDone();
    const farewell = await input.next();
    if (farewell.done) return;
    received.push(farewell.value.message.content);
    await farewellGate;
    yield { type: "result", subtype: "success", session_id: "old-session", num_turns: 1, result: "saved" };
    await input.next();
  }
  return Object.assign(events(), { close() {}, async interrupt() {} });
}) as any;
runnerDeps.createBackend = () => new ClaudeCodeBackend({ query });
process.argv = [process.argv[0], "trigger-runner.ts", "retire-check", "hello", KEY];
const run = main();
await firstTurn;
await Bun.sleep(100);
const lock = getLockPath("retire-check", KEY);
if (readLockPid(lock) !== process.pid) throw new Error("runner should hold the lock during the session");
// The addon deletes the mapping right after retiring, as /new does.
const code = await injectIntoRunner("retire-check", KEY, "FAREWELL", "internal", "retire");
db.prepare("DELETE FROM trigger_sessions WHERE trigger_name = 'retire-check' AND session_key = ?").run(KEY);
const handedOver = !existsSync(lock) && !existsSync(getSocketPath("retire-check", KEY))
  && readLockPid(getRetiringPath("retire-check", KEY)) === process.pid;
releaseFarewell();
await run;
const mapping = db.query("SELECT session_id FROM trigger_sessions WHERE trigger_name = 'retire-check' AND session_key = ?").get(KEY);
console.log("RESULT=" + JSON.stringify({ code, handedOver, received, mapping, retiringLeft: existsSync(getRetiringPath("retire-check", KEY)) }));
process.exit(0);
`);
  try {
    const proc = Bun.spawn(["bun", driver], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const result = JSON.parse(stdout.match(/RESULT=(.*)/)![1]!);
    expect(result).toEqual({ code: 0, handedOver: true, received: ["FAREWELL"], mapping: null, retiringLeft: false });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30_000);

test("retire mid-turn: the running turn finishes before the farewell runs as the final turn", async () => {
  const home = mkdtempSync(join(tmpdir(), "atlas-retire-midturn-"));
  const driver = join(home, "driver.ts");
  const key = `retire-midturn-${Date.now()}`;
  writeFileSync(driver, `
import { existsSync } from "node:fs";
import { getDb } from ${JSON.stringify(join(import.meta.dir, "../../lib/atlas-db.ts"))};
import { getLockPath, getRetiringPath, getSocketPath, readLockPid } from ${JSON.stringify(join(import.meta.dir, "../../lib/trigger-socket.ts"))};
import { injectIntoRunner, main, runnerDeps } from ${JSON.stringify(join(import.meta.dir, "../trigger-runner.ts"))};
import { ClaudeCodeBackend } from ${JSON.stringify(join(import.meta.dir, "claude/backend.ts"))};
const KEY = ${JSON.stringify(key)};
const db = getDb();
db.prepare("INSERT INTO triggers (name, type, channel, prompt, session_mode) VALUES ('retire-midturn', 'manual', 'internal', '{{payload}}', 'persistent')").run();
const received: string[] = [];
let turnStarted!: () => void;
const turnInFlight = new Promise<void>((resolve) => { turnStarted = resolve; });
// Holds the first turn open so retire arrives while inTurn === true.
let releaseFirstTurn!: () => void;
const firstTurnGate = new Promise<void>((resolve) => { releaseFirstTurn = resolve; });
const query = ((request) => {
  async function* events() {
    const input = request.prompt[Symbol.asyncIterator]();
    await input.next();
    yield { type: "system", subtype: "init", session_id: "old-session" };
    // Signal the driver that the turn is under way, then hold it open.
    turnStarted();
    await firstTurnGate;
    yield { type: "result", subtype: "success", session_id: "old-session", num_turns: 1, result: "first" };
    const farewell = await input.next();
    if (farewell.done) return;
    received.push(farewell.value.message.content);
    yield { type: "result", subtype: "success", session_id: "old-session", num_turns: 1, result: "saved" };
    await input.next();
  }
  return Object.assign(events(), { close() {}, async interrupt() {} });
}) as any;
runnerDeps.createBackend = () => new ClaudeCodeBackend({ query });
process.argv = [process.argv[0], "trigger-runner.ts", "retire-midturn", "hello", KEY];
const run = main();
await turnInFlight;
await Bun.sleep(100);
const lock = getLockPath("retire-midturn", KEY);
if (readLockPid(lock) !== process.pid) throw new Error("runner should hold the lock while the turn runs");
// Retire arrives while the first turn is still in flight (inTurn === true).
const code = await injectIntoRunner("retire-midturn", KEY, "FAREWELL", "internal", "retire");
db.prepare("DELETE FROM trigger_sessions WHERE trigger_name = 'retire-midturn' AND session_key = ?").run(KEY);
const handedOverMidTurn = !existsSync(lock) && !existsSync(getSocketPath("retire-midturn", KEY))
  && readLockPid(getRetiringPath("retire-midturn", KEY)) === process.pid;
// The running turn hasn't finished yet — the farewell must not have been sent.
const receivedBeforeTurnEnds = [...received];
releaseFirstTurn();
await run;
const mapping = db.query("SELECT session_id FROM trigger_sessions WHERE trigger_name = 'retire-midturn' AND session_key = ?").get(KEY);
console.log("RESULT=" + JSON.stringify({ code, handedOverMidTurn, receivedBeforeTurnEnds, received, mapping, retiringLeft: existsSync(getRetiringPath("retire-midturn", KEY)) }));
process.exit(0);
`);
  try {
    const proc = Bun.spawn(["bun", driver], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const result = JSON.parse(stdout.match(/RESULT=(.*)/)![1]!);
    expect(result).toEqual({
      code: 0,
      handedOverMidTurn: true,
      receivedBeforeTurnEnds: [],
      received: ["FAREWELL"],
      mapping: null,
      retiringLeft: false,
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30_000);

test("a failing final turn after hand-over does not delete the successor's session or reopen a conversation", async () => {
  const home = mkdtempSync(join(tmpdir(), "atlas-retire-resume-fail-"));
  const driver = join(home, "driver.ts");
  const key = `retire-resume-fail-${Date.now()}`;
  writeFileSync(driver, `
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from ${JSON.stringify(join(import.meta.dir, "../../lib/atlas-db.ts"))};
import { getRetiringPath, readLockPid } from ${JSON.stringify(join(import.meta.dir, "../../lib/trigger-socket.ts"))};
import { injectIntoRunner, main, runnerDeps } from ${JSON.stringify(join(import.meta.dir, "../trigger-runner.ts"))};
import { ClaudeCodeBackend } from ${JSON.stringify(join(import.meta.dir, "claude/backend.ts"))};
const KEY = ${JSON.stringify(key)};
const home = process.env.HOME;
const db = getDb();
db.prepare("INSERT INTO triggers (name, type, channel, prompt, session_mode) VALUES ('retire-resume-fail', 'manual', 'internal', '{{payload}}', 'persistent')").run();
// A pre-existing session this run resumes: a real transcript file so the
// runner's "does the session file exist" guard passes, plus the mapping row.
const projectDir = join(home, ".claude", "projects", "proj");
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, "old-session.jsonl"), "");
db.prepare("INSERT INTO trigger_sessions (trigger_name, session_key, session_id) VALUES ('retire-resume-fail', ?, 'old-session')").run(KEY);
let firstTurnDone!: () => void;
const firstTurn = new Promise<void>((resolve) => { firstTurnDone = resolve; });
// Holds the farewell's (failing) result open until the successor has
// registered its own mapping, matching the real hand-over race.
let releaseFailure!: () => void;
const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
let queryCalls = 0;
const query = ((request) => {
  queryCalls++;
  const callNum = queryCalls;
  async function* events() {
    // A second, post-hand-over call would mean the retry path reopened a
    // conversation (and tried to rebind the socket) — the bug under test.
    if (callNum > 1) return;
    const input = request.prompt[Symbol.asyncIterator]();
    await input.next();
    yield { type: "system", subtype: "init", session_id: "old-session" };
    yield { type: "result", subtype: "success", session_id: "old-session", num_turns: 1, result: "first" };
    firstTurnDone();
    const farewell = await input.next();
    if (farewell.done) return;
    await failureGate;
    // The farewell turn itself fails with 0 turns — the condition that
    // sends the resume branch into its catch block.
    yield { type: "result", subtype: "error", session_id: "old-session", num_turns: 0, result: "boom" };
  }
  return Object.assign(events(), { close() {}, async interrupt() {} });
}) as any;
runnerDeps.createBackend = () => new ClaudeCodeBackend({ query });
process.argv = [process.argv[0], "trigger-runner.ts", "retire-resume-fail", "hello", KEY];
const run = main();
await firstTurn;
await Bun.sleep(100);
const code = await injectIntoRunner("retire-resume-fail", KEY, "FAREWELL", "internal", "retire");
// The addon deletes the mapping and the successor writes its own row early
// (on its first "session" event), exactly as /new's hand-over does.
db.prepare("DELETE FROM trigger_sessions WHERE trigger_name = 'retire-resume-fail' AND session_key = ?").run(KEY);
db.prepare("INSERT INTO trigger_sessions (trigger_name, session_key, session_id) VALUES ('retire-resume-fail', ?, 'successor-session')").run(KEY);
releaseFailure();
await run;
const mapping = db.query("SELECT session_id FROM trigger_sessions WHERE trigger_name = 'retire-resume-fail' AND session_key = ?").get(KEY);
console.log("RESULT=" + JSON.stringify({ code, mapping, queryCalls, retiringLeft: existsSync(getRetiringPath("retire-resume-fail", KEY)) }));
process.exit(0);
`);
  try {
    const proc = Bun.spawn(["bun", driver], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const result = JSON.parse(stdout.match(/RESULT=(.*)/)![1]!);
    expect(result).toEqual({
      code: 0,
      mapping: { session_id: "successor-session" },
      queryCalls: 1,
      retiringLeft: false,
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30_000);
