/**
 * Manual integration check; invokes a real model using existing credentials.
 * Run: cd app/triggers && bun harness/live-smoke.ts
 * Checks SDK option parity, live tool discovery, resume and history.
 * Not included in bun test. Each query has a 90-second timeout.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeBackend } from "./claude/backend.ts";
import { DISALLOWED_BUILTIN_TOOLS } from "./claude/policy.ts";
const cwd = mkdtempSync(join(tmpdir(), "atlas-live-harness-"));
const executable = Bun.which("claude");
if (!executable) throw new Error("Install and authenticate Claude Code before running this smoke test");
const factory: typeof query = (request) => query({ ...request, options: { ...request.options, pathToClaudeCodeExecutable: executable } });
delete process.env.CLAUDECODE;
const prompt = "Reply exactly HARNESS_SMOKE_OK. Do not use any tools.";
const systemPrompt = "This is a harmless integration smoke test. Answer the user directly without using tools.";
const baseline = {
  systemPrompt, model: "haiku", mcpServers: {}, permissionMode: "bypassPermissions" as const,
  allowDangerouslySkipPermissions: true, settings: { autoMemoryEnabled: false },
  disallowedTools: DISALLOWED_BUILTIN_TOOLS, cwd, persistSession: false,
};
async function collect(q: ReturnType<typeof query>) {
  const timer = setTimeout(() => q.close(), 90_000);
  let init: any;
  let result: any;
  try {
    for await (const event of q) {
      if (event.type === "system" && event.subtype === "init") init = {
        model: event.model, tools: [...event.tools].sort(), agents: [...(event.agents ?? [])].sort(), permissionMode: event.permissionMode,
      };
      if (event.type === "result") { result = { subtype: event.subtype, text: "result" in event ? event.result : event.errors }; break; }
    }
  } finally { clearTimeout(timer); q.close(); }
  if (result?.subtype !== "success") throw new Error(JSON.stringify(result));
  return { init, result };
}
try {
  const before = await collect(factory({ prompt, options: baseline }));
  const backend = new ClaudeCodeBackend({ query: factory });
  const after = await collect(backend.openConversation({ prompt, systemPrompt, model: "haiku", mcpServers: {}, cwd, persistSession: false }));
  if (JSON.stringify(before.init) !== JSON.stringify(after.init)) throw new Error("Tool/model init parity mismatch");
  console.log(JSON.stringify({ check: "live compatibility parity", baseline: before, adapter: after }));
  const session = await backend.create({ cwd, systemPrompt, model: { tier: "fast", model: { provider: "anthropic", model: "haiku" } }, toolEnvironment: {}, nativeTools: [] }, { tools: [] });
  for (let n = 0; n < 2; n++) {
    const run = session.run({ runId: `live-${n}`, input: [{ id: `input-${n}`, content: [{ type: "text", text: prompt }] }] });
    const timer = setTimeout(() => { void run.abort(); }, 90_000);
    const events: string[] = [];
    for await (const event of run.events) events.push(event.type);
    const result = await run.finished;
    clearTimeout(timer);
    console.log(JSON.stringify({ check: n ? "live resume" : "live portable run", outcome: result.outcome, usage: result.usage, events, ...(result.outcome === "failed" ? { error: result.error } : {}) }));
    if (result.outcome !== "completed") throw new Error("Portable run failed");
  }
  const history = await backend.history(session.ref);
  console.log(JSON.stringify({ check: "live history", messages: history.messages.length }));
  if (history.messages.length < 4) throw new Error("Resume/history lost messages");
  await session.close();
} finally { rmSync(cwd, { recursive: true, force: true }); }
