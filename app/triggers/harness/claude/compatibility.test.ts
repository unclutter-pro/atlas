import { expect, test } from "bun:test";
import { ClaudeCodeBackend } from "./backend.ts";
import { createMessageChannel } from "./message-channel.ts";
import type { QueryFactory } from "./compatibility.ts";

// Baseline from the pre-adapter runner, intentionally independent of policy.ts.
const disallowedTools = ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup",
  "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree", "TodoWrite",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "AskUserQuestion", "TeamCreate",
  "TeamDelete", "SendMessage"];

test("existing direct and persistent SDK options preserve prompt, tools, settings and MCP", async () => {
  const calls: Parameters<QueryFactory>[0][] = [];
  const fake = ((args) => { calls.push(args); return {} as any; }) as QueryFactory;
  const backend = new ClaudeCodeBackend({ query: fake });
  const systemPrompt = "<soul>Identity</soul>\nAgent(subagent_type=developer)\nSkill(name=browser)";
  const mcpServers = { local: { command: "bun", args: ["server.ts"] } };
  const base = { systemPrompt, model: "custom-model-alias", cwd: "/home/agent", mcpServers };
  const channel = createMessageChannel("pending", 50);
  backend.openConversation({ ...base, prompt: "direct", persistSession: false });
  backend.openConversation({ ...base, prompt: "farewell", resume: "old-session" });
  backend.openConversation({ ...base, prompt: channel.generator, resume: "chat-session", includePartialMessages: true, nextToolContext: () => "steering context" });
  const common = { ...base, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
    settings: { autoMemoryEnabled: false }, disallowedTools };
  for (const call of calls) {
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
  expect(calls[0].prompt).toBe("direct");
  expect(calls[0].options!.persistSession).toBe(false);
  expect(calls[0].options!.includePartialMessages).toBeUndefined();
  expect(calls[0].options!.hooks).toBeUndefined();
  expect(calls[1].options!.resume).toBe("old-session");
  expect(calls[1].options!.persistSession).toBeUndefined();
  expect(calls[2].prompt).toBe(channel.generator);
  expect(calls[2].options!.includePartialMessages).toBe(true);
  const hook = calls[2].options!.hooks!.PostToolBatch![0].hooks[0];
  expect(await hook({} as any, undefined, { signal: new AbortController().signal })).toEqual({
    hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: "steering context" },
  });
  channel.close();
});
