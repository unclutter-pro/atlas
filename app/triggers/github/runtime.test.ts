import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchWorker } from "./runtime.ts";

test("dispatchWorker passes trigger, payload and slug, and rejects when it cannot start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "github-dispatch-"));
  try {
    const script = join(dir, "trigger.sh");
    const out = join(dir, "args");
    writeFileSync(script, `printf '%s\\n' "$@" > ${out}\n`);
    await dispatchWorker("github-worker", '{"_router":{}}', "login-bug", script);
    for (let i = 0; i < 100 && !existsSync(out); i++) await Bun.sleep(10);
    expect(readFileSync(out, "utf8")).toBe('github-worker\n{"_router":{}}\nlogin-bug\n');
    await expect(dispatchWorker("github-worker", "{}", "x", join(dir, "missing.sh"))).rejects.toThrow("not found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
