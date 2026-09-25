import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("failed resume retries with a fresh input channel and persists the replacement session", async () => {
  const home = mkdtempSync(join(tmpdir(), "atlas-resume-retry-"));
  const driver = join(home, "driver.ts");
  const key = `retry-${Date.now()}`;
  writeFileSync(driver, `
import { mkdirSync, writeFileSync } from "node:fs";
import { getDb } from ${JSON.stringify(join(import.meta.dir, "../../lib/atlas-db.ts"))};
import { main, runnerDeps } from ${JSON.stringify(join(import.meta.dir, "../trigger-runner.ts"))};
import { ClaudeCodeBackend } from ${JSON.stringify(join(import.meta.dir, "claude/backend.ts"))};
const db = getDb();
db.prepare("INSERT INTO triggers (name, type, channel, prompt, session_mode) VALUES ('retry-check', 'manual', 'internal', '{{payload}}', 'persistent')").run();
db.prepare("INSERT INTO trigger_sessions (trigger_name, session_key, session_id) VALUES ('retry-check', ?, 'old-session')").run(${JSON.stringify(key)});
const dir = process.env.HOME + "/.claude/projects/p";
mkdirSync(dir, {recursive: true});
writeFileSync(dir + "/old-session.jsonl", "{}\\n");
let attempts = 0;
const query = ((request) => {
  const attempt = ++attempts;
  async function* events() {
    const first = await request.prompt[Symbol.asyncIterator]().next();
    if (first.done || !first.value.message.content.includes("recover-me")) throw new Error("Retry lost its input");
    if (attempt === 1) {
      if (request.options.resume !== "old-session") throw new Error("Expected resume");
      yield {type:"result",subtype:"error_during_execution",session_id:"old-session",num_turns:0};
    } else {
      if (request.options.resume) throw new Error("Retry must start fresh");
      yield {type:"system",subtype:"init",session_id:"replacement-session"};
      yield {type:"result",subtype:"success",session_id:"replacement-session",num_turns:1,result:"recovered"};
    }
  }
  return Object.assign(events(), {close() {}, async interrupt() {}});
}) as any;
runnerDeps.createBackend = () => new ClaudeCodeBackend({ query });
process.argv = [process.argv[0], "trigger-runner.ts", "retry-check", "recover-me", ${JSON.stringify(key)}];
await main();
const row = db.query("SELECT session_id FROM trigger_sessions WHERE trigger_name='retry-check' AND session_key=?").get(${JSON.stringify(key)});
if (attempts !== 2 || row?.session_id !== "replacement-session") throw new Error("Recovery failed");
console.log("RECOVERY_OK");
process.exit(0);
`);
  try {
    const proc = Bun.spawn(["bun", driver], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("RECOVERY_OK");
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30_000);
