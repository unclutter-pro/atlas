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
const initOf = (event: any) => ({
  model: event.model, tools: [...event.tools].sort(), agents: [...(event.agents ?? [])].sort(), permissionMode: event.permissionMode,
});
async function collect(q: ReturnType<typeof query>) {
  const timer = setTimeout(() => q.close(), 90_000);
  let init: any;
  let result: any;
  try {
    for await (const event of q) {
      if (event.type === "system" && event.subtype === "init") init = initOf(event);
      if (event.type === "result") { result = { subtype: event.subtype, text: "result" in event ? event.result : event.errors }; break; }
    }
  } finally { clearTimeout(timer); q.close(); }
  if (result?.subtype !== "success") throw new Error(JSON.stringify(result));
  return { init, result };
}
/** The SDK's init message behind the adapter, observed without consuming the stream. */
let adapterInit: any;
const observed = ((request: Parameters<typeof query>[0]) => {
  const q = factory(request);
  async function* tee() {
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") adapterInit = initOf(message);
      yield message;
    }
  }
  return Object.assign(tee(), { close: () => q.close(), interrupt: () => q.interrupt() });
}) as unknown as typeof query;
try {
  const before = await collect(factory({ prompt, options: baseline }));
  const backend = new ClaudeCodeBackend({ query: observed, prepareEnvironment: false });
  const conversation = backend.openConversation({ prompt, systemPrompt, model: "haiku", mcpServers: {}, cwd, turns: "single", ephemeral: true });
  const timer = setTimeout(() => conversation.stop(), 90_000);
  let turn: any;
  try {
    for await (const event of conversation) if (event.type === "turn.finished") { turn = event.result; break; }
  } finally { clearTimeout(timer); conversation.stop(); }
  if (turn?.outcome !== "completed") throw new Error(JSON.stringify(turn));
  const after = { init: adapterInit, result: { outcome: turn.outcome, text: turn.text, usage: turn.usage } };
  if (JSON.stringify(before.init) !== JSON.stringify(after.init)) throw new Error(`Tool/model init parity mismatch: ${JSON.stringify({ before: before.init, after: after.init })}`);
  console.log(JSON.stringify({ check: "live conversation parity", baseline: before, adapter: after }));
  // A stored conversation, then a resume of it: the resumed turn's usage must
  // be complete (baseline found) and cover only that turn.
  const turnOf = async (c: ReturnType<typeof backend.openConversation>) => {
    const t = setTimeout(() => c.stop(), 90_000);
    try {
      for await (const event of c) if (event.type === "turn.finished") return event.result;
    } finally { clearTimeout(t); c.stop(); }
    throw new Error("Conversation ended without a turn");
  };
  const stored = await turnOf(backend.openConversation({ prompt, systemPrompt, model: "haiku", mcpServers: {}, cwd, turns: "single" }));
  const resumed = await turnOf(backend.openConversation({ prompt, systemPrompt, model: "haiku", mcpServers: {}, cwd, turns: "single", resume: stored.session! }));
  console.log(JSON.stringify({ check: "live conversation resume", first: stored.usage, resumed: resumed.usage, session: resumed.session }));
  if (resumed.session?.nativeId !== stored.session?.nativeId) throw new Error("Resume changed the session");
  if (resumed.usage.completeness !== "complete") throw new Error("Resumed turn usage has no baseline");
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
