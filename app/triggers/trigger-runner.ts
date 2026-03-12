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
import type { SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, mkdirSync, readdirSync, statSync } from "fs";
import { createConnection, createServer } from "net";
import type { Server } from "net";
import { join, dirname } from "path";
import yaml from "js-yaml";

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
  // 1. SDK's bundled cli.js (preferred — version-matched)
  const sdkCli = `${APP_DIR}/triggers/node_modules/@anthropic-ai/claude-agent-sdk/cli.js`;
  if (existsSync(sdkCli)) return sdkCli;
  // 2. Native binary installed globally
  const nativeBin = "/usr/local/bin/claude";
  if (existsSync(nativeBin)) return nativeBin;
  // 3. Let the SDK resolve it (works when not compiled)
  return undefined;
}

const CLAUDE_CODE_PATH = resolveClaudeCodePath();

// ---------------------------------------------------------------------------
// Message Channel (AsyncIterable + IPC socket for message injection)
// ---------------------------------------------------------------------------

/** Default idle timeout: 5 minutes of no new messages → session ends */
const IDLE_TIMEOUT_MS = parseInt(process.env.TRIGGER_IDLE_TIMEOUT ?? "300000", 10);

/** Socket message protocol: newline-delimited JSON */
export type SocketMessage = {
  message: string;
  channel: string;
  sessionKey: string;
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
export function createMessageChannel(sessionId: string, idleTimeoutMs = IDLE_TIMEOUT_MS) {
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

  function buildUserMessage(text: string): SDKUserMessage {
    return {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
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

  function push(text: string) {
    const msg = buildUserMessage(text);
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
  return `/tmp/.trigger-${triggerName}-${safeKey}.sock`;
}

/**
 * Start a Unix domain socket server that accepts incoming messages and pushes
 * them into the message channel. Protocol: newline-delimited JSON.
 *
 * Client sends: {"message":"...", "channel":"signal", "sessionKey":"..."}\n
 * Server responds: {"ok":true}\n
 */
export function startSocketServer(
  socketPath: string,
  pushFn: (text: string) => void,
  logger?: { log: (msg: string) => void }
): Server {
  // Clean up stale socket file
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch {}
  }

  const server = createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;

      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

      try {
        const msg = JSON.parse(line) as SocketMessage;
        pushFn(msg.message);
        logger?.log(`Socket: injected message from ${msg.channel}/${msg.sessionKey}`);
        const ack: SocketAck = { ok: true };
        conn.write(JSON.stringify(ack) + "\n");
      } catch (err) {
        const ack: SocketAck = { ok: false, error: String(err) };
        conn.write(JSON.stringify(ack) + "\n");
      }
      conn.end();
    });
    conn.on("error", () => {}); // Ignore client errors
  });

  server.listen(socketPath);
  return server;
}

/**
 * Try to inject a message into a running session via the custom Unix domain socket.
 * Returns true if injection succeeded, false otherwise.
 */
export async function trySocketInject(
  socketPath: string,
  message: string,
  channel: string,
  sessionKey: string
): Promise<boolean> {
  if (!existsSync(socketPath)) return false;

  return new Promise<boolean>((resolve) => {
    const client = createConnection(socketPath, () => {
      const payload: SocketMessage = { message, channel, sessionKey };
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
    try { server.close(); } catch {}
  }
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch {}
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
 */
export function buildSystemPrompt(channel: string, options?: {
  appDir?: string;
  workspace?: string;
}): string {
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

  return systemPrompt;
}

/**
 * Resolve the model from ~/config.yml or APP_DIR/defaults/config.yml.
 * Falls back to "claude-opus-4-6" if not configured.
 *
 * @param configPath - Primary config path to check (pass empty string to skip primary and use defaults only)
 * @param triggerType - Model key to look up (e.g. "trigger", "cron")
 * @param extraCandidates - Additional paths to search (replaces default HOME/APP_DIR fallbacks in tests)
 */
export function resolveModel(
  configPath: string,
  triggerType: string,
  extraCandidates?: string[]
): string {
  const DEFAULT_MODEL = "claude-opus-4-6";

  const candidates = extraCandidates
    ? [configPath, ...extraCandidates]
    : [
        configPath,
        `${HOME}/config.yml`,
        `${APP_DIR}/defaults/config.yml`,
      ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const content = readFileSync(candidate, "utf8");
      const config = yaml.load(content) as Record<string, unknown> | null;
      if (!config || typeof config !== "object") continue;
      const models = config.models as Record<string, string> | undefined;
      if (!models) continue;
      const model = models[triggerType] ?? models["trigger"];
      if (model && typeof model === "string") {
        return model;
      }
    } catch {
      // Malformed YAML, try next
    }
  }

  return DEFAULT_MODEL;
}

/**
 * Returns the MCP servers config object for the query() call.
 * Merges system servers (work, memory) with user servers from:
 *   1. ~/.atlas-mcp/user.json (Atlas-managed user config)
 *   2. ~/.mcp.json (standard Claude MCP config)
 * Only stdio-based servers are included (URL-based cause silent exit issues with --mcp-config).
 */
export function getMcpServers(): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {
    work: {
      command: "bun",
      args: ["run", "/atlas/app/atlas-mcp/index.ts"],
    },
    memory: {
      command: "qmd",
      args: ["mcp"],
    },
  };

  // Load user MCP servers from config files
  const userConfigPaths = [
    `${HOME}/.atlas-mcp/user.json`,
    `${HOME}/.mcp.json`,
  ];

  for (const configPath of userConfigPaths) {
    if (!existsSync(configPath)) continue;
    try {
      const raw = readFileSync(configPath, "utf8");
      const config = JSON.parse(raw) as { mcpServers?: Record<string, Record<string, unknown>> };
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
  vars: Record<string, string>
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
export function readTriggerConfig(db: Database, name: string): TriggerConfig | null {
  const row = db.prepare(
    "SELECT id, name, type, channel, prompt, session_mode, enabled FROM triggers WHERE name = ? LIMIT 1"
  ).get(name) as TriggerConfig | undefined;
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

  const candidates = [
    `${HOME}/config.yml`,
    `${APP_DIR}/defaults/config.yml`,
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = readFileSync(candidate, "utf8");
      const config = yaml.load(raw) as Record<string, unknown> | null;
      const section = config?.usage_reporting as Partial<UsageReportingConfig> | undefined;
      if (section) {
        return {
          enabled: section.enabled ?? defaults.enabled,
          webhook_url: section.webhook_url ?? defaults.webhook_url,
          webhook_secret: section.webhook_secret ?? defaults.webhook_secret,
          include_tokens: section.include_tokens ?? defaults.include_tokens,
        };
      }
    } catch {
      continue;
    }
  }
  return defaults;
}

/**
 * Send session usage data to the configured webhook endpoint.
 * Fire-and-forget — errors are logged but never block the trigger flow.
 */
export async function sendUsageWebhook(
  config: UsageReportingConfig,
  data: MetricsData,
  log: { log: (msg: string) => void }
): Promise<void> {
  if (!config.enabled || !config.webhook_url) return;

  const payload: Record<string, unknown> = {
    event: "session.completed",
    session_id: data.sessionId,
    trigger_name: data.triggerName,
    started_at: data.startedAt,
    ended_at: data.endedAt,
    duration_ms: data.durationMs,
    duration_seconds: Math.round(data.durationMs / 1000),
    num_turns: data.numTurns,
    is_error: data.isError,
    timestamp: new Date().toISOString(),
  };

  if (config.include_tokens) {
    payload.input_tokens = data.inputTokens;
    payload.output_tokens = data.outputTokens;
    payload.cache_read_tokens = data.cacheReadTokens;
    payload.cache_creation_tokens = data.cacheCreationTokens;
    payload.cost_usd = data.costUsd;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.webhook_secret) {
    headers["X-Webhook-Secret"] = config.webhook_secret;
  }

  try {
    const resp = await fetch(config.webhook_url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      log.log(`Usage webhook failed: ${resp.status} ${resp.statusText}`);
    } else {
      log.log(`Usage webhook sent (${data.durationMs}ms session)`);
    }
  } catch (err) {
    log.log(`Usage webhook error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Write session metrics to the session_metrics table.
 */
export function recordMetrics(db: Database, data: MetricsData): void {
  db.prepare(`
    INSERT OR IGNORE INTO session_metrics
      (session_type, session_id, trigger_name, started_at, ended_at,
       duration_ms, input_tokens, output_tokens, cache_read_tokens,
       cache_creation_tokens, cost_usd, num_turns, is_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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
    data.isError ? 1 : 0
  );
}


/**
 * Attempt to inject a message into a running Claude session via IPC socket.
 * Returns true if the injection succeeded, false otherwise.
 */
export async function tryIpcInject(
  sessionId: string,
  message: string
): Promise<boolean> {
  const socketPath = `/tmp/claudec-${sessionId}.sock`;

  if (!existsSync(socketPath)) return false;

  return new Promise((resolve) => {
    const client = createConnection(socketPath, () => {
      const payload =
        JSON.stringify({ action: "send", text: message, submit: true }) + "\n";
      client.write(payload, () => {
        client.end();
        resolve(true);
      });
    });
    client.on("error", () => resolve(false));
    client.setTimeout(5000, () => {
      client.destroy();
      resolve(false);
    });
  });
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
    (data.cachedGrowthBookFeatures as Record<string, unknown>).tengu_claudeai_mcp_connectors = false;
    writeFileSync(CLAUDE_JSON, JSON.stringify(data, null, 2));
  } catch {
    // Non-fatal — proceed anyway
  }
}

/**
 * Find the JSONL file for a session across all project directories.
 */
export function findSessionJsonl(sessionId: string, homeDir?: string): string | null {
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
export function checkCorruptedSession(sessionId: string, homeDir?: string): boolean {
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
export function getSessionIdleSeconds(sessionId: string, homeDir?: string): number {
  const jsonlPath = findSessionJsonl(sessionId, homeDir);
  if (!jsonlPath) return 0;

  try {
    const mtime = statSync(jsonlPath).mtimeMs;
    return (Date.now() - mtime) / 1000;
  } catch {
    return 0;
  }
}

/** Default: 30 minutes of no JSONL activity = stale */
const STALE_SESSION_THRESHOLD_S = parseInt(process.env.STALE_SESSION_THRESHOLD ?? "1800", 10);

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
        try { process.kill(pid, "SIGTERM"); } catch {}
      }
    }
  } catch {
    // lsof not available or failed — try to remove socket directly
  }

  // Clean up socket file
  try { unlinkSync(socketPath); } catch {}
}

/**
 * Run the optional middleware filter script for a trigger.
 * Returns true if the trigger should proceed, false if vetoed by filter.
 */
export async function runMiddlewareFilter(
  triggerName: string,
  payload: string
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
 */
function buildInjectMessage(
  channel: string,
  triggerName: string,
  sessionKey: string,
  payload: string,
  promptFallback: string
): string {
  const candidates = [
    `${PROMPT_DIR}/trigger-${channel}-inject.md`,
    `${PROMPT_DIR}/trigger-inject.md`,
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
 * Does NOT run migrations — that's handled by atlas-mcp on startup.
 * We use a simple open-only approach here.
 */
function openDb(): Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

// ---------------------------------------------------------------------------
// Direct mode (no DB trigger)
// ---------------------------------------------------------------------------

export type RunDirectOptions = {
  channel?: string;
  modelKey?: string;
  env?: Record<string, string>;
  resumeId?: string;
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
  options?: RunDirectOptions
): Promise<void> {
  const channel = options?.channel ?? "internal";
  const modelKey = options?.modelKey ?? "trigger";
  const triggerName = "direct";

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
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
  delete process.env.CLAUDECODE;

  // Apply any extra env vars from options
  if (options?.env) {
    for (const [k, v] of Object.entries(options.env)) {
      process.env[k] = v;
    }
  }

  const triggerTimeout = parseInt(process.env.TRIGGER_TIMEOUT ?? "3600", 10) * 1000;

  log.log(`Direct session starting (channel=${channel}, model=${model})`);

  const startedAt = isoNow();
  let resultMsg: SDKResultMessage | null = null;
  let isError = false;

  const resumeId = options?.resumeId;
  const queryOptions: Parameters<typeof query>[0]["options"] = {
    systemPrompt,
    model,
    mcpServers,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    autoMemoryEnabled: false,
    cwd: HOME,
    ...(resumeId ? { resume: resumeId } : { persistSession: false }),
    ...(CLAUDE_CODE_PATH ? { pathToClaudeCodeExecutable: CLAUDE_CODE_PATH } : {}),
  };

  const q = query({ prompt, options: queryOptions });

  const timeoutHandle = setTimeout(() => {
    q.return(undefined);
  }, triggerTimeout);

  try {
    for await (const msg of q) {
      if (msg.type === "result") {
        resultMsg = msg as SDKResultMessage;
        isError = msg.subtype !== "success";
        break;
      }
    }
  } catch (err) {
    log.log(`ERROR in direct session: ${err}`);
    isError = true;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (resultMsg && "result" in resultMsg) {
    log.log(`Result: ${(resultMsg as { result: string }).result ?? "(no result)"}`);
  }
  log.log(`Direct session done (error=${isError})`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  // --- Pause guard: skip execution if Atlas is paused ---
  if (existsSync(join(HOME, ".atlas-paused"))) {
    console.log(`[${new Date().toISOString()}] Atlas is paused, skipping trigger execution`);
    process.exit(0);
  }

  const args = process.argv.slice(2);

  // --- Direct mode: --direct "<prompt>" [--channel <channel>] [--model-key <key>] [--resume <session-id>] ---
  if (args[0] === "--direct") {
    const prompt = args[1];
    if (!prompt) {
      console.error("Usage: trigger-runner.ts --direct \"<prompt>\" [--channel <channel>] [--model-key <key>] [--resume <session-id>]");
      process.exit(1);
    }

    let channel = "internal";
    let modelKey = process.env.ATLAS_CRON === "1" ? "cron" : "trigger";
    let resumeId: string | undefined;

    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--channel" && args[i + 1]) {
        channel = args[++i];
      } else if (args[i] === "--model-key" && args[i + 1]) {
        modelKey = args[++i];
      } else if (args[i] === "--resume" && args[i + 1]) {
        resumeId = args[++i];
      }
    }

    await runDirect(prompt, { channel, modelKey, resumeId });
    return;
  }

  const [triggerName, payload = "", sessionKeyArg] = args;

  if (!triggerName) {
    console.error("Usage: trigger-runner.ts <trigger-name> [payload] [session-key]");
    console.error("       trigger-runner.ts --direct \"<prompt>\" [--channel <channel>]");
    process.exit(1);
  }

  const log = makeLogger(triggerName);

  // --- Open DB ---
  if (!existsSync(DB_PATH)) {
    console.error(`[${new Date().toISOString()}] ERROR: Database not found: ${DB_PATH}`);
    process.exit(1);
  }
  const db = openDb();

  // --- Read trigger config ---
  const config = readTriggerConfig(db, triggerName);
  if (!config) {
    console.error(`[${new Date().toISOString()}] Trigger not found: ${triggerName}`);
    process.exit(1);
  }

  if (!config.enabled) {
    log.log(`Trigger disabled: ${triggerName}`);
    process.exit(0);
  }

  const channel = config.channel || "internal";
  const sessionMode = config.session_mode || "ephemeral";
  const sessionKey = sessionKeyArg ?? "_default";

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
    "UPDATE triggers SET last_run = datetime('now'), run_count = run_count + 1 WHERE name = ?"
  ).run(triggerName);

  // --- Persistent session: try IPC injection first ---
  let existingSession: string | null = null;
  let staleRecovery = false;

  if (sessionMode === "persistent") {
    const sessionRow = db.prepare(
      "SELECT session_id FROM trigger_sessions WHERE trigger_name = ? AND session_key = ? LIMIT 1"
    ).get(triggerName, sessionKey) as { session_id: string } | undefined;

    existingSession = sessionRow?.session_id ?? null;

    // Guard: corrupted session (killed mid-IPC-inject)
    if (existingSession && checkCorruptedSession(existingSession)) {
      log.log(`Corrupted session ${existingSession} (ended mid-IPC-inject) — clearing, will start fresh`);
      db.prepare(
        "DELETE FROM trigger_sessions WHERE trigger_name = ? AND session_key = ?"
      ).run(triggerName, sessionKey);
      existingSession = null;
    }

    // Try IPC injection if session is running
    if (existingSession) {
      const claudeSocketPath = `/tmp/claudec-${existingSession}.sock`;
      const claudeSocketAlive = existsSync(claudeSocketPath);
      const idleSeconds = getSessionIdleSeconds(existingSession);

      if (claudeSocketAlive && idleSeconds < STALE_SESSION_THRESHOLD_S) {
        // Session is running and active — try Claude's native IPC first
        const injectMsg = buildInjectMessage(channel, triggerName, sessionKey, payload, prompt);
        const injected = await tryIpcInject(existingSession, injectMsg);
        if (injected) {
          log.log(`Injected via Claude IPC into session ${existingSession} (key=${sessionKey})`);
          process.exit(0);
        }
        // Claude IPC failed — try our custom socket
        log.log(`Claude IPC failed for ${existingSession}, trying custom socket`);
        const customSocketPath = getSocketPath(triggerName, sessionKey);
        const socketInjected = await trySocketInject(customSocketPath, injectMsg, channel, sessionKey);
        if (socketInjected) {
          log.log(`Injected via custom socket into session ${existingSession} (key=${sessionKey})`);
          process.exit(0);
        }
        // Both IPC methods failed — fall through to resume
        log.log(`Both IPC methods failed for ${existingSession}, will resume`);
      } else if (claudeSocketAlive) {
        // Session is running but stale — kill it, then resume with notice
        log.log(`Stale session ${existingSession} (idle ${Math.round(idleSeconds)}s) — killing process`);
        killSessionProcess(existingSession);
        staleRecovery = true;
      } else {
        // No Claude socket — try our custom socket (session may still be alive via SDK)
        const customSocketPath = getSocketPath(triggerName, sessionKey);
        const injectMsg = buildInjectMessage(channel, triggerName, sessionKey, payload, prompt);
        const socketInjected = await trySocketInject(customSocketPath, injectMsg, channel, sessionKey);
        if (socketInjected) {
          log.log(`Injected via custom socket (no Claude socket) for ${triggerName} (key=${sessionKey})`);
          process.exit(0);
        }
        // No socket at all — fall through to resume
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
  const flockFile = `/tmp/.trigger-${triggerName}-${safeKey}.flock`;

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
    const injectMsg = buildInjectMessage(channel, triggerName, sessionKey, payload, prompt);
    const socketInjected = await trySocketInject(socketPath, injectMsg, channel, sessionKey);
    if (socketInjected) {
      log.log(`Injected via socket into running session for ${triggerName} (key=${sessionKey})`);
      process.exit(0);
    }
    // Socket not available — cannot inject, exit with warning
    log.log(`WARNING: Lock held but socket unavailable for ${triggerName} (key=${sessionKey}) — message may be lost`);
    process.exit(1);
  }

  // Ensure lock + socket are released on exit
  const triggerSocketPath = getSocketPath(triggerName, sessionKey);
  const releaseLock = () => {
    try { unlinkSync(flockFile); } catch {}
    // Socket cleanup is best-effort (may already be cleaned up by runQuery)
    if (existsSync(triggerSocketPath)) {
      try { unlinkSync(triggerSocketPath); } catch {}
    }
  };
  process.on("exit", releaseLock);
  process.on("SIGTERM", () => { releaseLock(); process.exit(0); });
  process.on("SIGINT", () => { releaseLock(); process.exit(0); });

  // Re-read session from DB after lock (another runner may have created one)
  if (sessionMode === "persistent" && !existingSession) {
    const sessionRow = db.prepare(
      "SELECT session_id FROM trigger_sessions WHERE trigger_name = ? AND session_key = ? LIMIT 1"
    ).get(triggerName, sessionKey) as { session_id: string } | undefined;
    existingSession = sessionRow?.session_id ?? null;
    if (existingSession) {
      log.log(`Session appeared after lock wait: ${existingSession} (key=${sessionKey})`);
    }
  }

  // Re-check IPC socket after acquiring lock
  if (sessionMode === "persistent" && existingSession) {
    const injectMsg = buildInjectMessage(channel, triggerName, sessionKey, payload, prompt);
    // Try Claude IPC first, then custom socket
    const injected = await tryIpcInject(existingSession, injectMsg);
    if (injected) {
      log.log(`Injected into session after lock wait ${existingSession} (key=${sessionKey})`);
      releaseLock();
      process.exit(0);
    }
    const customInjected = await trySocketInject(
      getSocketPath(triggerName, sessionKey), injectMsg, channel, sessionKey
    );
    if (customInjected) {
      log.log(`Injected via custom socket after lock wait for ${triggerName} (key=${sessionKey})`);
      releaseLock();
      process.exit(0);
    }
  }

  log.log(`Trigger firing: ${triggerName} (mode=${sessionMode}, key=${sessionKey}, channel=${channel})`);

  const startedAt = isoNow();

  // --- Track this run ---
  let runId: number | null = null;
  try {
    const runRow = db.prepare(`
      INSERT INTO trigger_runs (trigger_name, session_key, session_mode, payload)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `).get(triggerName, sessionKey, sessionMode, payload) as { id: number } | undefined;
    runId = runRow?.id ?? null;
  } catch {
    // trigger_runs table may not exist in older DBs
  }

  // --- Disable remote MCP ---
  disableRemoteMcp();

  // --- Build system prompt ---
  const systemPrompt = buildSystemPrompt(channel);

  // --- Resolve model ---
  const modelKey = process.env.ATLAS_CRON === "1" ? "cron" : "trigger";
  const model = resolveModel(`${HOME}/config.yml`, modelKey);

  // --- MCP servers ---
  const mcpServers = getMcpServers();

  // --- Set environment variables ---
  process.env.ATLAS_TRIGGER = triggerName;
  process.env.ATLAS_TRIGGER_CHANNEL = channel;
  process.env.ATLAS_TRIGGER_SESSION_KEY = sessionKey;
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
  delete process.env.CLAUDECODE; // avoid nested-session detection

  // --- Run the query ---
  // Persistent sessions can run for hours (long tasks, teams) — no hard timeout.
  // Ephemeral sessions get a timeout to prevent runaway processes.
  const triggerTimeout = sessionMode === "persistent"
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
  const msgChannel = createMessageChannel("pending", sessionMode === "persistent" ? undefined : IDLE_TIMEOUT_MS);
  let socketServer: Server | null = null;

  const runQuery = async (resumeId?: string) => {
    const options: Parameters<typeof query>[0]["options"] = {
      systemPrompt,
      model,
      mcpServers,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      autoMemoryEnabled: false,
      cwd: HOME,
      ...(resumeId ? { resume: resumeId } : {}),
      ...(sessionMode === "ephemeral" ? { persistSession: false } : {}),
      ...(CLAUDE_CODE_PATH ? { pathToClaudeCodeExecutable: CLAUDE_CODE_PATH } : {}),
    };

    // Push the initial prompt as the first message
    msgChannel.push(prompt);

    // Start socket server so other trigger-runner processes can inject messages
    socketServer = startSocketServer(socketPath, (text) => {
      msgChannel.push(text);
    }, log);

    const q = query({ prompt: msgChannel.generator, options });

    const timeoutHandle = triggerTimeout
      ? setTimeout(() => { q.close(); }, triggerTimeout)
      : undefined;

    try {
      for await (const msg of q) {
        if (msg.type === "result") {
          resultMsg = msg as SDKResultMessage;
          capturedSessionId = msg.session_id ?? null;
          isError = msg.subtype !== "success";
          break;
        }
        // Capture session_id from any message that carries it
        if ("session_id" in msg && msg.session_id && !capturedSessionId) {
          capturedSessionId = msg.session_id as string;
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
      } catch (err) {
        // Resume failed — retry as fresh session
        log.log(`Resume failed for session ${existingSession} — retrying as fresh session`);
        db.prepare(
          "DELETE FROM trigger_sessions WHERE trigger_name = ? AND session_key = ?"
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
  if (resultMsg && "result" in resultMsg) {
    log.log(`Result: ${(resultMsg as { result: string }).result ?? "(no result)"}`);
  }

  const endedAt = isoNow();

  // --- Save session for persistent triggers ---
  if (sessionMode === "persistent" && capturedSessionId) {
    db.prepare(`
      INSERT INTO trigger_sessions (trigger_name, session_key, session_id)
      VALUES (?, ?, ?)
      ON CONFLICT(trigger_name, session_key) DO UPDATE SET session_id = ?, updated_at = datetime('now')
    `).run(triggerName, sessionKey, capturedSessionId, capturedSessionId);
    log.log(`Saved session for key=${sessionKey}: ${capturedSessionId}`);
  }

  // --- Record metrics ---
  const usage = (resultMsg as { usage?: Record<string, number> } | null)?.usage ?? {};
  try {
    recordMetrics(db, {
      sessionType: "trigger",
      sessionId: capturedSessionId ?? "",
      triggerName,
      startedAt,
      endedAt,
      durationMs: (resultMsg as { duration_ms?: number } | null)?.duration_ms ?? 0,
      inputTokens: (usage.input_tokens as number | undefined) ?? 0,
      outputTokens: (usage.output_tokens as number | undefined) ?? 0,
      cacheReadTokens: (usage.cache_read_input_tokens as number | undefined) ?? 0,
      cacheCreationTokens: (usage.cache_creation_input_tokens as number | undefined) ?? 0,
      costUsd: (resultMsg as { total_cost_usd?: number } | null)?.total_cost_usd ?? 0,
      numTurns: (resultMsg as { num_turns?: number } | null)?.num_turns ?? 0,
      isError,
    });
  } catch {
    // session_metrics table may not exist in very old DBs
  }

  // --- Send usage reporting webhook ---
  try {
    const usageConfig = readUsageReportingConfig();
    await sendUsageWebhook(usageConfig, {
      sessionType: "trigger",
      sessionId: capturedSessionId ?? "",
      triggerName,
      startedAt,
      endedAt,
      durationMs: (resultMsg as { duration_ms?: number } | null)?.duration_ms ?? 0,
      inputTokens: (usage.input_tokens as number | undefined) ?? 0,
      outputTokens: (usage.output_tokens as number | undefined) ?? 0,
      cacheReadTokens: (usage.cache_read_input_tokens as number | undefined) ?? 0,
      cacheCreationTokens: (usage.cache_creation_input_tokens as number | undefined) ?? 0,
      costUsd: (resultMsg as { total_cost_usd?: number } | null)?.total_cost_usd ?? 0,
      numTurns: (resultMsg as { num_turns?: number } | null)?.num_turns ?? 0,
      isError,
    }, log);
  } catch {
    // Usage reporting should never block trigger completion
  }

  // --- Mark run completed ---
  if (runId !== null && capturedSessionId !== null) {
    try {
      db.prepare(
        "UPDATE trigger_runs SET session_id = ?, completed_at = datetime('now') WHERE id = ?"
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
