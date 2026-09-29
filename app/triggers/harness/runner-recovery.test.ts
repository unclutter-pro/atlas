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

test("a refused credential ends the session at once, keeps its mapping and records the failure", async () => {
  const home = mkdtempSync(join(tmpdir(), "atlas-resume-auth-"));
  const driver = join(home, "driver.ts");
  const key = `auth-${Date.now()}`;
  writeFileSync(driver, `
import { mkdirSync, writeFileSync } from "node:fs";
import { getDb } from ${JSON.stringify(join(import.meta.dir, "../../lib/atlas-db.ts"))};
import { readAuthFailure } from ${JSON.stringify(join(import.meta.dir, "../../lib/harness/auth.ts"))};
import { main, runnerDeps } from ${JSON.stringify(join(import.meta.dir, "../trigger-runner.ts"))};
import { ClaudeCodeBackend } from ${JSON.stringify(join(import.meta.dir, "claude/backend.ts"))};
const db = getDb();
db.prepare("INSERT INTO triggers (name, type, channel, prompt, session_mode) VALUES ('auth-check', 'manual', 'internal', '{{payload}}', 'persistent')").run();
db.prepare("INSERT INTO trigger_sessions (trigger_name, session_key, session_id) VALUES ('auth-check', ?, 'kept-session')").run(${JSON.stringify(key)});
const dir = process.env.HOME + "/.claude/projects/p";
mkdirSync(dir, {recursive: true});
writeFileSync(dir + "/kept-session.jsonl", "{}\\n");
let attempts = 0;
const query = ((request) => {
  attempts++;
  // Like the CLI, stay open for more input until the runner closes the query.
  let closed: () => void;
  const whenClosed = new Promise<void>((r) => (closed = r));
  async function* events() {
    await request.prompt[Symbol.asyncIterator]().next();
    yield {type:"result",subtype:"success",is_error:true,session_id:"kept-session",num_turns:0,result:"Invalid API key · Please run /login"};
    await whenClosed;
  }
  return Object.assign(events(), {close() { closed(); }, async interrupt() {}});
}) as any;
runnerDeps.createBackend = () => new ClaudeCodeBackend({ query });
process.argv = [process.argv[0], "trigger-runner.ts", "auth-check", "hello", ${JSON.stringify(key)}];
await main();
const row = db.query("SELECT session_id FROM trigger_sessions WHERE trigger_name='auth-check' AND session_key=?").get(${JSON.stringify(key)});
const failure = readAuthFailure(db, "claude-code");
if (attempts !== 1) throw new Error("Retried a refused credential: " + attempts);
if (row?.session_id !== "kept-session") throw new Error("Session mapping lost");
if (!failure?.message.includes("/login")) throw new Error("Failure not recorded");
console.log("AUTH_OK");
process.exit(0);
`);
  try {
    const proc = Bun.spawn(["bun", driver], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("AUTH_OK");
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30_000);
