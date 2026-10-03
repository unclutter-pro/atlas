import { existsSync } from "node:fs";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { DISALLOWED_BUILTIN_TOOLS } from "./policy.ts";

export function resolveClaudeCodePath(appDir = "/atlas/app"): string | undefined {
  for (const path of [
    `${appDir}/triggers/node_modules/@anthropic-ai/claude-agent-sdk/cli.js`,
    "/usr/local/bin/claude", "/usr/bin/claude",
  ]) if (existsSync(path)) return path;
  return undefined;
}

export interface ClaudeOptionsInput {
  systemPrompt: string;
  model: string;
  cwd: string;
  mcpServers?: Options["mcpServers"];
  resume?: string;
  persistSession?: boolean;
  includePartialMessages?: boolean;
  hooks?: Options["hooks"];
}

/** Keep the existing Atlas prompt, tool policy and SDK defaults verbatim. */
export function atlasQueryOptions(input: ClaudeOptionsInput): Options {
  const executable = resolveClaudeCodePath();
  return {
    systemPrompt: input.systemPrompt,
    model: input.model,
    mcpServers: input.mcpServers,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settings: { autoMemoryEnabled: false },
    disallowedTools: [...DISALLOWED_BUILTIN_TOOLS],
    cwd: input.cwd,
    ...(input.resume ? { resume: input.resume } : {}),
    ...(input.persistSession === false ? { persistSession: false } : {}),
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    ...(input.includePartialMessages ? { includePartialMessages: true } : {}),
    ...(input.hooks ? { hooks: input.hooks } : {}),
  };
}
