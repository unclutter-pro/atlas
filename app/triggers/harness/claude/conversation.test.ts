import { expect, test } from "bun:test";
import type { ConversationEvent } from "../../../lib/harness.ts";
import { ClaudeCodeBackend } from "./backend.ts";
import { isInvalidRequest, openConversation, type QueryFactory } from "./conversation.ts";

// Baseline from the pre-adapter runner, intentionally independent of policy.ts.
const disallowedTools = ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup",
  "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree", "TodoWrite",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "AskUserQuestion", "TeamCreate",
  "TeamDelete", "SendMessage"];

const ref = (nativeId: string) => ({ backend: "claude-code", nativeId });

/** A fake SDK query yielding `messages`, recording its arguments. */
function fakeSdk(messages: unknown[] = []) {
  const calls: Parameters<QueryFactory>[0][] = [];
  let closes = 0;
  const factory = ((args) => {
    calls.push(args);
    async function* gen() { for (const m of messages) yield m; }
    return Object.assign(gen(), { close() { closes++; }, async interrupt() {} });
  }) as unknown as QueryFactory;
  return { factory, calls, get closes() { return closes; } };
}

async function collect(messages: unknown[]): Promise<ConversationEvent[]> {
  const sdk = fakeSdk(messages);
  const events: ConversationEvent[] = [];
  for await (const e of openConversation({ prompt: "hi", systemPrompt: "s", model: "m", cwd: "/w", turns: "single" }, sdk.factory)) {
    events.push(e);
  }
  return events;
}

test("existing direct and persistent SDK options preserve prompt, tools, settings and MCP", async () => {
  const sdk = fakeSdk();
  const backend = new ClaudeCodeBackend({ query: sdk.factory, prepareEnvironment: false });
  const systemPrompt = "<soul>Identity</soul>\nAgent(subagent_type=developer)\nSkill(name=browser)";
  const mcpServers = { local: { command: "bun", args: ["server.ts"] } };
  const base = { systemPrompt, model: "custom-model-alias", cwd: "/home/agent", mcpServers };
  backend.openConversation({ ...base, prompt: "direct", turns: "single", ephemeral: true });
  backend.openConversation({ ...base, prompt: "farewell", turns: "single", resume: ref("old-session") });
  const chat = backend.openConversation({ ...base, prompt: "hello", turns: "multi", idleTimeoutMs: 50,
    resume: ref("chat-session"), streamText: true, nextToolContext: () => "steering context" });
  const common = { ...base, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
    settings: { autoMemoryEnabled: false }, disallowedTools };
  for (const call of sdk.calls) {
    expect(call.options).toMatchObject(common);
    expect(call.options!.tools).toBeUndefined();
    expect(call.options!.agents).toBeUndefined();
    expect(call.options!.settingSources).toBeUndefined();
    expect(call.options!.strictMcpConfig).toBeUndefined();
    expect(call.options!.env).toBeUndefined();
    expect(call.options!.sessionId).toBeUndefined();
    expect(call.options!.disallowedTools).not.toContain("Agent");
    expect(call.options!.disallowedTools).not.toContain("Skill");
  }
  const [direct, farewell, multi] = sdk.calls;
  expect(direct!.prompt).toBe("direct");
  expect(direct!.options!.persistSession).toBe(false);
  expect(direct!.options!.includePartialMessages).toBeUndefined();
  expect(direct!.options!.hooks).toBeUndefined();
  expect(farewell!.prompt).toBe("farewell");
  expect(farewell!.options!.resume).toBe("old-session");
  expect(farewell!.options!.persistSession).toBeUndefined();
  expect(multi!.options!.resume).toBe("chat-session");
  expect(multi!.options!.includePartialMessages).toBe(true);
  // Multi-turn input: the first message is the prompt, as an SDK user message.
  const input = multi!.prompt as AsyncIterable<{ message: { content: string } }>;
  const first = await input[Symbol.asyncIterator]().next();
  expect(first.value.message.content).toBe("hello");
  const hook = multi!.options!.hooks!.PostToolBatch![0]!.hooks[0]!;
  expect(await hook({} as any, undefined, { signal: new AbortController().signal })).toEqual({
    hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: "steering context" },
  });
  chat.stop();
});

test("PostToolBatch ignores a subagent's batch, leaving queued context for the parent's own firing", async () => {
  const sdk = fakeSdk();
  let queued: string | undefined = "steering message";
  const conversation = openConversation({
    prompt: "hi", systemPrompt: "s", model: "m", cwd: "/w", turns: "multi", idleTimeoutMs: 50,
    nextToolContext: () => { const value = queued; queued = undefined; return value; },
  }, sdk.factory);
  const hook = sdk.calls[0]!.options!.hooks!.PostToolBatch![0]!.hooks[0]!;
  const opts = { signal: new AbortController().signal };
  // A subagent's tool batch resolving must not drain or deliver the queued context.
  expect(await hook({ agent_id: "sub-1", agent_type: "general-purpose" } as any, undefined, opts)).toEqual({});
  // The parent's own batch resolving still finds the message intact.
  expect(await hook({} as any, undefined, opts)).toEqual({
    hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: "steering message" },
  });
  conversation.stop();
});

test("SDK messages become session, message, text.delta and turn.finished events", async () => {
  const events = await collect([
    { type: "system", subtype: "init", session_id: "s1" },
    { type: "stream_event", session_id: "s1", event: { type: "message_start", message: { id: "msg_1" } } },
    { type: "stream_event", session_id: "s1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } },
    { type: "stream_event", session_id: "s1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "" } } },
    { type: "stream_event", session_id: "s1", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } } },
    { type: "stream_event", session_id: "s1", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "…" } } },
    { type: "stream_event", session_id: "s1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } },
    { type: "stream_event", session_id: "s1", event: { type: "message_stop" } },
    { type: "assistant", session_id: "s1", message: { id: "msg_1", content: [{ type: "text", text: "Hello" }] } },
    { type: "assistant", session_id: "s1", parent_tool_use_id: "t1", message: { id: "sub", content: [] } },
    { type: "result", subtype: "success", session_id: "s1", result: "Hello", num_turns: 1, duration_ms: 42 },
  ]);
  expect(events.map((e) => e.type)).toEqual(["session", "text.delta", "text.delta", "message", "message", "turn.finished"]);
  expect(events[0]).toEqual({ type: "session", session: ref("s1") });
  expect(events.filter((e) => e.type === "text.delta")).toEqual([
    { type: "text.delta", messageId: "msg_1", text: "Hel" },
    { type: "text.delta", messageId: "msg_1", text: "lo" },
  ]);
  expect(events[4]).toEqual({ type: "message", role: "assistant", nested: true });
  const finished = events.at(-1)!;
  expect(finished.type === "turn.finished" && finished.result).toMatchObject({
    outcome: "completed", text: "Hello", error: null, session: ref("s1"), turns: 1, durationMs: 42,
  });
});

test("background_tasks_changed system messages become background-tasks events, excluding ambient tasks", async () => {
  const events = await collect([
    { type: "system", subtype: "background_tasks_changed", session_id: "s1", tasks: [
      { task_id: "t1", task_type: "shell", description: "sleep 100" },
      { task_id: "t2", task_type: "mcp", description: "watcher", ambient: true },
    ] },
    { type: "system", subtype: "background_tasks_changed", session_id: "s1", tasks: [] },
    { type: "result", subtype: "success", session_id: "s1", result: "ok" },
  ]);
  expect(events.filter((e) => e.type === "background-tasks")).toEqual([
    { type: "background-tasks", count: 1 },
    { type: "background-tasks", count: 0 },
  ]);
  // Not treated as a session change, message, or anything else.
  expect(events.map((e) => e.type)).toEqual(["background-tasks", "background-tasks", "turn.finished"]);
});

test("task_started/task_progress/task_notification become background-task-* events, excluding ambient starts", async () => {
  const events = await collect([
    { type: "system", subtype: "task_started", session_id: "s1", task_id: "t1", task_type: "local_agent", description: "research the thing" },
    { type: "system", subtype: "task_started", session_id: "s1", task_id: "t2", task_type: "mcp", description: "watcher", ambient: true },
    { type: "system", subtype: "task_progress", session_id: "s1", task_id: "t1", description: "research the thing", usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } },
    { type: "system", subtype: "task_notification", session_id: "s1", task_id: "t1", status: "completed", output_file: "/tmp/out.md", summary: "done" },
    { type: "result", subtype: "success", session_id: "s1", result: "ok" },
  ]);
  expect(events.map((e) => e.type)).toEqual([
    "background-task-started", "background-task-progress", "background-task-done", "turn.finished",
  ]);
  expect(events[0]).toEqual({ type: "background-task-started", taskId: "t1", taskType: "local_agent", description: "research the thing" });
  expect(events[1]).toEqual({ type: "background-task-progress", taskId: "t1" });
  expect(events[2]).toEqual({ type: "background-task-done", taskId: "t1", outputFile: "/tmp/out.md" });
});

test("a text delta before any message_start is dropped", async () => {
  const events = await collect([
    { type: "stream_event", session_id: "s1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "orphan" } } },
  ]);
  expect(events.map((e) => e.type)).toEqual(["session"]);
});

test("provider rejections and failed turns are classified", async () => {
  expect(isInvalidRequest('API Error: 400 {"error":"Upstream error"}')).toBe(true);
  expect(isInvalidRequest("API Error: 400")).toBe(true);
  expect(isInvalidRequest("API Error: 401 Unauthorized")).toBe(false);
  expect(isInvalidRequest("API Error: 500 Internal Server Error")).toBe(false);
  expect(isInvalidRequest(null)).toBe(false);
  expect(isInvalidRequest("Email sent successfully")).toBe(false);

  const [rejected] = (await collect([{ type: "result", subtype: "success", session_id: "s1", result: "API Error: 400 too large" }]))
    .filter((e) => e.type === "turn.finished");
  expect(rejected!.type === "turn.finished" && rejected!.result).toMatchObject({
    outcome: "completed", error: { code: "invalid-request", message: "API Error: 400 too large" },
  });
  const [failed] = (await collect([{ type: "result", subtype: "error_during_execution", session_id: "s1", num_turns: 0, errors: ["boom"] }]))
    .filter((e) => e.type === "turn.finished");
  expect(failed!.type === "turn.finished" && failed!.result).toMatchObject({
    outcome: "failed", text: null, turns: 0, error: { code: "execution", message: "boom" },
  });
});

test("refused credentials are authentication failures", async () => {
  const finished = async (messages: unknown[]) =>
    (await collect(messages)).flatMap((e) => (e.type === "turn.finished" ? [e.result] : []))[0]!;
  const loginText = "Invalid API key · Please run /login";

  // Claude Code marks the assistant message and ends the turn with is_error.
  expect(await finished([
    { type: "assistant", session_id: "s1", error: "authentication_failed", message: { content: [{ type: "text", text: loginText }] } },
    { type: "result", subtype: "success", is_error: true, session_id: "s1", result: loginText },
  ])).toMatchObject({ outcome: "failed", error: { code: "authentication", message: loginText } });

  // Without the marker the error text decides.
  expect(await finished([
    { type: "result", subtype: "success", is_error: true, session_id: "s1", result: "OAuth token has expired. Please obtain a new token." },
  ])).toMatchObject({ outcome: "failed", error: { code: "authentication" } });
  expect(await finished([
    { type: "result", subtype: "success", is_error: true, session_id: "s1", result: 'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}' },
  ])).toMatchObject({ outcome: "failed", error: { code: "authentication" } });

  expect(await finished([
    { type: "result", subtype: "success", is_error: true, session_id: "s1", result: "Failed to authenticate: OAuth session expired and could not be refreshed" },
  ])).toMatchObject({ outcome: "failed", error: { code: "authentication" } });

  // A normal answer that talks about logging in is no failure; nor is a subagent's error.
  expect(await finished([
    { type: "result", subtype: "success", is_error: false, session_id: "s1", result: "Please run /login on the server." },
  ])).toMatchObject({ outcome: "completed", error: null });
  expect(await finished([
    { type: "assistant", session_id: "s1", parent_tool_use_id: "t1", error: "authentication_failed", message: { content: [] } },
    { type: "result", subtype: "success", session_id: "s1", result: "done" },
  ])).toMatchObject({ outcome: "completed", error: null });
});

test("a CLI that ends because it cannot authenticate raises an authentication error", async () => {
  const message = "Failed to authenticate: OAuth session expired and could not be refreshed";
  const factory = (() => {
    async function* gen() { throw new Error(message); }
    return Object.assign(gen(), { close() {}, async interrupt() {} });
  }) as unknown as QueryFactory;
  const conversation = openConversation({ prompt: "hi", systemPrompt: "s", model: "m", cwd: "/w", turns: "single" }, factory);
  const err = await (async () => { for await (const _ of conversation) {} })().catch((e) => e);
  expect(err.detail).toEqual({ code: "authentication", message });

  // Other crashes stay as they are.
  const crash = (() => {
    async function* gen() { throw new Error("spawn ENOENT"); }
    return Object.assign(gen(), { close() {}, async interrupt() {} });
  }) as unknown as QueryFactory;
  const other = await (async () => {
    for await (const _ of openConversation({ prompt: "hi", systemPrompt: "s", model: "m", cwd: "/w", turns: "single" }, crash)) {}
  })().catch((e) => e);
  expect(other.detail).toBeUndefined();
  expect(other.message).toBe("spawn ENOENT");
});

test("turn usage subtracts the session totals before the turn", async () => {
  const usage = (i: number, o: number) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  const model = (i: number, o: number, cost: number) => ({ haiku: { inputTokens: i, outputTokens: o, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost } });
  const events = await collect([
    { type: "result", subtype: "success", session_id: "s1", result: "a", usage: usage(100, 10), total_cost_usd: 0.1, modelUsage: model(100, 10, 0.1) },
    { type: "result", subtype: "success", session_id: "s1", result: "b", usage: usage(50, 5), total_cost_usd: 0.15, modelUsage: model(150, 15, 0.15) },
  ]);
  const turns = events.flatMap((e) => (e.type === "turn.finished" ? [e.result.usage] : []));
  expect(turns[0]).toMatchObject({ inputTokens: 100, outputTokens: 10, completeness: "complete" });
  expect(turns[1]).toMatchObject({ inputTokens: 50, outputTokens: 5, completeness: "complete" });
  expect(turns[1]!.cost!.amount).toBeCloseTo(0.05, 10);
});

test("single-turn conversations reject input; stop releases the SDK once", async () => {
  const sdk = fakeSdk([]);
  const conversation = openConversation({ prompt: "hi", systemPrompt: "s", model: "m", cwd: "/w", turns: "single" }, sdk.factory);
  expect(() => conversation.push("more")).toThrow("single-turn");
  conversation.stop();
  conversation.stop();
  expect(sdk.closes).toBe(1);
});
