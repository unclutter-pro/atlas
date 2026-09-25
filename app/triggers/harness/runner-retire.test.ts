import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
