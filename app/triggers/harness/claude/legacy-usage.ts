import { existsSync, readFileSync, readdirSync } from "node:fs";
const HOME = process.env.HOME ?? "/home/agent";

/** Pricing per 1M tokens for each model family. */
export const MODEL_PRICING: Record<
  string,
  { in: number; out: number; cacheRead: number; cacheCreate: number }
> = {
  opus:    { in: 15.0,  out: 75.0,  cacheRead: 1.50,  cacheCreate: 18.75 },
  sonnet:  { in: 3.0,   out: 15.0,  cacheRead: 0.30,  cacheCreate: 3.75 },
  haiku:   { in: 1.0,   out: 5.0,   cacheRead: 0.10,  cacheCreate: 1.25 },
};

/** Determine pricing tier from a model string (e.g. "claude-sonnet-4-5"). */
export function modelFamily(model: string): keyof typeof MODEL_PRICING {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("haiku")) return "haiku";
  return "sonnet"; // default
}

/**
 * Resolve the Claude project directory name for a working directory.
 * Claude Code derives this by replacing every '/' with '-', so the leading
 * slash becomes a leading '-' ("/home/agent" -> "-home-agent").
 *
 * @param cwd - Directory the session runs in. Trigger sessions are started
 *   with `cwd: HOME`, so callers resolving their transcripts pass that same
 *   value rather than relying on the runner's own process.cwd().
 */
export function resolveClaudeProjectDir(cwd?: string): string {
  const projectDir =
    process.env.CLAUDE_PROJECT_DIR ??
    (cwd ?? process.cwd()).replace(/\//g, "-");
  return projectDir;
}

export type AggregatedUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
};

/**
 * Aggregate cost+tokens for a trigger run by scanning the parent session JSONL
 * plus all subagent JSONL files, filtering by timestamp window and deduping
 * by message.id. Uses Anthropic API list pricing per model family.
 *
 * Window: [startedAt, endedAt + 60s buffer] — buffer accommodates async tool_results.
 *
 * Returns zero-valued result if files missing or parse fails (never throws).
 */
export function aggregateRunCost(
  parentSessionId: string,
  startedAt: string,
  endedAt: string,
  homeDir?: string,
): AggregatedUsage {
  const zero: AggregatedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };

  try {
    const base = homeDir ?? HOME;
    const projectDir = resolveClaudeProjectDir(base);
    const projectBase = `${base}/.claude/projects/${projectDir}`;

    // Build time window
    const windowStart = new Date(startedAt).getTime();
    const windowEnd = new Date(endedAt).getTime() + 60_000; // +60s buffer

    if (isNaN(windowStart) || isNaN(windowEnd)) return zero;

    // Collect files to scan: parent JSONL + all subagent JSONLs
    const filesToScan: string[] = [];

    const parentJsonl = `${projectBase}/${parentSessionId}.jsonl`;
    if (existsSync(parentJsonl)) {
      filesToScan.push(parentJsonl);
    }

    const subagentsDir = `${projectBase}/${parentSessionId}/subagents`;
    if (existsSync(subagentsDir)) {
      try {
        const entries = readdirSync(subagentsDir);
        for (const entry of entries) {
          if (entry.startsWith("agent-") && entry.endsWith(".jsonl")) {
            filesToScan.push(`${subagentsDir}/${entry}`);
          }
        }
      } catch {
        // Subagents dir unreadable — proceed with parent only
      }
    }

    if (filesToScan.length === 0) return zero;

    // Single dedup set shared across all files
    const seenMessageIds = new Set<string>();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let costUsd = 0;

    for (const filePath of filesToScan) {
      let content: string;
      try {
        content = readFileSync(filePath, "utf8");
      } catch {
        continue;
      }

      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj: any;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          continue;
        }

        // Filter by time window
        if (!obj.timestamp) continue;
        const ts = new Date(obj.timestamp as string).getTime();
        if (isNaN(ts) || ts < windowStart || ts > windowEnd) continue;

        // Must have message.usage and message.id
        const msg = obj.message;
        if (!msg || typeof msg !== "object") continue;
        if (!msg.usage) continue;
        if (!msg.id) continue;

        // Deduplicate by message.id across all files
        const msgId = msg.id as string;
        if (seenMessageIds.has(msgId)) continue;
        seenMessageIds.add(msgId);

        const usage = msg.usage as Record<string, number>;
        const family = modelFamily((msg.model as string | undefined) ?? "");
        const pricing = MODEL_PRICING[family];

        const inTok = (usage.input_tokens as number | undefined) ?? 0;
        const outTok = (usage.output_tokens as number | undefined) ?? 0;
        const cacheReadTok = (usage.cache_read_input_tokens as number | undefined) ?? 0;
        const cacheCreateTok = (usage.cache_creation_input_tokens as number | undefined) ?? 0;

        inputTokens += inTok;
        outputTokens += outTok;
        cacheReadTokens += cacheReadTok;
        cacheCreationTokens += cacheCreateTok;
        costUsd +=
          (inTok * pricing.in +
            outTok * pricing.out +
            cacheReadTok * pricing.cacheRead +
            cacheCreateTok * pricing.cacheCreate) /
          1_000_000;
      }
    }

    return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd };
  } catch {
    // Never throw — return zeros on any unexpected failure
    return zero;
  }
}
