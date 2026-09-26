import { expect, test } from "bun:test";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { isSubagentHook } from "./normalize.ts";

test("isSubagentHook keys off agent_id, not agent_type", () => {
  expect(isSubagentHook({ agent_id: "a1", agent_type: "general-purpose" } as HookInput)).toBe(true);
  expect(isSubagentHook({} as HookInput)).toBe(false);
  // A main-thread session started with --agent sets agent_type but no agent_id.
  expect(isSubagentHook({ agent_type: "general-purpose" } as HookInput)).toBe(false);
});
