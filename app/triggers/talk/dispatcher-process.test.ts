import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isPidAlive } from "../../lib/trigger-socket.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Detached worker did not reach the expected state");
    await Bun.sleep(10);
  }
}

function processGroup(pid: number): number {
  const result = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`Cannot inspect process group for ${pid}`);
  const pgid = Number(result.stdout.toString().trim());
  if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new Error("Invalid process group");
  return pgid;
}

test("default dispatcher workers survive termination of the listener's isolated process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-talk-detached-"));
  const parentFile = join(dir, "parent.json"), workerFile = join(dir, "worker.json"), heartbeat = join(dir, "heartbeat");
  const worker = join(dir, "worker.ts"), shell = join(dir, "worker.sh"), driver = join(dir, "listener.ts");
  writeFileSync(worker, `
import { writeFileSync } from "node:fs";
const group = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)], { stdout: "pipe" });
writeFileSync(${JSON.stringify(workerFile)}, JSON.stringify({ pid: process.pid, pgid: Number(group.stdout.toString().trim()) }));
let ticks = 0;
setInterval(() => writeFileSync(${JSON.stringify(heartbeat)}, String(++ticks)), 20);
`);
  writeFileSync(shell, 'exec "$ATLAS_TEST_BUN" "$ATLAS_TEST_WORKER"\n');
  writeFileSync(driver, `
import { writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { TalkLedger } from ${JSON.stringify(join(import.meta.dir, "ledger.ts"))};
import { TalkDispatcher } from ${JSON.stringify(join(import.meta.dir, "runtime.ts"))};
const db = new Database(":memory:");
db.exec("CREATE TABLE triggers(name TEXT PRIMARY KEY,enabled INTEGER,session_mode TEXT); INSERT INTO triggers VALUES ('worker',1,'persistent')");
const ledger = new TalkLedger(":memory:");
ledger.db.query("INSERT INTO talk_deliveries(id,event_id,instance,room,conversation_id,trigger_name,session_key,payload,priority,created_at) VALUES ('delivery','talk:event','test','room','conversation','worker','session','{}',1,1)").run();
new TalkDispatcher(ledger, db, "test", { script: ${JSON.stringify(shell)} }).tick();
const group = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)], { stdout: "pipe" });
writeFileSync(${JSON.stringify(parentFile)}, JSON.stringify({ pid: process.pid, pgid: Number(group.stdout.toString().trim()) }));
setInterval(() => {}, 1000);
`);
  const ownGroup = processGroup(process.pid);
  const parent = Bun.spawn([process.execPath, driver], {
    detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
    env: { ...process.env, ATLAS_TEST_BUN: process.execPath, ATLAS_TEST_WORKER: worker },
  });
  let workerPid: number | undefined;
  try {
    await waitFor(() => existsSync(parentFile) && existsSync(workerFile) && existsSync(heartbeat));
    const listener = JSON.parse(readFileSync(parentFile, "utf8")) as { pid: number; pgid: number };
    const spawned = JSON.parse(readFileSync(workerFile, "utf8")) as { pid: number; pgid: number };
    workerPid = spawned.pid;
    // Verify isolation before sending a group signal: never signal the test runner's group.
    expect(listener.pid).toBe(parent.pid);
    expect(listener.pgid).toBe(parent.pid);
    expect(listener.pgid).not.toBe(ownGroup);
    expect(spawned.pgid).toBe(spawned.pid);
    expect(spawned.pgid).not.toBe(listener.pgid);
    const before = Number(readFileSync(heartbeat, "utf8"));
    process.kill(-listener.pgid, "SIGTERM");
    await parent.exited;
    expect(isPidAlive(spawned.pid)).toBe(true);
    await waitFor(() => Number(readFileSync(heartbeat, "utf8")) > before);
  } finally {
    parent.kill("SIGKILL");
    await parent.exited;
    if (workerPid === undefined && existsSync(workerFile)) workerPid = JSON.parse(readFileSync(workerFile, "utf8")).pid;
    if (workerPid && workerPid !== process.pid) {
      try { process.kill(workerPid, "SIGKILL"); } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);
