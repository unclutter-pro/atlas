import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchWorker } from "./runtime.ts";

function withDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "github-dispatch-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("dispatchWorker passes trigger, payload and slug and accepts a runner that exits 0", withDir(async (dir) => {
  const script = join(dir, "trigger.sh");
  const out = join(dir, "args");
  writeFileSync(script, `printf '%s\\n' "$@" > ${out}\n`);
  await dispatchWorker("github-worker", '{"_router":{}}', "login-bug", { triggerSh: script, lockPath: join(dir, "lock"), pollMs: 10 });
  expect(readFileSync(out, "utf8")).toBe('github-worker\n{"_router":{}}\nlogin-bug\n');
}));

test("dispatchWorker accepts a runner that holds the session lock", withDir(async (dir) => {
  const script = join(dir, "trigger.sh");
  const lock = join(dir, "lock");
  // Like trigger-runner: write own PID to the lock, then keep running.
  writeFileSync(script, `echo $$ > ${lock}\nexec sleep 5\n`);
  const started = Date.now();
  await dispatchWorker("github-worker", "{}", "x", { triggerSh: script, lockPath: lock, pollMs: 10 });
  expect(Date.now() - started).toBeLessThan(3000);
  process.kill(Number(readFileSync(lock, "utf8").trim()), "SIGTERM");
}));

test("dispatchWorker rejects a runner that exits non-zero, a missing script and a timeout", withDir(async (dir) => {
  const failing = join(dir, "fail.sh");
  writeFileSync(failing, "exit 1\n");
  await expect(dispatchWorker("github-worker", "{}", "x", { triggerSh: failing, lockPath: join(dir, "lock"), pollMs: 10 }))
    .rejects.toThrow("exited 1");
  await expect(dispatchWorker("github-worker", "{}", "x", { triggerSh: join(dir, "missing.sh") })).rejects.toThrow("not found");
  const stuck = join(dir, "stuck.sh");
  const pidFile = join(dir, "pid");
  writeFileSync(stuck, `echo $$ > ${pidFile}\nexec sleep 30\n`);
  await expect(dispatchWorker("github-worker", "{}", "x", { triggerSh: stuck, lockPath: join(dir, "lock"), timeoutMs: 300, pollMs: 10 }))
    .rejects.toThrow("did not take the event");
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  await Bun.sleep(100);
  expect(() => process.kill(pid, 0)).toThrow();
}));
