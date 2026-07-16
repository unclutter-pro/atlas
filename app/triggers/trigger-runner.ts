#!/usr/bin/env bun
/**
 * Trigger Runner — replaces the old claude-atlas shell wrapper
 *
 * Usage: bun run trigger-runner.ts <trigger-name> [payload] [session-key]
 *
 * Session key determines WHICH session to resume for persistent triggers:
 *   - Email: thread ID       → trigger-runner.ts email-handler '{"body":"..."}' 'thread-4821'
 *   - Signal: sender number  → trigger-runner.ts signal-chat '{"msg":"Hi"}' '+49170123456'
 *   - Webhook: event group   → trigger-runner.ts deploy-hook '{"ref":"main"}' 'repo-myapp'
 *   - No key + persistent    → uses "_default" (one global session per trigger)
 *   - Ephemeral triggers     → key is ignored, always a new session
 *
 * For persistent sessions: if the session is already running (IPC socket alive),
 * the message is injected directly into the running session via the Claude Code
 * IPC socket. No new process is spawned.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  readdirSync,
  statSync,
} from "fs";
import os from "node:os";
import { createConnection, createServer } from "net";
import type { Server } from "net";
import { join, dirname } from "path";
import yaml from "js-yaml";
import { resolveConfig } from "../lib/config.ts";
import { openDb as openSharedDb } from "../lib/db.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriggerConfig = {
  id: number;
  name: string;
  type: string;
  channel: string;
  prompt: string;
  session_mode: "ephemeral" | "persistent";
  /**
   * Optional per-trigger model override. When non-empty, takes precedence
   * over the ATLAS_CRON-based default ("cron" | "trigger") in resolveModel.
   * Maps to a `models.<key>` entry in config.yml. NULL ⇒ use the default.
   */
  model_key: string | null;
  enabled: number;
};

export type MetricsData = {
  sessionType: string;
  sessionId: string;
  triggerName: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  numTurns: number;
  isError: boolean;
};

export type UsageReportingConfig = {
  enabled: boolean;
  webhook_url: string;
  webhook_secret: string;
  include_tokens: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOME = process.env.HOME ?? "/home/agent";
const APP_DIR = "/atlas/app";
const PROMPT_DIR = `${APP_DIR}/prompts`;
const DB_PATH = `${HOME}/.index/atlas.db`;
const CLAUDE_JSON = `${HOME}/.claude.json`;
const WORKSPACE = HOME;

// Resolve path to Claude Code executable for the SDK.
// In compiled Bun binaries, import.meta.url points to a virtual FS (/$bunfs/...),
// so the SDK cannot auto-resolve cli.js. We resolve it explicitly here.
function resolveClaudeCodePath(): string | undefined {
  // 1. SDK's bundled cli.js (older SDK versions ship this)
  const sdkCli = `${APP_DIR}/triggers/node_modules/@anthropic-ai/claude-agent-sdk/cli.js`;
  if (existsSync(sdkCli)) return sdkCli;
  // 2. Native binary installed globally (check common paths)
  for (const bin of ["/usr/local/bin/claude", "/usr/bin/claude"]) {
    if (existsSync(bin)) return bin;
  }
  // 3. Let the SDK resolve it (works when not compiled)
  return undefined;
}

const CLAUDE_CODE_PATH = resolveClaudeCodePath();

// ---------------------------------------------------------------------------
// Tool policy
// ---------------------------------------------------------------------------

/**
 * Built-in Claude Code tools we never want a trigger session to see or use.
 *
 * settings.json `permissions.deny` only blocks execution — the model is still
 * told the tool exists, which leaks into the system prompt. `disallowedTools`
 * on the SDK query options removes the tool from the disclosure entirely.
 *
 * Keep in sync with the deny list in app/hooks/generate-settings.ts.
 */
const DISALLOWED_BUILTIN_TOOLS = [
  // Cron management — exposed via dedicated trigger commands, not LLM tools
  "CronCreate",
  "CronDelete",
  "CronList",
  // Scheduling - we have reminder cli for that
  "ScheduleWakeup",
  // Plan mode is a Claude Code interactive UX concept; trigger sessions are headless
  "EnterPlanMode",
  "ExitPlanMode",
  // Worktrees are managed by the harness, not by the agent
  "EnterWorktree",
  "ExitWorktree",
  // Atlas tracks tasks via its own CLI, never via Claude Code's built-ins
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  // No interactive user-question loop in trigger sessions
  "AskUserQuestion",
  // Teams feature disabled — agent runs without teammate coordination
  "TeamCreate",
  "TeamDelete",
  "SendMessage",
];

/**
 * Tools disallowed for the validator session.
 * The validator is read-only — it may inspect files but must not write anything,
 * spawn agents, or access task/goal/reminder state.
 */
export const DISALLOWED_VALIDATOR_TOOLS = [
  ...DISALLOWED_BUILTIN_TOOLS,
  // Write tools — validator is strictly read-only
  "Edit",
  "Write",
  "NotebookEdit",
  // MCP tools — no external access
  "mcp__*",
  // Agent spawning
  "Agent",
];

// ---------------------------------------------------------------------------
// Message Channel (AsyncIterable + IPC socket for message injection)
// ---------------------------------------------------------------------------

/** Default idle timeout: 5 minutes of no new messages → session ends */
const IDLE_TIMEOUT_MS = parseInt(
  process.env.TRIGGER_IDLE_TIMEOUT ?? "300000",
  10,
);

/**
 * Options for pushing a user message into the channel.
 *
 * - `shouldQuery: false` — SDK v0.2.110+: append the message to the transcript
 *   without triggering a new assistant turn. The message merges into the
 *   current turn's next LLM call. Use for mid-turn steering (the agent
 *   reacts to new info without restarting work).
 * - `priority` — present in SDK type but undocumented. We set `'now'` as a
 *   hint for mid-turn steering.
 */
export type PushOptions = {
  shouldQuery?: boolean;
  priority?: "now" | "next" | "later";
};

/** Socket message protocol: newline-delimited JSON */
export type SocketMessage = {
  message: string;
  channel: string;
  sessionKey: string;
  control?: "interrupt"; // NEW: send instead of injecting message
};

export type SocketAck = {
  ok: boolean;
  error?: string;
};

/**
 * Create an async message channel backed by a simple queue + promise resolver pattern.
 * Returns an AsyncGenerator that yields SDKUserMessages and a push function for injection.
 * The generator will return (end) after idleTimeoutMs of inactivity.
 */
export function createMessageChannel(
  sessionId: string,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
) {
  type Waiter = { resolve: (msg: SDKUserMessage) => void };
  const waiters: Waiter[] = [];
  const pending: SDKUserMessage[] = [];
  let closed = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleReject: (() => void) | null = null;

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      closed = true;
      // Wake any waiting consumer so it can exit
      if (idleReject) idleReject();
    }, idleTimeoutMs);
  }

  function buildUserMessage(
    text: string,
    opts?: PushOptions,
  ): SDKUserMessage {
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
    // shouldQuery: false → append context without triggering a new assistant
    // turn (SDK v0.2.110+). Used for mid-turn steering: the message merges
    // into the current turn's next LLM call, so the agent reacts to the new
    // info without restarting work.
    if (opts?.shouldQuery !== undefined) {
      (msg as unknown as { shouldQuery: boolean }).shouldQuery = opts.shouldQuery;
    }
    // priority: 'now' | 'next' | 'later' — present in SDK type but undocumented.
    // Setting 'now' for mid-turn steering as a hint; SDK may or may not honor.
    if (opts?.priority !== undefined) {
      (msg as unknown as { priority: PushOptions["priority"] }).priority = opts.priority;
    }
    return msg;
  }

  async function* generator(): AsyncGenerator<SDKUserMessage> {
    resetIdleTimer();
    while (!closed) {
      if (pending.length > 0) {
        resetIdleTimer();
        yield pending.shift()!;
      } else {
        try {
          const msg = await new Promise<SDKUserMessage>((resolve, reject) => {
            idleReject = reject;
            waiters.push({ resolve });
          });
          resetIdleTimer();
          yield msg;
        } catch {
          // Idle timeout triggered — exit generator
          break;
        }
      }
    }
    if (idleTimer) clearTimeout(idleTimer);
  }

  function push(text: string, opts?: PushOptions) {
    const msg = buildUserMessage(text, opts);
    if (waiters.length > 0) {
      const waiter = waiters.shift()!;
      idleReject = null;
      waiter.resolve(msg);
    } else {
      pending.push(msg);
    }
  }

  function close() {
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (idleReject) idleReject();
  }

  return { generator: generator(), push, close, buildUserMessage };
}

/**
 * Compute the socket path for a given trigger name + session key.
 */
export function getSocketPath(triggerName: string, sessionKey: string): string {
  const safeKey = sessionKey.replace(/[^a-zA-Z0-9_]/g, "_");
  const candidate = `/tmp/.trigger-${triggerName}-${safeKey}.sock`;
  // Unix domain sockets have a 108-char path limit; hash long keys to stay under
  if (candidate.length > 104) {
    const hash = createHash("sha256")
      .update(`${triggerName}-${sessionKey}`)
      .digest("hex")
      .slice(0, 16);
    return `/tmp/.trigger-${triggerName}-${hash}.sock`;
  }
  return candidate;
}

/**
 * Start a Unix domain socket server that accepts incoming messages and pushes
 * them into the message channel. Protocol: newline-delimited JSON.
 *
 * Client sends: {"message":"...", "channel":"signal", "sessionKey":"..."}\n
 * Client sends (control): {"message":"", "channel":"signal", "sessionKey":"...", "control":"interrupt"}\n
 * Server responds: {"ok":true}\n
 */
export function startSocketServer(
  socketPath: string,
  pushFn: (text: string, opts?: PushOptions) => void,
  controlFn: (control: "interrupt") => Promise<void> | void,
  logger?: { log: (msg: string) => void },
): Server {
  // Clean up stale socket file
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {}
  }

  const server = createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;

      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

      (async () => {
        try {
          const msg = JSON.parse(line) as SocketMessage;
          if (msg.control === "interrupt") {
            await controlFn("interrupt");
            logger?.log(
              `Socket: interrupt control from ${msg.channel}/${msg.sessionKey}`,
            );
          } else {
            pushFn(msg.message);
            logger?.log(
              `Socket: injected message from ${msg.channel}/${msg.sessionKey}`,
            );
          }
          const ack: SocketAck = { ok: true };
          conn.write(JSON.stringify(ack) + "\n");
        } catch (err) {
          const ack: SocketAck = { ok: false, error: String(err) };
          conn.write(JSON.stringify(ack) + "\n");
        }
        conn.end();
      })();
    });
    conn.on("error", () => {}); // Ignore client errors
  });

  server.listen(socketPath);
  return server;
}

/**
 * Try to inject a message into a running session via the custom Unix domain socket.
 * If control is set, sends a control message instead of injecting a message.
 * Returns true if the operation succeeded, false otherwise.
 */
export async function trySocketInject(
  socketPath: string,
  message: string,
  channel: string,
  sessionKey: string,
  control?: "interrupt",
): Promise<boolean> {
  if (!existsSync(socketPath)) return false;

  return new Promise<boolean>((resolve) => {
    const client = createConnection(socketPath, () => {
      const payload: SocketMessage = control
        ? { message: "", channel, sessionKey, control }
        : { message, channel, sessionKey };
      client.write(JSON.stringify(payload) + "\n");
    });

    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;
      try {
        const ack = JSON.parse(buffer.slice(0, newlineIdx)) as SocketAck;
        resolve(ack.ok === true);
      } catch {
        resolve(false);
      }
    });

    client.on("error", () => resolve(false));
    client.setTimeout(5000, () => {
      client.destroy();
      resolve(false);
    });
  });
}

/**
 * Clean up a socket server and its socket file.
 */
export function cleanupSocket(server: Server | null, socketPath: string): void {
  if (server) {
    try {
      server.close();
    } catch {}
  }
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function makeLogger(triggerName: string) {
  const logPath = `/atlas/logs/trigger-${triggerName}.log`;
  return {
    log(msg: string) {
      const line = `[${new Date().toISOString()}] ${msg}`;
      console.log(line);
      try {
        appendFileSync(logPath, line + "\n");
      } catch {
        // Log dir may not exist in test environment, ignore
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Exported pure functions (for testing)
// ---------------------------------------------------------------------------

/**
 * Build the system prompt by concatenating:
 * - ~/SOUL.md (wrapped in <soul> tags)
 * - ~/IDENTITY.md (wrapped in <identity> tags)
 * - /atlas/app/prompts/trigger-system-prompt.md
 * - /atlas/app/prompts/trigger-channel-{channel}.md
 * - All .md files in ATLAS_PROMPT_EXTENSIONS_DIR (if set)
 */
export function buildSystemPrompt(
  channel: string,
  options?: {
    appDir?: string;
    workspace?: string;
  },
): string {
  const appDir = options?.appDir ?? APP_DIR;
  const workspace = options?.workspace ?? WORKSPACE;
  const promptDir = `${appDir}/prompts`;

  let systemPrompt = "";

  // SOUL.md and IDENTITY.md (optional — user may not have them)
  for (const { tag, file } of [
    { tag: "soul", file: `${workspace}/SOUL.md` },
    { tag: "identity", file: `${workspace}/IDENTITY.md` },
  ]) {
    if (existsSync(file)) {
      systemPrompt += `\n<${tag} file="${file}">\n${readFileSync(file, "utf8")}\n</${tag}>\n`;
    }
  }

  // Core trigger system prompt
  const triggerSystemPromptFile = `${promptDir}/trigger-system-prompt.md`;
  if (existsSync(triggerSystemPromptFile)) {
    systemPrompt += `\n---\n\n${readFileSync(triggerSystemPromptFile, "utf8")}`;
  }

  // Channel-specific prompt
  const channelPromptFile = `${promptDir}/trigger-channel-${channel}.md`;
  if (existsSync(channelPromptFile)) {
    systemPrompt += `\n---\n\n${readFileSync(channelPromptFile, "utf8")}`;
  }

  // Prompt extensions — deployments can drop additional .md files into a
  // directory referenced by ATLAS_PROMPT_EXTENSIONS_DIR to inject extra
  // system prompt sections.
  const extensionsDir = process.env.ATLAS_PROMPT_EXTENSIONS_DIR;
  if (extensionsDir) {
    try {
      const files = readdirSync(extensionsDir)
        .filter((f) => f.endsWith(".md"))
        .sort();
      for (const file of files) {
        const content = readFileSync(join(extensionsDir, file), "utf-8");
        if (content.trim()) {
          systemPrompt += "\n\n" + content.trim();
        }
      }
    } catch {
      // Directory doesn't exist or isn't readable — silently skip
    }
  }

  // Inject dynamic environment info
  const arch = os.arch();
  const osRelease = (() => {
    try {
      const content = readFileSync("/etc/os-release", "utf8");
      const pretty = content.match(/^PRETTY_NAME="?(.+?)"?$/m);
      return pretty?.[1] ?? `${os.type()} ${os.release()}`;
    } catch {
      return `${os.type()} ${os.release()}`;
    }
  })();

  systemPrompt = safePlaceholderReplace(systemPrompt, {
    "{{OS_INFO}}": osRelease,
    "{{ARCH}}": arch,
  });

  return systemPrompt;
}

/**
 * Resolve the model for a given trigger type using the unified config system.
 * Uses resolveConfig() which handles ENV > runtime JSON > config.yml > defaults.
 * Falls back to models.trigger if the specific type key is not found.
 *
 * @param _configPath - Deprecated, kept for API compatibility (ignored)
 * @param triggerType - Model key to look up (e.g. "trigger", "cron")
 * @param _extraCandidates - Deprecated, kept for API compatibility (ignored)
 */

/**
 * Internal quality-gate roles must not inherit the strong/expensive `trigger`
 * model when their own key is absent from an older config — they have a
 * deliberate, cheaper default. The generic `trigger` fallback still applies to
 * every other key.
 */
const INTERNAL_ROLE_MODEL_DEFAULTS: Record<string, string> = {
  validator: "sonnet",
  subagent_review: "sonnet",
};

export function resolveModel(
  _configPath: string,
  triggerType: string,
  _extraCandidates?: string[],
): string {
  const homeDir = process.env.HOME ?? "/home/agent";
  const config = resolveConfig(homeDir);
  const models = config.models as Record<string, string>;
  return (
    models[triggerType] ??
    INTERNAL_ROLE_MODEL_DEFAULTS[triggerType] ??
    models["trigger"] ??
    "opus"
  );
}

/**
 * Returns the MCP servers config object for the query() call.
 * Merges user servers from:
 *   1. ~/.atlas-mcp/user.json (Atlas-managed user config)
 *   2. ~/.mcp.json (standard Claude MCP config)
 * Only stdio-based servers are included (URL-based cause silent exit issues with --mcp-config).
 */
export function getMcpServers(): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {};

  // Load user MCP servers from config files
  const userConfigPaths = [`${HOME}/.atlas-mcp/user.json`, `${HOME}/.mcp.json`];

  for (const configPath of userConfigPaths) {
    if (!existsSync(configPath)) continue;
    try {
      const raw = readFileSync(configPath, "utf8");
      const config = JSON.parse(raw) as {
        mcpServers?: Record<string, Record<string, unknown>>;
      };
      if (!config.mcpServers) continue;
      for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
        // Skip URL-based servers (cause silent exit issues)
        if ("url" in serverConfig) continue;
        // Don't override system servers
        if (name in servers) continue;
        servers[name] = serverConfig;
      }
    } catch {
      // Malformed JSON, skip
    }
  }

  return servers;
}

/**
 * Safe template substitution — replaces all occurrences of each key with
 * the corresponding value. Safe against regex injection because we use
 * simple string replace (not regex replace).
 */
export function safePlaceholderReplace(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    // Split on key and join with value — no regex involved
    result = result.split(key).join(value);
  }
  return result;
}

/**
 * Read a trigger's config from the SQLite database.
 * Returns null if not found or disabled.
 */
export function readTriggerConfig(
  db: Database,
  name: string,
): TriggerConfig | null {
  const row = db
    .prepare(
      "SELECT id, name, type, channel, prompt, session_mode, model_key, enabled FROM triggers WHERE name = ? LIMIT 1",
    )
    .get(name) as TriggerConfig | undefined;
  return row ?? null;
}

/**
 * Read usage_reporting config from config.yml.
 * Follows the same candidate path pattern as resolveModel.
 */
export function readUsageReportingConfig(): UsageReportingConfig {
  const defaults: UsageReportingConfig = {
    enabled: false,
    webhook_url: "",
    webhook_secret: "",
    include_tokens: false,
  };

  // 1. Try config.yml files
  const candidates = [`${HOME}/config.yml`, `${APP_DIR}/defaults/config.yml`];

  let result = { ...defaults };
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = readFileSync(candidate, "utf8");
      const config = yaml.load(raw) as Record<string, unknown> | null;
      const section = config?.usage_reporting as
        | Partial<UsageReportingConfig>
        | undefined;
      if (section) {
        result = {
          enabled: section.enabled ?? defaults.enabled,
          webhook_url: section.webhook_url ?? defaults.webhook_url,
          webhook_secret: section.webhook_secret ?? defaults.webhook_secret,
          include_tokens: section.include_tokens ?? defaults.include_tokens,
        };
        break;
      }
    } catch {
      continue;
    }
  }

  // 2. Environment variables override config.yml (highest priority)
  if (process.env.ATLAS_USAGE_ENABLED !== undefined) {
    result.enabled = process.env.ATLAS_USAGE_ENABLED === "true";
  }
  if (process.env.ATLAS_USAGE_WEBHOOK_URL) {
    result.webhook_url = process.env.ATLAS_USAGE_WEBHOOK_URL;
  }
  if (process.env.ATLAS_USAGE_WEBHOOK_SECRET) {
    result.webhook_secret = process.env.ATLAS_USAGE_WEBHOOK_SECRET;
  }
  if (process.env.ATLAS_USAGE_INCLUDE_TOKENS !== undefined) {
    result.include_tokens = process.env.ATLAS_USAGE_INCLUDE_TOKENS === "true";
  }

  return result;
}

/**
 * Send session usage data to the configured webhook endpoint.
 * Fire-and-forget — errors are logged but never block the trigger flow.
 */
/**
 * Send a single webhook request. Returns true on success, error message on failure.
 */
async function deliverWebhook(
  url: string,
  payloadJson: string,
  secret: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (secret) {
    // x-atlas-secret: used by Unclutter's authenticateAtlasRequest() to identify the container
    headers["x-atlas-secret"] = secret;
  }
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: payloadJson,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status} ${resp.statusText}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build the webhook payload from metrics data.
 */
function buildWebhookPayload(
  config: UsageReportingConfig,
  data: MetricsData,
): string {
  // Payload keys match Unclutter's /api/usage/session expected fields (camelCase)
  const payload: Record<string, unknown> = {
    event: "session.completed",
    sessionId: data.sessionId,
    triggerName: data.triggerName,
    startedAt: data.startedAt,
    endedAt: data.endedAt,
    durationMs: data.durationMs,
    numTurns: data.numTurns,
    isError: data.isError,
    timestamp: new Date().toISOString(),
  };

  if (config.include_tokens) {
    payload.metadata = {
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      cacheReadTokens: data.cacheReadTokens,
      cacheCreationTokens: data.cacheCreationTokens,
      costUsd: data.costUsd,
    };
  }

  return JSON.stringify(payload);
}

const MAX_WEBHOOK_ATTEMPTS = 5;

export async function sendUsageWebhook(
  config: UsageReportingConfig,
  data: MetricsData,
  log: { log: (msg: string) => void },
  db?: Database,
): Promise<void> {
  if (!config.enabled || !config.webhook_url) return;

  const payloadJson = buildWebhookPayload(config, data);
  const result = await deliverWebhook(
    config.webhook_url,
    payloadJson,
    config.webhook_secret || null,
  );

  if (result.ok) {
    log.log(`Usage webhook sent (${data.durationMs}ms session)`);
    return;
  }

  log.log(`Usage webhook failed: ${result.error} — queuing for retry`);

  // Queue for retry if DB available
  if (db) {
    try {
      db.prepare(
        `INSERT INTO webhook_queue (url, payload, secret, attempts, last_error, next_retry_at)
         VALUES (?, ?, ?, 1, ?, datetime('now', '+2 minutes'))`,
      ).run(
        config.webhook_url,
        payloadJson,
        config.webhook_secret || null,
        result.error,
      );
    } catch {
      log.log("Failed to queue webhook for retry");
    }
  }
}

/**
 * Flush pending webhooks from the queue. Called at the start of each trigger run.
 * Retries with exponential backoff: 2m, 10m, 30m, 2h, 6h (then gives up).
 */
export async function flushWebhookQueue(
  db: Database,
  log: { log: (msg: string) => void },
): Promise<void> {
  const BACKOFF_MINUTES = [2, 10, 30, 120, 360];

  let pending: Array<{
    id: number;
    url: string;
    payload: string;
    secret: string | null;
    attempts: number;
  }>;
  try {
    pending = db
      .prepare(
        `SELECT id, url, payload, secret, attempts FROM webhook_queue
       WHERE attempts <= ? AND next_retry_at <= datetime('now')
       ORDER BY created_at ASC LIMIT 20`,
      )
      .all(MAX_WEBHOOK_ATTEMPTS) as typeof pending;
  } catch {
    return; // Table may not exist yet in older DBs
  }

  if (!pending.length) return;
  log.log(`Flushing ${pending.length} queued webhook(s)...`);

  for (const item of pending) {
    const result = await deliverWebhook(item.url, item.payload, item.secret);

    if (result.ok) {
      db.prepare("DELETE FROM webhook_queue WHERE id = ?").run(item.id);
      log.log(`Queued webhook #${item.id} delivered successfully`);
    } else {
      const nextAttempt = item.attempts + 1;
      if (nextAttempt > MAX_WEBHOOK_ATTEMPTS) {
        db.prepare("DELETE FROM webhook_queue WHERE id = ?").run(item.id);
        log.log(
          `Queued webhook #${item.id} failed permanently after ${item.attempts} attempts — dropped`,
        );
      } else {
        const delayMin =
          BACKOFF_MINUTES[
            Math.min(nextAttempt - 1, BACKOFF_MINUTES.length - 1)
          ];
        db.prepare(
          `UPDATE webhook_queue SET attempts = ?, last_error = ?, next_retry_at = datetime('now', '+${delayMin} minutes')
           WHERE id = ?`,
        ).run(nextAttempt, result.error, item.id);
        log.log(
          `Queued webhook #${item.id} retry ${nextAttempt}/${MAX_WEBHOOK_ATTEMPTS} — next in ${delayMin}m`,
        );
      }
    }
  }

  // Cleanup: remove entries older than 7 days regardless of status
  try {
    db.prepare(
      "DELETE FROM webhook_queue WHERE created_at < datetime('now', '-7 days')",
    ).run();
  } catch {}
}

/**
 * Write session metrics to the session_metrics table.
 */
export function recordMetrics(db: Database, data: MetricsData): void {
  db.prepare(
    `
    INSERT INTO session_metrics
      (session_type, session_id, trigger_name, started_at, ended_at,
       duration_ms, input_tokens, output_tokens, cache_read_tokens,
       cache_creation_tokens, cost_usd, num_turns, is_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    data.sessionType,
    data.sessionId,
    data.triggerName,
    data.startedAt,
    data.endedAt,
    data.durationMs,
    data.inputTokens,
    data.outputTokens,
    data.cacheReadTokens,
    data.cacheCreationTokens,
    data.costUsd,
    data.numTurns,
    data.isError ? 1 : 0,
  );
}

// ---------------------------------------------------------------------------
// JSONL cost aggregation
// ---------------------------------------------------------------------------

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
 * Resolve the Claude project directory name for the current working directory.
 * Claude Code derives this by replacing every '/' with '-' and stripping the
 * leading '-'. This matches the directory naming used by Claude Code itself.
 */
export function resolveClaudeProjectDir(): string {
  const projectDir =
    process.env.CLAUDE_PROJECT_DIR ??
    process.cwd().replace(/\//g, "-").replace(/^-/, "");
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
    const projectDir = resolveClaudeProjectDir();
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


/**
 * Disable remote MCP connectors that hang on startup by writing to ~/.claude.json.
 */
export function disableRemoteMcp(): void {
  if (!existsSync(CLAUDE_JSON)) return;
  try {
    const raw = readFileSync(CLAUDE_JSON, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (!data.cachedGrowthBookFeatures) {
      data.cachedGrowthBookFeatures = {};
    }
    (
      data.cachedGrowthBookFeatures as Record<string, unknown>
    ).tengu_claudeai_mcp_connectors = false;
    writeFileSync(CLAUDE_JSON, JSON.stringify(data, null, 2));
  } catch {
    // Non-fatal — proceed anyway
  }
}

/**
 * Find the JSONL file for a session across all project directories.
 */
export function findSessionJsonl(
  sessionId: string,
  homeDir?: string,
): string | null {
  const base = homeDir ?? HOME;
  const projectsDir = `${base}/.claude/projects`;

  if (!existsSync(projectsDir)) return null;

  try {
    for (const projectEntry of readdirSync(projectsDir)) {
      const sessionsDir = `${projectsDir}/${projectEntry}/sessions`;
      if (!existsSync(sessionsDir)) continue;
      const candidate = `${sessionsDir}/${sessionId}.jsonl`;
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Check if a session's JSONL file ends with a "queue-operation" entry,
 * which indicates the container was killed mid-IPC-inject (corrupted state).
 */
export function checkCorruptedSession(
  sessionId: string,
  homeDir?: string,
): boolean {
  const jsonlPath = findSessionJsonl(sessionId, homeDir);
  if (!jsonlPath) return false;

  try {
    const content = readFileSync(jsonlPath, "utf8");
    const lines = content.trimEnd().split("\n");
    if (lines.length === 0) return false;
    const lastLine = lines[lines.length - 1];
    const parsed = JSON.parse(lastLine) as { type?: string };
    return parsed.type === "queue-operation";
  } catch {
    return false;
  }
}

/**
 * Check if a session is stale (no JSONL activity for longer than threshold).
 * Returns idle seconds, or 0 if the session is fresh or JSONL not found.
 */
export function getSessionIdleSeconds(
  sessionId: string,
  homeDir?: string,
): number {
  const jsonlPath = findSessionJsonl(sessionId, homeDir);
  if (!jsonlPath) return 0;

  try {
    const mtime = statSync(jsonlPath).mtimeMs;
    return (Date.now() - mtime) / 1000;
  } catch {
    return 0;
  }
}

/** Default: 10 minutes of no JSONL activity = stale (was 30min, reduced for faster frozen session detection) */
const STALE_SESSION_THRESHOLD_S = parseInt(
  process.env.STALE_SESSION_THRESHOLD ?? "600",
  10,
);

/**
 * Kill a running Claude session by finding and terminating the process owning its socket.
 */
function killSessionProcess(sessionId: string): void {
  const socketPath = `/tmp/claudec-${sessionId}.sock`;
  if (!existsSync(socketPath)) return;

  try {
    // Read the socket to find the owning process via lsof (more portable than fuser)
    const result = Bun.spawnSync(["lsof", "-t", socketPath]);
    const pids = result.stdout.toString().trim().split("\n").filter(Boolean);
    for (const pidStr of pids) {
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    }
  } catch {
    // lsof not available or failed — try to remove socket directly
  }

  // Clean up socket file
  try {
    unlinkSync(socketPath);
  } catch {}
}

/**
 * Run the optional middleware filter script for a trigger.
 * Returns true if the trigger should proceed, false if vetoed by filter.
 */
export async function runMiddlewareFilter(
  triggerName: string,
  payload: string,
): Promise<boolean> {
  const filterScript = `${WORKSPACE}/triggers/${triggerName}/filter.sh`;
  if (!existsSync(filterScript)) return true;

  const filterInput = payload || "{}";
  const proc = Bun.spawn(["bash", filterScript], {
    stdin: new TextEncoder().encode(filterInput),
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await proc.exited;
  return exitCode === 0;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Build the inject message for IPC injection, using channel-specific template
 * or the generic trigger-inject.md template.
 *
 * Naming convention: channel-specific inject templates live at
 * `${PROMPT_DIR}/trigger-channel-${channel}-inject.md` — the same
 * ``trigger-channel-${channel}-*.md`` family used by buildSystemPrompt for
 * the channel system prompt, farewell prompt, etc. Keeping the family
 * consistent means an operator adding a new channel only has to remember
 * one filename root.
 *
 * Exported (with an optional `appDir`) so it's unit-testable without
 * touching the real `/atlas/app/prompts` directory.
 */
export function buildInjectMessage(
  channel: string,
  triggerName: string,
  sessionKey: string,
  payload: string,
  promptFallback: string,
  appDir: string = APP_DIR,
): string {
  const promptDir = `${appDir}/prompts`;
  const candidates = [
    `${promptDir}/trigger-channel-${channel}-inject.md`,
    `${promptDir}/trigger-inject.md`,
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const template = readFileSync(candidate, "utf8");
      return safePlaceholderReplace(template, {
        "{{trigger_name}}": triggerName,
        "{{channel}}": channel,
        "{{sender}}": sessionKey,
        "{{payload}}": payload || promptFallback,
      });
    }
  }

  // Fallback if no template found
  return `New message arrived:\n\n${payload || promptFallback}\n\nProcess this message using the channel CLI tools (signal send / email reply) as appropriate.`;
}

/**
 * Open (or create) the database, ensuring required tables exist.
 * Does NOT run migrations — that's handled by init.sh on startup.
 * We use a simple open-only approach here.
 */
function openDb(): Database {
  return openSharedDb();
}

// ---------------------------------------------------------------------------
// Streaming chunk persistence (web channel only)
// ---------------------------------------------------------------------------

/**
 * State carried across stream_event messages for a single turn. We treat the
 * SDK's `message_start` raw event as the boundary between turns: a new
 * message id resets the chunk counter; deltas are appended in order.
 */
export interface StreamChunkState {
  /** Setter for the current turn's stable id. Called on message_start. */
  setUuid: (uuid: string) => void;
  /** Getter for the active turn id (null before message_start). */
  uuidRef: () => string | null;
  /** Returns the next chunk_index for the active turn (post-increments). */
  nextIndex: () => number;
}

/**
 * Persist a text delta from an SDKPartialAssistantMessage to
 * web_chat_stream_chunks so the web-ui SSE handler can forward it to the
 * client. Silently ignores non-text events (tool blocks, message_stop, etc.)
 * — those go through the regular JSONL → assistant_message path.
 *
 * Exported for unit testing; the production caller is the for-await loop in
 * the persistent web-chat session.
 */
export function persistStreamChunk(
  msg: { type: string; event?: unknown; session_id?: string },
  state: StreamChunkState,
  db: Database = openSharedDb(),
): void {
  if (msg.type !== "stream_event") return;
  const event = msg.event as
    | {
        type?: string;
        message?: { id?: string };
        delta?: { type?: string; text?: string };
      }
    | undefined;
  if (!event || typeof event !== "object") return;
  if (!msg.session_id) return;

  // message_start: begin a new turn. Use the Anthropic message id as the
  // stable handle the client will use to stitch chunks → final message.
  if (event.type === "message_start" && event.message?.id) {
    state.setUuid(event.message.id);
    return;
  }

  // content_block_delta: append the text fragment to the current turn.
  if (
    event.type === "content_block_delta"
    && event.delta?.type === "text_delta"
    && typeof event.delta.text === "string"
    && event.delta.text.length > 0
  ) {
    const uuid = state.uuidRef();
    if (!uuid) return; // no message_start yet — shouldn't happen, skip safely
    const index = state.nextIndex();
    db.prepare(
      `INSERT INTO web_chat_stream_chunks (session_id, message_uuid, chunk_index, content_delta)
       VALUES (?, ?, ?, ?)`,
    ).run(msg.session_id, uuid, index, event.delta.text);
  }
}

// ---------------------------------------------------------------------------
// 400 Upstream Error session clearing
// ---------------------------------------------------------------------------

/**
 * Detect whether a result string indicates an Anthropic 400 upstream error.
 * These occur when the payload is too large (e.g. inlined image data exceeds
 * Anthropic's per-image 5 MB or per-request 20 MB limits).
 */
export function is400UpstreamError(resultText: string | null | undefined): boolean {
  if (typeof resultText !== "string") return false;
  return resultText.startsWith("API Error: 400");
}

/**
 * If the result is a 400 Upstream Error, delete the session row for the
 * given (triggerName, sessionKey) so the next message starts fresh.
 * Returns the session_id that was cleared, or null if nothing was cleared.
 *
 * Exported for testing; called by main() after each query run.
 */
export function clearSessionOn400(
  db: Database,
  resultText: string | null | undefined,
  sessionMode: string,
  triggerName: string,
  sessionKey: string,
  capturedSessionId: string | null,
  existingSession: string | null,
  log: { log: (msg: string) => void },
): string | null {
  if (!is400UpstreamError(resultText)) return null;
  if (sessionMode !== "persistent") return null;

  const oldSessionId = capturedSessionId ?? existingSession;
  if (!oldSessionId) return null;

  db.prepare(
    "DELETE FROM trigger_sessions WHERE trigger_name = ? AND session_key = ?",
  ).run(triggerName, sessionKey);
  log.log(
    `Upstream 400 detected — clearing session ${oldSessionId} so next message starts fresh`,
  );
  return oldSessionId;
}

// ---------------------------------------------------------------------------
// Direct mode (no DB trigger)
// ---------------------------------------------------------------------------

export type RunDirectOptions = {
  channel?: string;
  modelKey?: string;
  env?: Record<string, string>;
  resumeId?: string;
  /**
   * Override the trigger_name recorded in session_metrics. Defaults to "direct".
   * When set to a custom value (e.g. "validator"), the session is recorded under
   * that name so downstream filters (dreaming, memory-cleanup) can exclude it.
   */
  triggerName?: string;
};

/**
 * Run a Claude session directly with a prompt, without needing a DB trigger entry.
 * Used by manage-reminders.ts and event.sh for ad-hoc sessions.
 *
 * @param prompt - The user prompt to send
 * @param options - Optional overrides for channel, modelKey, and extra env vars
 */
export async function runDirect(
  prompt: string,
  options?: RunDirectOptions,
): Promise<void> {
  const channel = options?.channel ?? "internal";
  const modelKey = options?.modelKey ?? "trigger";
  const triggerName = options?.triggerName ?? "direct";

  const log = makeLogger(triggerName);

  // --- Disable remote MCP ---
  disableRemoteMcp();

  // --- Build system prompt ---
  const systemPrompt = buildSystemPrompt(channel);

  // --- Resolve model ---
  const model = resolveModel(`${HOME}/config.yml`, modelKey);

  // --- MCP servers ---
  const mcpServers = getMcpServers();

  // --- Set environment variables ---
  process.env.ATLAS_TRIGGER = triggerName;
  process.env.ATLAS_TRIGGER_CHANNEL = channel;
  delete process.env.CLAUDECODE;

  // Apply any extra env vars from options
  if (options?.env) {
    for (const [k, v] of Object.entries(options.env)) {
      process.env[k] = v;
    }
  }

  const triggerTimeout =
    parseInt(process.env.TRIGGER_TIMEOUT ?? "3600", 10) * 1000;

  log.log(`Direct session starting (channel=${channel}, model=${model})`);

  const startedAt = isoNow();
  const startedMs = Date.now();
  let resultMsg: SDKResultMessage | null = null;
  let capturedSessionId: string | null = null;
  let isError = false;

  const resumeId = options?.resumeId;
  const queryOptions: Parameters<typeof query>[0]["options"] = {
    systemPrompt,
    model,
    mcpServers,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    autoMemoryEnabled: false,
    disallowedTools: DISALLOWED_BUILTIN_TOOLS,
    cwd: HOME,
    ...(resumeId ? { resume: resumeId } : { persistSession: false }),
    ...(CLAUDE_CODE_PATH
      ? { pathToClaudeCodeExecutable: CLAUDE_CODE_PATH }
      : {}),
  };

  const q = query({ prompt, options: queryOptions });

  const timeoutHandle = setTimeout(() => {
    q.return(undefined);
  }, triggerTimeout);

  try {
    for await (const msg of q) {
      if (msg.type === "result") {
        resultMsg = msg as SDKResultMessage;
        capturedSessionId = (msg as { session_id?: string }).session_id ?? capturedSessionId;
        isError = msg.subtype !== "success";
        break;
      }
      // Capture session_id from any earlier message that carries it
      if (!capturedSessionId && "session_id" in msg && (msg as { session_id?: string }).session_id) {
        capturedSessionId = (msg as { session_id: string }).session_id;
      }
    }
  } catch (err) {
    log.log(`ERROR in direct session: ${err}`);
    isError = true;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (resultMsg && "result" in resultMsg) {
    log.log(
      `Result: ${(resultMsg as { result: string }).result ?? "(no result)"}`,
    );
  }

  // When a custom triggerName was provided (e.g. "validator"), record a
  // session_metrics row so dreaming/memory-cleanup filters can exclude this
  // session from later analysis. Default "direct" sessions stay unrecorded
  // to preserve current behavior.
  if (options?.triggerName && capturedSessionId) {
    try {
      const usage = resultMsg && "usage" in resultMsg
        ? (resultMsg as { usage?: Record<string, number> }).usage
        : undefined;
      const cost = resultMsg && "total_cost_usd" in resultMsg
        ? (resultMsg as { total_cost_usd?: number }).total_cost_usd ?? 0
        : 0;
      const numTurns = resultMsg && "num_turns" in resultMsg
        ? (resultMsg as { num_turns?: number }).num_turns ?? 0
        : 0;

      // session_metrics is created by atlas-db.ts; open lazily.
      // If atlas-db.ts hasn't run for this DB yet the table may be missing —
      // we wrap the insert in try/catch so it's a no-op on fresh installs.
      const db = openDb();
      recordMetrics(db, {
        sessionType: "direct",
        sessionId: capturedSessionId,
        triggerName,
        startedAt,
        endedAt: isoNow(),
        durationMs: Date.now() - startedMs,
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
        costUsd: cost,
        numTurns,
        isError,
      });
    } catch (err) {
      log.log(`metrics write skipped: ${err}`);
    }
  }

  log.log(`Direct session done (error=${isError})`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  // --- Pause guard: skip execution if Atlas is paused ---
  if (existsSync(join(HOME, ".atlas-paused"))) {
    console.log(
      `[${new Date().toISOString()}] Atlas is paused, skipping trigger execution`,
    );
    process.exit(0);
  }

  const args = process.argv.slice(2);

  // --- Direct mode: --direct "<prompt>" [--channel <channel>] [--model-key <key>] [--resume <session-id>] [--trigger-name <name>] ---
  if (args[0] === "--direct") {
    const prompt = args[1];
    if (!prompt) {
      console.error(
        'Usage: trigger-runner.ts --direct "<prompt>" [--channel <channel>] [--model-key <key>] [--resume <session-id>] [--trigger-name <name>]',
      );
      process.exit(1);
    }

    let channel = "internal";
    let modelKey = process.env.ATLAS_CRON === "1" ? "cron" : "trigger";
    let resumeId: string | undefined;
    let triggerNameOverride: string | undefined;

    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--channel" && args[i + 1]) {
        channel = args[++i];
      } else if (args[i] === "--model-key" && args[i + 1]) {
        modelKey = args[++i];
      } else if (args[i] === "--resume" && args[i + 1]) {
        resumeId = args[++i];
      } else if (args[i] === "--trigger-name" && args[i + 1]) {
        triggerNameOverride = args[++i];
      }
    }

    await runDirect(prompt, { channel, modelKey, resumeId, triggerName: triggerNameOverride });
    return;
  }

  const [triggerName, payload = "", sessionKeyArg] = args;

  if (!triggerName) {
    console.error(
      "Usage: trigger-runner.ts <trigger-name> [payload] [session-key]",
    );
    console.error(
      '       trigger-runner.ts --direct "<prompt>" [--channel <channel>]',
    );
    process.exit(1);
  }

  const log = makeLogger(triggerName);

  // --- Open DB ---
  if (!existsSync(DB_PATH)) {
    console.error(
      `[${new Date().toISOString()}] ERROR: Database not found: ${DB_PATH}`,
    );
    process.exit(1);
  }
  const db = openDb();

  // --- Flush any queued webhooks from previous failed sends ---
  try {
    await flushWebhookQueue(db, log);
  } catch {
    // Non-critical — don't block the trigger run
  }

  // --- Read trigger config ---
  const config = readTriggerConfig(db, triggerName);
  if (!config) {
    console.error(
      `[${new Date().toISOString()}] Trigger not found: ${triggerName}`,
    );
    process.exit(1);
  }

  if (!config.enabled) {
    log.log(`Trigger disabled: ${triggerName}`);
    process.exit(0);
  }

  const channel = config.channel || "internal";
  const sessionMode = config.session_mode || "ephemeral";

  // --- Synthetic session_key for webhooks without an explicit key ---
  // Webhook triggers often have no natural session grouping; without a key
  // ATLAS_TRIGGER_SESSION_KEY would be unset inside the session, which breaks
  // `task goal create` and other session-scoped CLI commands.
  // Generate a stable synthetic key from the trigger run ID so each webhook
  // invocation gets its own isolated task scope.
  let sessionKey = sessionKeyArg ?? "_default";
  if (config.type === "webhook" && !sessionKeyArg) {
    // We need the run ID — insert the trigger_runs row early so we can use it.
    // (It will be inserted again below with RETURNING id; we detect and reuse here.)
    let syntheticRunId: number | null = null;
    try {
      const runRow = db
        .prepare(
          `INSERT INTO trigger_runs (trigger_name, session_key, session_mode, payload)
           VALUES (?, ?, ?, ?)
           RETURNING id`,
        )
        .get(triggerName, "_pending", sessionMode, payload) as { id: number } | undefined;
      syntheticRunId = runRow?.id ?? null;
    } catch {
      // trigger_runs may not exist yet — fall back to timestamp
    }
    if (syntheticRunId !== null) {
      sessionKey = `webhook-${syntheticRunId}`;
      // Update the row with the final session key
      try {
        db.prepare("UPDATE trigger_runs SET session_key = ? WHERE id = ?").run(
          sessionKey,
          syntheticRunId,
        );
      } catch {}
    } else {
      sessionKey = `webhook-${triggerName}-${Date.now()}`;
    }
    log.log(`Synthetic session key for webhook: ${sessionKey}`);
  }

  // --- Build prompt ---
  let prompt = config.prompt;

  // Fallback: load prompt from workspace file
  if (!prompt) {
    const promptFile = `${WORKSPACE}/triggers/${triggerName}/prompt.md`;
    if (existsSync(promptFile)) {
      prompt = readFileSync(promptFile, "utf8");
    } else {
      prompt = `Trigger '${triggerName}' was fired.`;
    }
  }

  // Substitute placeholders
  prompt = safePlaceholderReplace(prompt, {
    "{{payload}}": payload,
    "{{sender}}": sessionKey,
    "{{channel}}": channel,
    "{{trigger_name}}": triggerName,
  });

  // --- Update trigger stats ---
  db.prepare(
    "UPDATE triggers SET last_run = datetime('now'), run_count = run_count + 1 WHERE name = ?",
  ).run(triggerName);

  // --- Persistent session: try IPC injection first ---
  let existingSession: string | null = null;
  let staleRecovery = false;

  function sessionFileExists(sessionId: string): boolean {
    const projectsDir = join(HOME, ".claude", "projects");
    if (!existsSync(projectsDir)) return false;
    try {
      for (const dir of readdirSync(projectsDir)) {
        if (existsSync(join(projectsDir, dir, `${sessionId}.jsonl`)))
          return true;
      }
    } catch {}
    return false;
  }

  if (sessionMode === "persistent") {
    const sessionRow = db
      .prepare(
        "SELECT session_id FROM trigger_sessions WHERE trigger_name = ? AND session_key = ? LIMIT 1",
      )
      .get(triggerName, sessionKey) as { session_id: string } | undefined;

    existingSession = sessionRow?.session_id ?? null;

    // Guard: corrupted session (killed mid-IPC-inject)
    if (existingSession && checkCorruptedSession(existingSession)) {
      log.log(
        `Corrupted session ${existingSession} (ended mid-IPC-inject) — clearing, will start fresh`,
      );
      db.prepare(
        "DELETE FROM trigger_sessions WHERE trigger_name = ? AND session_key = ?",
      ).run(triggerName, sessionKey);
      existingSession = null;
    }

    // Guard: session file doesn't exist — clear stale session entry
    if (existingSession && !sessionFileExists(existingSession)) {
      log.log(
        `Session file missing for ${existingSession} — clearing, will start fresh`,
      );
      db.prepare(
        "DELETE FROM trigger_sessions WHERE trigger_name = ? AND session_key = ?",
      ).run(triggerName, sessionKey);
      existingSession = null;
    }

    // Try socket injection if session is running
    if (existingSession) {
      const customSocketPath = getSocketPath(triggerName, sessionKey);
      const idleSeconds = getSessionIdleSeconds(existingSession);
      const isStopCommand = payload.trim().toLowerCase() === "/stop";

      if (idleSeconds >= STALE_SESSION_THRESHOLD_S) {
        // Session is stale (no JSONL activity) — kill it, then resume with notice
        log.log(
          `Stale session ${existingSession} (idle ${Math.round(idleSeconds)}s) — killing process`,
        );
        killSessionProcess(existingSession);
        staleRecovery = true;
      } else {
        // Session might be alive — try socket injection
        const injectMsg = buildInjectMessage(
          channel,
          triggerName,
          sessionKey,
          payload,
          prompt,
        );

        const socketInjected = await trySocketInject(
          customSocketPath,
          injectMsg,
          channel,
          sessionKey,
          isStopCommand ? "interrupt" : undefined,
        );
        if (socketInjected) {
          log.log(
            `Injected via custom socket into session ${existingSession} (key=${sessionKey})${isStopCommand ? " [interrupt]" : ""}`,
          );
          process.exit(0);
        }
        // Socket not available — fall through to acquire lock + resume
      }
    }
  }

  // --- Middleware filter ---
  const shouldProceed = await runMiddlewareFilter(triggerName, payload);
  if (!shouldProceed) {
    log.log(`Filtered by middleware: ${triggerName} (key=${sessionKey})`);
    process.exit(0);
  }

  // --- Acquire flock-style dedup lock ---
  // We use a simple lockfile approach: write our PID, check if process is alive
  const safeKey = sessionKey.replace(/[^a-zA-Z0-9_]/g, "_");
  const flockCandidate = `/tmp/.trigger-${triggerName}-${safeKey}.flock`;
  // Keep flock paths consistent with socket paths when keys are long
  const flockFile =
    flockCandidate.length > 108
      ? `/tmp/.trigger-${triggerName}-${createHash("sha256").update(`${triggerName}-${sessionKey}`).digest("hex").slice(0, 16)}.flock`
      : flockCandidate;

  // Acquire lock: check existing PID, wait up to 60s
  const lockAcquireStart = Date.now();
  let lockAcquired = false;
  while (Date.now() - lockAcquireStart < 60_000) {
    if (existsSync(flockFile)) {
      const existingPid = parseInt(readFileSync(flockFile, "utf8").trim(), 10);
      // Check if process is still alive
      let isAlive = false;
      try {
        process.kill(existingPid, 0);
        isAlive = true;
      } catch {
        // Process dead — stale lock
      }
      if (isAlive) {
        await Bun.sleep(500);
        continue;
      }
    }
    // Write our PID
    writeFileSync(flockFile, String(process.pid));
    lockAcquired = true;
    break;
  }

  if (!lockAcquired) {
    // Lock held — try injecting via our custom socket (session is running)
    const socketPath = getSocketPath(triggerName, sessionKey);
    const isStopCommandLock = payload.trim().toLowerCase() === "/stop";
    const injectMsg = buildInjectMessage(
      channel,
      triggerName,
      sessionKey,
      payload,
      prompt,
    );
    const socketInjected = await trySocketInject(
      socketPath,
      injectMsg,
      channel,
      sessionKey,
      isStopCommandLock ? "interrupt" : undefined,
    );
    if (socketInjected) {
      log.log(
        `Injected via socket into running session for ${triggerName} (key=${sessionKey})${isStopCommandLock ? " [interrupt]" : ""}`,
      );
      process.exit(0);
    }
    // Socket not available — cannot inject, exit with warning
    log.log(
      `WARNING: Lock held but socket unavailable for ${triggerName} (key=${sessionKey}) — message may be lost`,
    );
    process.exit(1);
  }

  // Ensure lock + socket are released on exit
  const triggerSocketPath = getSocketPath(triggerName, sessionKey);
  const releaseLock = () => {
    try {
      unlinkSync(flockFile);
    } catch {}
    // Socket cleanup is best-effort (may already be cleaned up by runQuery)
    if (existsSync(triggerSocketPath)) {
      try {
        unlinkSync(triggerSocketPath);
      } catch {}
    }
  };
  process.on("exit", releaseLock);
  process.on("SIGTERM", () => {
    releaseLock();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    releaseLock();
    process.exit(0);
  });

  // Re-read session from DB after lock (another runner may have created one)
  if (sessionMode === "persistent" && !existingSession) {
    const sessionRow = db
      .prepare(
        "SELECT session_id FROM trigger_sessions WHERE trigger_name = ? AND session_key = ? LIMIT 1",
      )
      .get(triggerName, sessionKey) as { session_id: string } | undefined;
    existingSession = sessionRow?.session_id ?? null;
    if (existingSession) {
      log.log(
        `Session appeared after lock wait: ${existingSession} (key=${sessionKey})`,
      );
    }
  }

  // Guard: session file doesn't exist after lock — clear stale session entry
  if (existingSession && !sessionFileExists(existingSession)) {
    log.log(
      `Session file missing for ${existingSession} after lock — will start fresh`,
    );
    db.prepare(
      "DELETE FROM trigger_sessions WHERE trigger_name = ? AND session_key = ?",
    ).run(triggerName, sessionKey);
    existingSession = null;
  }

  // Re-check custom socket after acquiring lock
  if (sessionMode === "persistent" && existingSession) {
    const isStopCommandPostLock = payload.trim().toLowerCase() === "/stop";
    const injectMsg = buildInjectMessage(
      channel,
      triggerName,
      sessionKey,
      payload,
      prompt,
    );
    const customInjected = await trySocketInject(
      getSocketPath(triggerName, sessionKey),
      injectMsg,
      channel,
      sessionKey,
      isStopCommandPostLock ? "interrupt" : undefined,
    );
    if (customInjected) {
      log.log(
        `Injected via custom socket after lock wait for ${triggerName} (key=${sessionKey})${isStopCommandPostLock ? " [interrupt]" : ""}`,
      );
      releaseLock();
      process.exit(0);
    }
    // Socket not available — fall through to resume
  }

  log.log(
    `Trigger firing: ${triggerName} (mode=${sessionMode}, key=${sessionKey}, channel=${channel})`,
  );

  const startedAt = isoNow();

  // --- Track this run ---
  // For webhook triggers we may have already inserted a trigger_runs row above
  // (to generate a synthetic session key). In that case reuse the existing id.
  let runId: number | null = null;
  const syntheticWebhookRun = config.type === "webhook" && !sessionKeyArg
    ? (() => {
        try {
          const row = db.prepare(
            "SELECT id FROM trigger_runs WHERE trigger_name = ? AND session_key = ? ORDER BY id DESC LIMIT 1"
          ).get(triggerName, sessionKey) as { id: number } | undefined;
          return row?.id ?? null;
        } catch { return null; }
      })()
    : null;

  if (syntheticWebhookRun !== null) {
    runId = syntheticWebhookRun;
  } else {
    try {
      const runRow = db
        .prepare(
          `
        INSERT INTO trigger_runs (trigger_name, session_key, session_mode, payload)
        VALUES (?, ?, ?, ?)
        RETURNING id
      `,
        )
        .get(triggerName, sessionKey, sessionMode, payload) as
        | { id: number }
        | undefined;
      runId = runRow?.id ?? null;
    } catch {
      // trigger_runs table may not exist in older DBs
    }
  }

  // --- Disable remote MCP ---
  disableRemoteMcp();

  // --- Build system prompt ---
  const systemPrompt = buildSystemPrompt(channel);

  // --- Resolve model ---
  // Per-trigger model_key (from DB) overrides the env-driven default so a
  // single cron can opt out of the global `models.cron` setting — e.g. a
  // lightweight daily digest running cheaper than security-scan.
  const defaultModelKey = process.env.ATLAS_CRON === "1" ? "cron" : "trigger";
  const modelKey = (config.model_key && config.model_key.trim()) || defaultModelKey;
  const model = resolveModel(`${HOME}/config.yml`, modelKey);

  // --- MCP servers ---
  const mcpServers = getMcpServers();

  // --- Set environment variables ---
  process.env.ATLAS_TRIGGER = triggerName;
  process.env.ATLAS_TRIGGER_CHANNEL = channel;
  process.env.ATLAS_TRIGGER_SESSION_KEY = sessionKey;
  delete process.env.CLAUDECODE; // avoid nested-session detection

  // --- Run the query ---
  // Persistent sessions can run for hours (long tasks) — no hard timeout.
  // Ephemeral sessions get a timeout to prevent runaway processes.
  const triggerTimeout =
    sessionMode === "persistent"
      ? undefined
      : parseInt(process.env.TRIGGER_TIMEOUT ?? "3600", 10) * 1000;

  let resultMsg: SDKResultMessage | null = null;
  let capturedSessionId: string | null = null;
  let isError = false;

  // If recovering from a stale session, prepend a system notice to the prompt
  // so the session knows it was idle-terminated and should continue.
  if (staleRecovery) {
    prompt = `<system-notice>This session was terminated due to inactivity. The previous session state has been preserved. Please continue where you left off and process the new message below.</system-notice>\n\n${prompt}`;
  }

  // --- Set up message channel + socket server for message injection ---
  const socketPath = getSocketPath(triggerName, sessionKey);
  // Use a placeholder session_id initially; the generator produces messages with it
  const msgChannel = createMessageChannel(
    "pending",
    sessionMode === "persistent" ? undefined : IDLE_TIMEOUT_MS,
  );
  let socketServer: Server | null = null;

  // Streaming: emit text deltas for any session whose channel renders them
  // (today: web). Other channels (signal, email) deliver complete messages
  // anyway, so there's no benefit to the extra event volume.
  const wantsStreaming = channel === "web";

  const runQuery = async (resumeId?: string) => {
    // Mid-turn steering queue. Signal messages that arrive during an active
    // turn are pushed here instead of into msgChannel. The PostToolBatch hook
    // (registered below) drains the queue at every tool-call boundary and
    // returns its contents as `additionalContext`, which the SDK injects into
    // the NEXT LLM call within the same turn. That gives the "user message
    // between tool calls" UX Claude Code's interactive REPL has — without
    // restarting the turn or dropping work.
    //
    // Verified empirically with post-tool-batch-smoke-test.ts: the agent
    // followed the steering directive on the next tool call.
    //
    // When no turn is active (between turns waiting for next user message),
    // socket injects fall through to msgChannel.push to trigger a new turn.
    // After a turn ends, any messages still in the queue (arrived after the
    // last tool batch) are flushed to msgChannel to start a new turn.
    const injectionQueue: string[] = [];
    let inTurn = false;

    const options: Parameters<typeof query>[0]["options"] = {
      systemPrompt,
      model,
      mcpServers,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      autoMemoryEnabled: false,
      disallowedTools: DISALLOWED_BUILTIN_TOOLS,
      cwd: HOME,
      ...(resumeId ? { resume: resumeId } : {}),
      ...(CLAUDE_CODE_PATH
        ? { pathToClaudeCodeExecutable: CLAUDE_CODE_PATH }
        : {}),
      ...(wantsStreaming ? { includePartialMessages: true } : {}),
      hooks: {
        PostToolBatch: [
          {
            hooks: [
              async () => {
                const pending = injectionQueue.splice(0);
                if (pending.length === 0) {
                  return {};
                }
                log.log(
                  `Mid-turn steering: injecting ${pending.length} queued message(s) as additionalContext`,
                );
                return {
                  hookSpecificOutput: {
                    hookEventName: "PostToolBatch" as const,
                    additionalContext: pending
                      .map((t) => `[Steering-Nachricht von ${sessionKey} (während aktivem Turn empfangen)]\n${t}`)
                      .join("\n\n---\n\n"),
                  },
                };
              },
            ],
          },
        ],
      },
    };

    // Typing indicator: one-shot per turn (no heartbeat).
    // signal-cli's `sendTyping` auto-expires after ~15s on Signal's side,
    // which is exactly the "the agent is doing something" feedback we want
    // at the START of each turn. No interval — keeps the indicator honest:
    // it stops on its own even if the turn runs long.
    const sendTypingOnce = () => {
      if (channel !== "signal") return;
      try {
        Bun.spawn(["signal", "typing", sessionKey], {
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch {}
    };

    // Push the initial prompt as the first message + flash typing for turn 1
    msgChannel.push(prompt);
    inTurn = true;
    sendTypingOnce();

    // Use a mutable reference so the socket server control handler can call q.interrupt()
    let q: import("@anthropic-ai/claude-agent-sdk").Query | null = null;

    // Start socket server so other trigger-runner processes can inject messages.
    //
    // Routing:
    //   - inTurn === true (turn in progress) → queue for PostToolBatch hook.
    //     The hook drains the queue at every tool boundary, returning the
    //     content as additionalContext — injected into the next LLM call
    //     within the same turn. No msgChannel push, so the previous
    //     "shouldQuery=false orphan" idle-timeout regression is structurally
    //     impossible.
    //   - inTurn === false (between turns) → push to msgChannel directly,
    //     triggering the next turn.
    socketServer = startSocketServer(
      socketPath,
      (text) => {
        if (inTurn) {
          // Mid-turn: hand off to the PostToolBatch hook via in-process queue.
          injectionQueue.push(text);
        } else {
          // Between turns: trigger a new turn.
          msgChannel.push(text);
          inTurn = true;
        }
        // Each new injected message gets a typing flash.
        sendTypingOnce();
      },
      async (control) => {
        if (control === "interrupt" && q) {
          try {
            await q.interrupt();
            log.log("Received /stop — query interrupted");
            // Send a short Signal reply to inform the user the session stopped
            if (channel === "signal") {
              try {
                Bun.spawn(["signal", "send", sessionKey, "Session unterbrochen."], {
                  stdout: "ignore",
                  stderr: "ignore",
                });
              } catch {}
            }
          } catch (err) {
            log.log(`q.interrupt() failed: ${err}`);
          }
        }
      },
      log,
    );

    q = query({ prompt: msgChannel.generator, options });

    const timeoutHandle = triggerTimeout
      ? setTimeout(() => {
          q?.close();
        }, triggerTimeout)
      : undefined;

    // Per-message chunk counter for streaming. Resets when a new
    // SDKAssistantMessage uuid appears so each turn's deltas index from 0.
    let streamChunkUuid: string | null = null;
    let streamChunkIndex = 0;

    try {
      for await (const msg of q) {
        if (msg.type === "result") {
          // Multi-turn: capture latest result state but DO NOT break.
          // runQuery stays alive so mid-turn injected messages (already in
          // msgChannel's pending queue) are pulled by the SDK as the next
          // user message. The for-await loop ends naturally when
          // msgChannel.generator finishes (idle timeout closes it) or when
          // the trigger timeout fires q.close().
          resultMsg = msg as SDKResultMessage;
          capturedSessionId = msg.session_id ?? null;
          isError = msg.subtype !== "success";
          inTurn = false;
          const turnText = "result" in msg ? (msg as { result?: string }).result : undefined;
          if (turnText) log.log(`Turn result: ${turnText}`);

          // Flush any messages that arrived AFTER the last tool batch
          // (PostToolBatch hook never got a chance to drain them) — push
          // them now to start a new turn so they don't sit orphaned in the
          // queue until idle timeout.
          if (injectionQueue.length > 0) {
            const leftover = injectionQueue.splice(0);
            log.log(
              `End-of-turn flush: ${leftover.length} queued message(s) → new turn`,
            );
            for (const text of leftover) {
              msgChannel.push(text);
            }
            inTurn = true;
          }

          continue;
        }
        // Capture session_id from any message that carries it
        if ("session_id" in msg && msg.session_id && !capturedSessionId) {
          capturedSessionId = msg.session_id as string;
        }
        // Streaming: persist text deltas so the web-ui SSE handler can
        // forward them to the client in near-real-time. We accept the cost
        // of one INSERT per delta (typically a few characters) because the
        // chunks table is local SQLite and the web channel is low-volume.
        //
        // Per the SDK type `SDKPartialAssistantMessage.session_id` is always
        // present on stream_event messages, but we belt-and-brace with the
        // outer `capturedSessionId` so a future SDK change can't silently
        // drop every chunk by handing us a partial without session_id.
        if (wantsStreaming && msg.type === "stream_event") {
          try {
            const sid = (msg as unknown as { session_id?: string }).session_id
              ?? capturedSessionId
              ?? undefined;
            if (sid) {
              persistStreamChunk(
                { type: msg.type, event: (msg as unknown as { event?: unknown }).event, session_id: sid },
                {
                  setUuid: (u) => { streamChunkUuid = u; streamChunkIndex = 0; },
                  uuidRef: () => streamChunkUuid,
                  nextIndex: () => streamChunkIndex++,
                },
                db,
              );
            }
          } catch (err) {
            // Don't let a malformed stream event tear down the whole turn.
            log.log(`stream-chunk persist failed: ${err}`);
          }
        }
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      msgChannel.close();
      cleanupSocket(socketServer, socketPath);
      socketServer = null;
    }
  };

  try {
    if (sessionMode === "persistent" && existingSession) {
      log.log(`Resuming session for key=${sessionKey}: ${existingSession}`);
      try {
        await runQuery(existingSession);
        // Check for silent failure: error with 0 turns means resume failed
        if (isError && (resultMsg as any)?.num_turns === 0) {
          throw new Error("Resume returned error with 0 turns");
        }
      } catch (err) {
        // Resume failed — retry as fresh session
        log.log(
          `Resume failed for session ${existingSession} — retrying as fresh session: ${err}`,
        );
        db.prepare(
          "DELETE FROM trigger_sessions WHERE trigger_name = ? AND session_key = ?",
        ).run(triggerName, sessionKey);
        existingSession = null;
        resultMsg = null;
        capturedSessionId = null;
        isError = false;
        // Need a fresh message channel for the retry
        cleanupSocket(socketServer, socketPath);
        socketServer = null;
        await runQuery();
      }
    } else {
      if (sessionMode === "persistent") {
        log.log(`New persistent session for key=${sessionKey}`);
      }
      await runQuery();
    }
  } catch (err) {
    log.log(`ERROR running trigger: ${err}`);
    isError = true;
    cleanupSocket(socketServer, socketPath);
  }

  // Log result text
  const resultText = resultMsg && "result" in resultMsg
    ? ((resultMsg as { result: string }).result ?? "(no result)")
    : null;
  if (resultText !== null) {
    log.log(`Result: ${resultText}`);
  }

  const endedAt = isoNow();

  // --- 400 Upstream Error guard: clear broken session before saving ---
  // When the Anthropic API returns a 400 "Upstream error" (e.g. payload too
  // large due to inline image content), the session itself is fine to discard —
  // persisting the failing session_id would make every subsequent message in
  // this thread resume the same broken context and fail identically.
  const cleared = clearSessionOn400(
    db, resultText, sessionMode, triggerName, sessionKey,
    capturedSessionId, existingSession, log,
  );
  if (cleared !== null) {
    // Don't save the failing session below
    capturedSessionId = null;
  }

  // --- Save session for persistent triggers ---
  if (sessionMode === "persistent" && capturedSessionId) {
    db.prepare(
      `
      INSERT INTO trigger_sessions (trigger_name, session_key, session_id)
      VALUES (?, ?, ?)
      ON CONFLICT(trigger_name, session_key) DO UPDATE SET session_id = ?, updated_at = datetime('now')
    `,
    ).run(triggerName, sessionKey, capturedSessionId, capturedSessionId);
    log.log(`Saved session for key=${sessionKey}: ${capturedSessionId}`);
  }

  // --- Record metrics ---
  // Aggregate cost from parent JSONL + all subagent JSONLs within the run window.
  // The Anthropic SDK does NOT aggregate subagent token usage into the parent
  // resultMsg.usage — each subagent call has its own API request_id.
  // Scanning the JSONL files directly gives us the true total cost.
  const usage =
    (resultMsg as { usage?: Record<string, number> } | null)?.usage ?? {};
  let aggregated: AggregatedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };
  if (capturedSessionId) {
    try {
      aggregated = aggregateRunCost(capturedSessionId, startedAt, endedAt);
    } catch {
      // Fall back to SDK-reported values if aggregation fails
      aggregated = {
        inputTokens: (usage.input_tokens as number | undefined) ?? 0,
        outputTokens: (usage.output_tokens as number | undefined) ?? 0,
        cacheReadTokens: (usage.cache_read_input_tokens as number | undefined) ?? 0,
        cacheCreationTokens: (usage.cache_creation_input_tokens as number | undefined) ?? 0,
        costUsd: (resultMsg as { total_cost_usd?: number } | null)?.total_cost_usd ?? 0,
      };
    }
  }
  try {
    recordMetrics(db, {
      sessionType: "trigger",
      sessionId: capturedSessionId ?? "",
      triggerName,
      startedAt,
      endedAt,
      durationMs:
        (resultMsg as { duration_ms?: number } | null)?.duration_ms ?? 0,
      inputTokens: aggregated.inputTokens,
      outputTokens: aggregated.outputTokens,
      cacheReadTokens: aggregated.cacheReadTokens,
      cacheCreationTokens: aggregated.cacheCreationTokens,
      costUsd: aggregated.costUsd,
      numTurns: (resultMsg as { num_turns?: number } | null)?.num_turns ?? 0,
      isError,
    });
  } catch {
    // session_metrics table may not exist in very old DBs
  }

  // --- Send usage reporting webhook ---
  try {
    const usageConfig = readUsageReportingConfig();
    await sendUsageWebhook(
      usageConfig,
      {
        sessionType: "trigger",
        sessionId: capturedSessionId ?? "",
        triggerName,
        startedAt,
        endedAt,
        durationMs:
          (resultMsg as { duration_ms?: number } | null)?.duration_ms ?? 0,
        inputTokens: aggregated.inputTokens,
        outputTokens: aggregated.outputTokens,
        cacheReadTokens: aggregated.cacheReadTokens,
        cacheCreationTokens: aggregated.cacheCreationTokens,
        costUsd: aggregated.costUsd,
        numTurns: (resultMsg as { num_turns?: number } | null)?.num_turns ?? 0,
        isError,
      },
      log,
      db,
    );
  } catch {
    // Usage reporting should never block trigger completion
  }

  // --- Mark run completed ---
  if (runId !== null && capturedSessionId !== null) {
    try {
      db.prepare(
        "UPDATE trigger_runs SET session_id = ?, completed_at = datetime('now') WHERE id = ?",
      ).run(capturedSessionId, runId);
    } catch {
      // Non-fatal
    }
  }

  releaseLock();
  log.log(`Trigger done: ${triggerName} (key=${sessionKey})`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
