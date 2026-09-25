import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Process-level preparation before a Claude Code session starts.
 *
 * - CLAUDECODE marks a process running inside Claude Code; the SDK passes
 *   process.env to the CLI, which would then treat the session as nested.
 * - Remote MCP connectors (claude.ai) hang on startup. The CLI reads the
 *   switch from its feature cache in ~/.claude.json.
 */
export function prepareClaudeEnvironment(home: string): void {
  delete process.env.CLAUDECODE;
  const file = join(home, ".claude.json");
  if (!existsSync(file)) return;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const features = (data.cachedGrowthBookFeatures ??= {}) as Record<string, unknown>;
    if (features.tengu_claudeai_mcp_connectors === false) return;
    features.tengu_claudeai_mcp_connectors = false;
    writeFileSync(file, JSON.stringify(data, null, 2));
  } catch {
    // Non-fatal: the session starts anyway
  }
}
