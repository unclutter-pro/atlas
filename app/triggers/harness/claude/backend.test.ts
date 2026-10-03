import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, SessionSpec } from "../../../lib/harness.ts";
import { ClaudeCodeBackend } from "./backend.ts";
import { MessageAccumulator, normalizeUsage } from "./normalize.ts";
import type { QueryFactory } from "./conversation.ts";
import { createHarnessBackend } from "../registry.ts";

const spec: SessionSpec = {
  cwd: "/workspace", systemPrompt: "You are Atlas.",
  model: { tier: "fast", model: { provider: "anthropic", model: "claude-haiku-4-5" } },
  toolEnvironment: { ATLAS_TRIGGER: "test" }, nativeTools: ["files.read"],
};
const input = (id = "input-1") => ({ id, content: [{ type: "text" as const, text: "Hello" }] });
const bindings = { tools: [] };
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 };
const result = (sid: string) => ({ type: "result", subtype: "success", session_id: sid,
  uuid: "result-1", result: "Hello", usage, total_cost_usd: 0.01, modelUsage: {}, num_turns: 1 });
const assistant = (sid: string, id = "msg-1") => ({ type: "assistant", session_id: sid,
  uuid: "uuid-1", message: { id, content: [{ type: "text", text: "Hello" }] } });

function mockSdk(script: (args: Parameters<QueryFactory>[0]) => AsyncGenerator<any>) {
  const calls: Parameters<QueryFactory>[0][] = [];
  let closes = 0;
  let interrupts = 0;
  const factory = ((args) => {
    calls.push(args);
    return Object.assign(script(args), {
      close() { closes++; }, async interrupt() { interrupts++; },
    });
  }) as unknown as QueryFactory;
  return { factory, calls, get closes() { return closes; }, get interrupts() { return interrupts; } };
}

const dirs: string[] = [];
function home() { const dir = mkdtempSync(join(tmpdir(), "atlas-harness-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });

describe("backend selection", () => {
  test("the configured backend drives the registry", () => {
    const saved = process.env.ATLAS_HARNESS_BACKEND;
    try {
      process.env.ATLAS_HARNESS_BACKEND = "opencode";
      expect(() => createHarnessBackend()).toThrow("Unknown harness backend: opencode");
      process.env.ATLAS_HARNESS_BACKEND = "claude-code";
      expect(createHarnessBackend().sessions.backend).toBe("claude-code");
    } finally {
      if (saved === undefined) delete process.env.ATLAS_HARNESS_BACKEND;
      else process.env.ATLAS_HARNESS_BACKEND = saved;
    }
  });
});

describe("Claude HarnessBackend contract", () => {
  test("registry rejects unknown names, returns exactly three configurable distinct profiles", async () => {
    expect(createHarnessBackend().id).toBe("claude-code");
    expect(() => createHarnessBackend("opencode")).toThrow("Unknown harness");
    expect(() => createHarnessBackend("toString")).toThrow("Unknown harness");
    const backend = new ClaudeCodeBackend({ models: { fast: "custom-haiku" } });
    const models = await backend.getModels();
    expect(Object.keys(models)).toEqual(["strong", "balanced", "fast"]);
    expect(models.fast.model.model).toBe("custom-haiku");
    expect(new Set(Object.values(models).map((m) => m.model.model)).size).toBe(3);
    await expect(new ClaudeCodeBackend({ models: { strong: "same", fast: "same" } }).getModels()).rejects.toThrow("distinct");
  });

  test("create is lazy; runs normalize streaming/usage and preserve session/model identity", async () => {
    const sdk = mockSdk(async function* ({ options }) {
      const sid = options!.sessionId ?? options!.resume!;
      yield { type: "system", subtype: "init", session_id: sid };
      yield { type: "stream_event", session_id: sid, event: { type: "message_start", message: { id: "msg-1" } } };
      yield { type: "stream_event", session_id: sid, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } } };
      yield assistant(sid);
      yield result(sid);
    });
    const backend = new ClaudeCodeBackend({ query: sdk.factory });
    const session = await backend.create(spec, bindings);
    expect(sdk.calls).toHaveLength(0);
    const run = session.run({ runId: "r1", input: [input()] });
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);
    const finished = await run.finished;
    expect(finished.outcome).toBe("completed");
    expect(finished.session).toEqual(session.ref);
    expect(finished.model).toEqual(spec.model);
    expect(finished.usage.total).toMatchObject({ inputTokens: 10, cacheReadTokens: 2, cost: { amount: 0.01 }, completeness: "partial" });
    expect(finished.appliedInputIds).toEqual(["input-1"]);
    expect(events.find((e) => e.type === "text.delta")).toMatchObject({ messageId: finished.finalMessage!.id, text: "Hello" });
    expect(events.at(-1)).toMatchObject({ type: "run.finished", result: finished });
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i));
    expect(sdk.calls[0].options).toMatchObject({ systemPrompt: spec.systemPrompt, tools: ["Read", "Glob", "Grep"], env: { ATLAS_TRIGGER: "test" }, strictMcpConfig: true });
    expect(sdk.calls[0].options!.env!.CLAUDECODE).toBeUndefined();
    expect(sdk.closes).toBe(1);
    await session.run({ runId: "r2", input: [input("second")] }).finished;
    expect(sdk.calls[1].options!.resume).toBe(session.ref.nativeId);
    expect(sdk.calls[1].options!.sessionId).toBeUndefined();
    await session.close();
    expect(() => session.run({ runId: "r3", input: [input()] })).toThrow("closed");
  });

  test("steering is deduplicated and only acknowledged after the next response", async () => {
    let next!: () => void;
    const boundary = new Promise<void>((r) => { next = r; });
    let hookContext: unknown;
    const sdk = mockSdk(async function* ({ options }) {
      const sid = options!.sessionId!;
      yield assistant(sid);
      await boundary;
      hookContext = await options!.hooks!.PostToolBatch![0].hooks[0]({} as any, undefined, { signal: new AbortController().signal });
      yield assistant(sid, "msg-2");
      yield result(sid);
    });
    const session = await new ClaudeCodeBackend({ query: sdk.factory }).create(spec, bindings);
    const run = session.run({ runId: "r", input: [input()] });
    await Bun.sleep(1);
    expect(await run.steer(input("steer"))).toEqual({ status: "accepted" });
    expect(await run.steer(input("steer"))).toEqual({ status: "accepted" });
    next();
    const finished = await run.finished;
    expect(hookContext).toEqual({ hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: "Hello" } });
    expect(finished.appliedInputIds).toEqual(["input-1", "steer"]);
    expect(await run.steer(input("late"))).toEqual({ status: "rejected", reason: "run-ended" });
  });

  test("PostToolBatch ignores a subagent's batch: steering is neither delivered nor marked applied by it", async () => {
    let next!: () => void;
    const boundary = new Promise<void>((r) => { next = r; });
    let subagentContext: unknown;
    let parentContext: unknown;
    const sdk = mockSdk(async function* ({ options }) {
      const sid = options!.sessionId!;
      yield assistant(sid);
      await boundary;
      const hook = options!.hooks!.PostToolBatch![0].hooks[0];
      const opts = { signal: new AbortController().signal };
      subagentContext = await hook({ agent_id: "sub-1", agent_type: "general-purpose" } as any, undefined, opts);
      parentContext = await hook({} as any, undefined, opts);
      yield assistant(sid, "msg-2");
      yield result(sid);
    });
    const session = await new ClaudeCodeBackend({ query: sdk.factory }).create(spec, bindings);
    const run = session.run({ runId: "r", input: [input()] });
    await Bun.sleep(1);
    expect(await run.steer(input("steer"))).toEqual({ status: "accepted" });
    next();
    const finished = await run.finished;
    // Bug: if the subagent's firing drained `steering`, this would already carry the content.
    expect(subagentContext).toEqual({});
    // The message wasn't dropped: the parent's own firing still delivers it.
    expect(parentContext).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: "Hello" },
    });
    expect(finished.appliedInputIds).toEqual(["input-1", "steer"]);
  });

  test("unused steering remains unapplied at the last boundary", async () => {
    let next!: () => void;
    const boundary = new Promise<void>((r) => { next = r; });
    const sdk = mockSdk(async function* ({ options }) {
      yield assistant(options!.sessionId!);
      await boundary;
      yield result(options!.sessionId!);
    });
    const session = await new ClaudeCodeBackend({ query: sdk.factory }).create(spec, bindings);
    const run = session.run({ runId: "r", input: [input()] });
    await run.steer(input("late")); next();
    expect((await run.finished).appliedInputIds).toEqual(["input-1"]);
  });

  test("cancellation before startup, concurrency and close do not start extra processes", async () => {
    const sdk = mockSdk(async function* () { throw new Error("must not run"); });
    const session = await new ClaudeCodeBackend({ query: sdk.factory }).create(spec, bindings);
    const run = session.run({ runId: "r", input: [input()] });
    expect(() => session.run({ runId: "r2", input: [input()] })).toThrow("active run");
    const close = session.close();
    await run.abort();
    await expect(close).rejects.toThrow("Abort and await");
    expect((await run.finished).outcome).toBe("aborted");
    expect(sdk.calls).toHaveLength(0);
    await session.close();
  });

  test("failure resolves finished, reports unknown usage and releases the SDK", async () => {
    const sdk = mockSdk(async function* () { throw new Error("connection lost"); });
    const session = await new ClaudeCodeBackend({ query: sdk.factory }).create(spec, bindings);
    const finished = await session.run({ runId: "r", input: [input()] }).finished;
    expect(finished).toMatchObject({ outcome: "failed", executionState: "unknown", error: { message: "connection lost" }, usage: { total: { inputTokens: null, cost: null, completeness: "unavailable" } } });
    expect(sdk.closes).toBe(1);
    await session.close();
  });

  test("active abort remains aborted even if the SDK returns a successful result with usage", async () => {
    let stop!: () => void;
    const stopped = new Promise<void>((r) => { stop = r; });
    let interrupts = 0;
    const factory = (({ options }) => {
      async function* messages() {
        yield assistant(options.sessionId);
        await stopped;
        yield result(options.sessionId);
      }
      return Object.assign(messages(), { close() {}, async interrupt() { interrupts++; stop(); } });
    }) as unknown as QueryFactory;
    const session = await new ClaudeCodeBackend({ query: factory }).create(spec, bindings);
    const run = session.run({ runId: "abort", input: [input()] });
    await Bun.sleep(1);
    await run.abort();
    const outcome = await run.finished;
    expect(outcome.outcome).toBe("aborted");
    expect(outcome.usage.total.inputTokens).toBe(10);
    expect(interrupts).toBe(1);
    await run.abort();
    expect(interrupts).toBe(1);
    await session.close();
  });

  test("event overflow fails explicitly and still delivers a terminal result", async () => {
    const sdk = mockSdk(async function* ({ options }) {
      for (let i = 0; i < 5000; i++) yield assistant(options!.sessionId!, `message-${i}`);
    });
    const session = await new ClaudeCodeBackend({ query: sdk.factory }).create(spec, bindings);
    const run = session.run({ runId: "overflow", input: [input()] });
    const outcome = await run.finished;
    expect(outcome).toMatchObject({ outcome: "failed", error: { message: "Harness event consumer fell behind" } });
    let last: AgentEvent | undefined;
    for await (const event of run.events) last = event;
    expect(last).toMatchObject({ type: "run.finished", result: outcome });
    expect(sdk.closes).toBe(1);
  });

  test("unsupported features fail before any execution; environment remains scoped", async () => {
    const backend = new ClaudeCodeBackend();
    await expect(backend.create(spec, { tools: [], compactionContext: async () => "tasks" })).rejects.toThrow("not implemented");
    await expect(backend.create({ ...spec, nativeTools: ["invalid" as any] }, bindings)).rejects.toThrow("capability");
    const before = process.env.ATLAS_TRIGGER;
    await backend.create(spec, bindings);
    expect(process.env.ATLAS_TRIGGER).toBe(before);
  });

  test("resume/history use existing IDs and reject missing or wrong-backend sessions", async () => {
    const root = home();
    const backend = new ClaudeCodeBackend({ home: root });
    const ref = { backend: "claude-code", nativeId: "saved-session" };
    await expect(backend.resume(ref, spec, bindings)).rejects.toThrow("no transcript");
    const dir = join(root, ".claude/projects/workspace"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ref.nativeId}.jsonl`), JSON.stringify(assistant(ref.nativeId)) + '\n{"partial":');
    const session = await backend.resume(ref, spec, bindings);
    expect(session.ref).toEqual(ref);
    expect((await backend.history(ref)).messages[0].id).toBe("msg-1");
    expect((await backend.inspect(ref)).state).toBe("unknown");
    await expect(backend.history({ ...ref, backend: "opencode" })).rejects.toThrow("Invalid");
    await expect(backend.history({ ...ref, nativeId: "../../secret" })).rejects.toThrow("Invalid");
  });

  test("usage never adds a per-model breakdown to totals or invents missing numbers", () => {
    const raw = { ...result("s"), modelUsage: { "claude-haiku": {
      inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 3, costUSD: 0.01,
    } } };
    expect(normalizeUsage(raw).byModel).toHaveLength(1);
    expect(normalizeUsage(raw).total.cost!.amount).toBe(0.01);
    expect(normalizeUsage({ ...raw, total_cost_usd: 0.02 }).byModel).toBeNull();
    expect(normalizeUsage({ usage: { input_tokens: 9 } }).total).toMatchObject({ inputTokens: 9, outputTokens: null, cost: null, completeness: "partial" });
  });

  test("live and history message assembly preserves separate blocks sharing an API ID", () => {
    const messages = new MessageAccumulator();
    const a = { type: "assistant", uuid: "block-1", message: { id: "msg", content: [{ type: "text", text: "Working" }] } };
    const b = { type: "assistant", uuid: "block-2", message: { id: "msg", content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { path: "README" } }] } };
    messages.add(a); messages.add(b); messages.add(b);
    expect(messages.messages.get("msg")!.content).toHaveLength(2);
    expect(messages.add({ ...a, isSidechain: true })).toBeNull();
  });
});
