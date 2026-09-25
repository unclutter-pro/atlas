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
 * For persistent sessions: if the session is already running (control socket
 * alive), the message is injected directly into the running session. No new
 * process is spawned.
 *
 * Sessions run on the configured harness backend (harness.backend in
 * config.yml, ATLAS_HARNESS_BACKEND). This file sees normalized conversation
 * events and the backend's session store, never backend files or SDK types.
 */

import { createHarnessBackend } from "./harness/registry.ts";
import { createSessionStore } from "../lib/harness/stores.ts";
import type { Conversation, HarnessBackend, SessionRef, TurnResult } from "../lib/harness.ts";
import { Database } from "bun:sqlite";
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
import { createServer } from "net";
import type { Server } from "net";
import { join, dirname } from "path";
import yaml from "js-yaml";
import { resolveConfig } from "../lib/config.ts";
import { applyProcessTimeZone } from "../lib/timezone.ts";
import { openDb as openSharedDb } from "../lib/db.ts";
import {
  getLockPath,
  getRetiringPath,
  getSocketPath,
  isPidAlive,
  readLockPid,
  trySocketInject,
  type SocketAck,
  type SocketControl,
  type SocketMessage,
} from "../lib/trigger-socket.ts";
import { createWebUiNotifier, type ChatNotifyKind, type WebUiNotifier } from "../lib/web-ui-notify.ts";

// Moved to lib/trigger-socket.ts; re-exported for existing importers and tests.
export { getSocketPath, trySocketInject, type SocketAck, type SocketMessage };

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
const WORKSPACE = HOME;

// ---------------------------------------------------------------------------
// Control socket for message injection
// ---------------------------------------------------------------------------

/** A retired session gets this long to finish its running turn and farewell. */
const RETIRE_TIMEOUT_MS = parseInt(process.env.TRIGGER_RETIRE_TIMEOUT ?? "600000", 10);

/** Default idle timeout: 5 minutes of no new messages → session ends */
const IDLE_TIMEOUT_MS = parseInt(
  process.env.TRIGGER_IDLE_TIMEOUT ?? "300000",
  10,
);

/**
 * Start a Unix domain socket server that accepts incoming messages and hands
 * them to the running conversation. Protocol: newline-delimited JSON.
 *
 * Client sends: {"message":"...", "channel":"signal", "sessionKey":"..."}\n
 * Client sends (control): {"message":"", "channel":"signal", "sessionKey":"...", "control":"interrupt"}\n
 * Server responds: {"ok":true}\n
 */
export function startSocketServer(
  socketPath: string,
  pushFn: (text: string) => void,
  controlFn: (control: SocketControl, message: string) => Promise<void> | void,
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
          if (msg.control === "interrupt" || msg.control === "retire") {
            await controlFn(msg.control, msg.message);
            logger?.log(
              `Socket: ${msg.control} control from ${msg.channel}/${msg.sessionKey}`,
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
    /** The harness backend's prompt section (HarnessBackend.promptExtension). */
    harnessPrompt?: string;
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

  // How the shared prompt's concepts (agents, skills, model tiers) are invoked
  // in the configured backend.
  if (options?.harnessPrompt) {
    systemPrompt += `\n---\n\n${options.harnessPrompt}`;
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
export function resolveModel(
  _configPath: string,
  triggerType: string,
  _extraCandidates?: string[],
): string {
  const homeDir = process.env.HOME ?? "/home/agent";
  const config = resolveConfig(homeDir);
  const models = config.models as unknown as Record<string, string>;
  return models[triggerType] ?? models["trigger"] ?? "opus";
}

/**
 * Returns the MCP servers config for the conversation (common `mcpServers` format).
 * Merges user servers from:
 *   1. ~/.atlas-mcp/user.json (Atlas-managed user config)
 *   2. ~/.mcp.json (standard MCP config)
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

  // Narrow explicitly: this tsc build doesn't always narrow `result` past the
  // early-return above, so assert the already-proven-false branch here.
  const failure = result as { ok: false; error: string };

  log.log(`Usage webhook failed: ${failure.error} — queuing for retry`);

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
        failure.error,
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
      // Narrow explicitly: this tsc build doesn't always narrow `result` in
      // this else-branch, so assert the already-proven-false branch here.
      const failure = result as { ok: false; error: string };
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
        ).run(nextAttempt, failure.error, item.id);
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

/**
 * Seconds since the session or one of its nested agents last stored
 * anything (a subagent writes its own history while the parent waits).
 * 0 when the session has no history.
 */
export function getSessionIdleSeconds(
  sessionId: string,
  homeDir?: string,
): number {
  const sessions = createSessionStore({ home: homeDir ?? HOME });
  const ref = sessions.ref(sessionId);
  const lastActivityAt = ref ? sessions.metadata(ref)?.lastActivityAt : null;
  if (!lastActivityAt) return 0;
  return Math.max(0, (Date.now() - Date.parse(lastActivityAt)) / 1000);
}

/** Default: 30 minutes without transcript activity while a runner is alive = stale */
const STALE_SESSION_THRESHOLD_S = parseInt(
  process.env.STALE_SESSION_THRESHOLD ?? "1800",
  10,
);

/** Direct children of a process (the backend's agent CLI under a runner). */
function childPids(pid: number): number[] {
  try {
    const result = Bun.spawnSync(["pgrep", "-P", String(pid)]);
    return result.stdout
      .toString()
      .split("\n")
      .map((line) => parseInt(line, 10))
      .filter((child) => Number.isInteger(child) && child > 0);
  } catch {
    return [];
  }
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {}
}

/**
 * Terminate the runner that holds the (trigger, key) lock, plus its child
 * processes. SIGTERM first so the runner releases its lock and the backend
 * stops its CLI; SIGKILL after the grace period for a runner whose event loop hangs.
 * Returns false when no other live runner holds the lock.
 */
export async function killStaleRunner(
  triggerName: string,
  sessionKey: string,
  graceMs = 10_000,
): Promise<boolean> {
  const pid = readLockPid(getLockPath(triggerName, sessionKey));
  if (!pid || pid === process.pid || !isPidAlive(pid)) return false;

  const children = childPids(pid);
  sendSignal(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (isPidAlive(pid) && Date.now() < deadline) await Bun.sleep(200);
  if (isPidAlive(pid)) sendSignal(pid, "SIGKILL");
  for (const child of children) {
    if (isPidAlive(child)) sendSignal(child, "SIGKILL");
  }
  return true;
}

/** Exit codes of --inject; see the CLI section in main(). */
export async function injectIntoRunner(
  triggerName: string,
  sessionKey: string,
  message: string,
  channel: string,
  control?: "retire",
): Promise<0 | 2 | 3> {
  if (await trySocketInject(getSocketPath(triggerName, sessionKey), message, channel, sessionKey, control)) return 0;
  return isPidAlive(readLockPid(getLockPath(triggerName, sessionKey))) ? 3 : 2;
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

/** Chunk numbering of the message being streamed; a new message restarts at 0. */
export interface StreamChunkState {
  messageId: string | null;
  index: number;
}

/**
 * Persist a streamed text delta to web_chat_stream_chunks so the web-ui can
 * forward it to the client. The message id is the one the stored assistant
 * entry carries (HistoryEntry.messageId), which lets the web-ui replace the
 * draft with the final text.
 *
 * Exported for unit testing; the production caller is the conversation loop
 * of the persistent web-chat session. Returns true when a row was inserted.
 */
export function persistStreamChunk(
  sessionId: string,
  delta: { messageId: string; text: string },
  state: StreamChunkState,
  db: Database = openSharedDb(),
): boolean {
  if (!sessionId || !delta.messageId || !delta.text) return false;
  if (delta.messageId !== state.messageId) {
    state.messageId = delta.messageId;
    state.index = 0;
  }
  db.prepare(
    `INSERT INTO web_chat_stream_chunks (session_id, message_uuid, chunk_index, content_delta)
     VALUES (?, ?, ?, ?)`,
  ).run(sessionId, delta.messageId, state.index++, delta.text);
  return true;
}

/**
 * Drop a session's stream chunks at the start of a turn. The web-ui only
 * needs the running turn's deltas (earlier turns are in the JSONL), so this
 * keeps the table small. AUTOINCREMENT ids stay monotonic, which the web-ui's
 * "id > last seen" cursor relies on.
 */
export function pruneStreamChunks(db: Database, sessionId: string): void {
  db.prepare("DELETE FROM web_chat_stream_chunks WHERE session_id = ?").run(sessionId);
}

// ---------------------------------------------------------------------------
// Web-ui notifications (web channel only)
// ---------------------------------------------------------------------------

/**
 * Swappable dependencies. createNotifier: the runner → web-ui pinger
 * (lib/web-ui-notify.ts); pings are hints and never affect control flow.
 * createBackend: the configured harness backend. Tests swap both.
 */
export const runnerDeps: {
  createNotifier: () => WebUiNotifier;
  createBackend: () => HarnessBackend;
} = {
  createNotifier: () => createWebUiNotifier(),
  createBackend: () => createHarnessBackend(),
};

/**
 * Upsert the (trigger_name, session_key) → session_id mapping.
 *
 * Called both mid-turn (as soon as the session_id is known) and at turn end.
 * The web-ui SSE handler resolves the session_id from this row to read stream
 * chunks; without an early write the whole first turn of a new session streams
 * nothing, because the row would otherwise land only after the turn finishes.
 */
export function upsertTriggerSession(
  db: Database,
  triggerName: string,
  sessionKey: string,
  sessionId: string,
): void {
  db.prepare(
    `INSERT INTO trigger_sessions (trigger_name, session_key, session_id)
     VALUES (?, ?, ?)
     ON CONFLICT(trigger_name, session_key) DO UPDATE SET session_id = ?, updated_at = datetime('now')`,
  ).run(triggerName, sessionKey, sessionId, sessionId);
}

// ---------------------------------------------------------------------------
// Rejected-request session clearing
// ---------------------------------------------------------------------------

/**
 * If the provider rejected the turn's request itself (e.g. an image above the
 * size limits), delete the session row for (triggerName, sessionKey): resuming
 * the same context would fail identically, so the next message starts fresh.
 * Returns the session_id that was cleared, or null if nothing was cleared.
 *
 * Exported for testing; called by main() after each query run.
 */
export function clearRejectedSession(
  db: Database,
  turn: TurnResult | null,
  sessionMode: string,
  triggerName: string,
  sessionKey: string,
  capturedSessionId: string | null,
  existingSession: string | null,
  log: { log: (msg: string) => void },
): string | null {
  if (turn?.error?.code !== "invalid-request") return null;
  if (sessionMode !== "persistent") return null;

  const oldSessionId = capturedSessionId ?? existingSession;
  if (!oldSessionId) return null;

  db.prepare(
    "DELETE FROM trigger_sessions WHERE trigger_name = ? AND session_key = ?",
  ).run(triggerName, sessionKey);
  log.log(
    `Request rejected by the provider — clearing session ${oldSessionId} so next message starts fresh`,
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
 * Run an agent session directly with a prompt, without needing a DB trigger entry.
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
  const backend = runnerDeps.createBackend();

  // --- Build system prompt ---
  const systemPrompt = buildSystemPrompt(channel, { harnessPrompt: backend.promptExtension });

  // --- Resolve model ---
  const model = resolveModel(`${HOME}/config.yml`, modelKey);

  // --- MCP servers ---
  const mcpServers = getMcpServers();

  // --- Set environment variables ---
  process.env.ATLAS_TRIGGER = triggerName;
  process.env.ATLAS_TRIGGER_CHANNEL = channel;

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
  let turn: TurnResult | null = null;
  let capturedSessionId: string | null = null;
  let isError = false;

  const resume = options?.resumeId ? backend.sessions.ref(options.resumeId) : null;
  if (options?.resumeId && !resume) {
    log.log(`ERROR: invalid session id to resume: ${options.resumeId}`);
    return;
  }
  const conversation = backend.openConversation({
    prompt, systemPrompt, model, mcpServers, cwd: HOME, turns: "single",
    ...(resume ? { resume } : { ephemeral: true }),
  });

  const timeoutHandle = setTimeout(() => conversation.stop(), triggerTimeout);

  try {
    for await (const event of conversation) {
      if (event.type === "session") capturedSessionId ??= event.session.nativeId;
      if (event.type === "turn.finished") {
        turn = event.result;
        capturedSessionId = turn.session?.nativeId ?? capturedSessionId;
        isError = turn.outcome === "failed";
        break;
      }
    }
  } catch (err) {
    log.log(`ERROR in direct session: ${err}`);
    isError = true;
  } finally {
    clearTimeout(timeoutHandle);
    conversation.stop();
  }

  if (turn && turn.text !== null) {
    log.log(`Result: ${turn.text}`);
  }

  // When a custom triggerName was provided (e.g. "validator"), record a
  // session_metrics row so dreaming/memory-cleanup filters can exclude this
  // session from later analysis. Default "direct" sessions stay unrecorded
  // to preserve current behavior.
  if (options?.triggerName && capturedSessionId) {
    try {
      // The turn's own usage: ephemeral sessions store no history to aggregate.
      const usage = turn?.usage;

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
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        cacheCreationTokens: usage?.cacheWriteTokens ?? 0,
        costUsd: usage?.cost?.amount ?? 0,
        numTurns: turn?.turns ?? 0,
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
  // Resolve the Atlas time zone once and export it as TZ for this whole
  // process, so journal dates, any `date`-dependent tool the agent runs, and
  // the agent session it spawns (which inherits this env) all agree
  // with the web-ui and supercronic (sync-crontab's CRON_TZ) on "today".
  applyProcessTimeZone(HOME);

  // --- Pause guard: skip execution if Atlas is paused ---
  if (existsSync(join(HOME, ".atlas-paused"))) {
    console.log(
      `[${new Date().toISOString()}] Atlas is paused, skipping trigger execution`,
    );
    process.exit(0);
  }

  const args = process.argv.slice(2);

  // --- Inject mode: --inject <trigger> <session-key> "<message>" [--channel <channel>] [--retire] ---
  // Hands a message to the live runner of (trigger, key) without starting a
  // session. With --retire the runner hands (trigger, key) over at once and
  // runs the message as its session's last turn (the /new farewell).
  // Exit 0: delivered. Exit 2: no runner, the caller may resume the session
  // itself. Exit 3: a runner is alive but unreachable, so resuming would
  // start a second process on the same session.
  if (args[0] === "--inject") {
    const [, trigger, sessionKey, message] = args;
    if (!trigger || !sessionKey || !message) {
      console.error('Usage: trigger-runner.ts --inject <trigger> <session-key> "<message>" [--channel <channel>] [--retire]');
      process.exit(1);
    }
    const channelIdx = args.indexOf("--channel");
    const channel = channelIdx > 0 && args[channelIdx + 1] ? args[channelIdx + 1] : "internal";
    const control = args.includes("--retire") ? "retire" as const : undefined;
    process.exit(await injectIntoRunner(trigger, sessionKey, message, channel, control));
  }

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

  const backend = runnerDeps.createBackend();
  const sessions = backend.sessions;
  const sessionFileExists = (sessionId: string): boolean => {
    const ref = sessions.ref(sessionId);
    return !!ref && sessions.exists(ref);
  };

  if (sessionMode === "persistent") {
    const sessionRow = db
      .prepare(
        "SELECT session_id FROM trigger_sessions WHERE trigger_name = ? AND session_key = ? LIMIT 1",
      )
      .get(triggerName, sessionKey) as { session_id: string } | undefined;

    existingSession = sessionRow?.session_id ?? null;

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

      if (
        idleSeconds >= STALE_SESSION_THRESHOLD_S &&
        (await killStaleRunner(triggerName, sessionKey))
      ) {
        // A live runner without transcript activity hangs — killed it, resume with notice
        log.log(
          `Stale session ${existingSession} (idle ${Math.round(idleSeconds)}s) — killed its runner`,
        );
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
  const flockFile = getLockPath(triggerName, sessionKey);

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
  // After /new retired this runner, the lock and socket paths belong to its
  // successor; only the retiring PID file is ours.
  let handedOver = false;
  const releaseLock = () => {
    if (handedOver) {
      try {
        if (readLockPid(getRetiringPath(triggerName, sessionKey)) === process.pid) {
          unlinkSync(getRetiringPath(triggerName, sessionKey));
        }
      } catch {}
      return;
    }
    try {
      if (readLockPid(flockFile) === process.pid) unlinkSync(flockFile);
    } catch {}
    // Socket cleanup is best-effort (may already be cleaned up by runQuery)
    if (existsSync(triggerSocketPath)) {
      try {
        unlinkSync(triggerSocketPath);
      } catch {}
    }
  };
  /** Give (trigger, key) to the next runner now; this one finishes its farewell. */
  const handOver = () => {
    if (handedOver) return;
    try {
      writeFileSync(getRetiringPath(triggerName, sessionKey), String(process.pid));
    } catch {}
    releaseLock();
    handedOver = true;
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

  // --- Build system prompt ---
  const systemPrompt = buildSystemPrompt(channel, { harnessPrompt: backend.promptExtension });

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

  // --- Run the query ---
  // Persistent sessions can run for hours (long tasks) — no hard timeout.
  // Ephemeral sessions get a timeout to prevent runaway processes.
  const triggerTimeout =
    sessionMode === "persistent"
      ? undefined
      : parseInt(process.env.TRIGGER_TIMEOUT ?? "3600", 10) * 1000;

  let lastTurn: TurnResult | null = null;
  let capturedSessionId: string | null = null;
  let isError = false;

  // If recovering from a stale session, prepend a system notice to the prompt
  // so the session knows it was idle-terminated and should continue.
  if (staleRecovery) {
    prompt = `<system-notice>This session was terminated due to inactivity. The previous session state has been preserved. Please continue where you left off and process the new message below.</system-notice>\n\n${prompt}`;
  }

  // --- Control socket for message injection ---
  const socketPath = getSocketPath(triggerName, sessionKey);
  let socketServer: Server | null = null;
  /** Close the control socket; after a handover its path belongs to the successor. */
  const closeSocket = () => {
    if (handedOver) socketServer?.close();
    else cleanupSocket(socketServer, socketPath);
    socketServer = null;
  };

  // Streaming: emit text deltas for any session whose channel renders them
  // (today: web). Other channels (signal, email) deliver complete messages
  // anyway, so there's no benefit to the extra event volume.
  const wantsStreaming = channel === "web";

  // Live chat: tell the web-ui when a turn starts/ends and when chunks or
  // transcript lines land, so it re-reads instead of polling.
  const notifier = channel === "web" ? runnerDeps.createNotifier() : null;
  const notify = (kind: ChatNotifyKind, extra?: { isError?: boolean; interrupted?: boolean }) => {
    // After a handover the chat's pings belong to the successor's session.
    if (!notifier || handedOver) return;
    try {
      notifier.ping({ trigger: triggerName, sessionKey, sessionId: capturedSessionId ?? existingSession, kind, ...extra });
    } catch {}
  };
  const beginTurn = () => {
    if (!notifier || handedOver) return;
    const sid = capturedSessionId ?? existingSession;
    if (sid) {
      try {
        pruneStreamChunks(db, sid);
      } catch (err) {
        log.log(`stream-chunk prune failed: ${err}`);
      }
    }
    notify("turn_start");
  };

  const runQuery = async (resume?: SessionRef) => {
    // Mid-turn steering queue. Messages that arrive during an active turn
    // are queued here instead of starting a turn. The backend asks for them
    // at every tool boundary (nextToolContext) and adds them to the NEXT
    // model request within the same turn. That gives the "user message
    // between tool calls" UX of an interactive session — without restarting
    // the turn or dropping work.
    //
    // When no turn is active (between turns waiting for next user message),
    // socket injects are pushed to the conversation to start a new turn.
    // After a turn ends, any messages still in the queue (arrived after the
    // last tool boundary) are pushed to start a new turn.
    const injectionQueue: string[] = [];
    let inTurn = false;
    // /new retired this session: the farewell still to run, or running now.
    let pendingFarewell: string | null = null;
    let farewellRunning = false;
    let retireTimeout: ReturnType<typeof setTimeout> | undefined;

    const nextToolContext = () => {
      const pending = injectionQueue.splice(0);
      if (!pending.length) return undefined;
      log.log(`Mid-turn steering: injecting ${pending.length} queued message(s) as additionalContext`);
      return pending
        .map((t) => `[Steering-Nachricht von ${sessionKey} (während aktivem Turn empfangen)]\n${t}`)
        .join("\n\n---\n\n");
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

    // The initial prompt is the first message; flash typing for turn 1
    const conversation: Conversation = backend.openConversation({
      prompt, systemPrompt, model, mcpServers, cwd: HOME,
      turns: "multi", idleTimeoutMs: IDLE_TIMEOUT_MS,
      ...(resume ? { resume } : {}),
      streamText: wantsStreaming, nextToolContext,
    });
    inTurn = true;
    beginTurn();
    sendTypingOnce();

    // Start socket server so other trigger-runner processes can inject messages.
    //
    // Routing:
    //   - inTurn === true (turn in progress) → queue for nextToolContext,
    //     which drains it at every tool boundary into the next model request
    //     of the same turn. No push, so a message can never sit orphaned
    //     next to a running turn until the idle timeout.
    //   - inTurn === false (between turns) → push to the conversation,
    //     triggering the next turn.
    socketServer = startSocketServer(
      socketPath,
      (text) => {
        if (inTurn) {
          // Mid-turn: hand off to nextToolContext via the in-process queue.
          injectionQueue.push(text);
        } else {
          // Between turns: trigger a new turn.
          conversation.push(text);
          inTurn = true;
          beginTurn();
        }
        // Each new injected message gets a typing flash.
        sendTypingOnce();
      },
      async (control, message) => {
        if (control === "retire") {
          if (handedOver) return;
          // Hand (trigger, key) over at once so the next message starts a fresh
          // session, then finish this one: the running turn, then the farewell.
          handOver();
          closeSocket();
          log.log("Retired by /new — handed over; running the farewell as the last turn");
          retireTimeout = setTimeout(() => {
            log.log("Farewell timed out — stopping");
            conversation.stop();
          }, RETIRE_TIMEOUT_MS);
          if (inTurn) pendingFarewell = message;
          else {
            conversation.push(message);
            inTurn = true;
            farewellRunning = true;
          }
          return;
        }
        if (control === "interrupt") {
          try {
            await conversation.interrupt();
            log.log("Received /stop — query interrupted");
            // The backend may not finish the turn after an interrupt; the
            // web-ui treats a second turn_end (from turn.finished) as a no-op.
            notify("turn_end", { interrupted: true });
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
            log.log(`interrupt failed: ${err}`);
          }
        }
      },
      log,
    );

    const timeoutHandle = triggerTimeout
      ? setTimeout(() => conversation.stop(), triggerTimeout)
      : undefined;

    // Chunk numbering for streaming; restarts at 0 for each new message.
    const chunkState: StreamChunkState = { messageId: null, index: 0 };

    try {
      for await (const event of conversation) {
        if (event.type === "turn.finished") {
          // Multi-turn: record the turn but keep going. The conversation
          // takes further input (injected messages start the next turn) and
          // ends when its input idles out or the trigger timeout stops it.
          lastTurn = event.result;
          capturedSessionId = event.result.session?.nativeId ?? null;
          isError = event.result.outcome === "failed";
          inTurn = false;
          notify("turn_end", { isError });
          if (event.result.text) log.log(`Turn result: ${event.result.text}`);

          // Flush any messages that arrived AFTER the last tool boundary
          // (nextToolContext never got a chance to drain them) — push them
          // now to start a new turn so they don't sit orphaned in the queue
          // until idle timeout.
          if (injectionQueue.length > 0) {
            const leftover = injectionQueue.splice(0);
            log.log(
              `End-of-turn flush: ${leftover.length} queued message(s) → new turn`,
            );
            for (const text of leftover) {
              conversation.push(text);
            }
            inTurn = true;
            beginTurn();
          }
          if (handedOver && !inTurn) {
            if (farewellRunning) {
              log.log("Farewell done — exiting");
              conversation.stop();
            } else if (pendingFarewell !== null) {
              conversation.push(pendingFarewell);
              pendingFarewell = null;
              inTurn = true;
              farewellRunning = true;
            }
          }
          continue;
        }
        if (event.type === "session" && !capturedSessionId) {
          capturedSessionId = event.session.nativeId;
          // Persist the mapping now, not at turn end, so the web-ui SSE handler
          // can resolve session_id and stream chunks during this first turn.
          if (sessionMode === "persistent") {
            try {
              upsertTriggerSession(db, triggerName, sessionKey, capturedSessionId);
            } catch (err) {
              log.log(`early session upsert failed: ${err}`);
            }
          }
          // Same for the run row: the web-ui (live transcript, stuck detection)
          // and the kill switch need the session_id while the run is active.
          if (runId !== null) {
            try {
              db.prepare("UPDATE trigger_runs SET session_id = ? WHERE id = ?").run(capturedSessionId, runId);
            } catch (err) {
              log.log(`early run session_id update failed: ${err}`);
            }
          }
          notify("session");
        }
        if (event.type === "message") notify("message");
        // Streaming: persist text deltas so the web-ui SSE handler can
        // forward them to the client in near-real-time. We accept the cost
        // of one INSERT per delta (typically a few characters) because the
        // chunks table is local SQLite and the web channel is low-volume.
        if (event.type === "text.delta" && wantsStreaming && capturedSessionId && !handedOver) {
          try {
            if (persistStreamChunk(capturedSessionId, event, chunkState, db)) notify("chunk");
          } catch (err) {
            // Don't let a failed insert tear down the whole turn.
            log.log(`stream-chunk persist failed: ${err}`);
          }
        }
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (retireTimeout) clearTimeout(retireTimeout);
      conversation.stop();
      closeSocket();
    }
  };

  try {
    if (sessionMode === "persistent" && existingSession) {
      log.log(`Resuming session for key=${sessionKey}: ${existingSession}`);
      try {
        await runQuery(sessions.ref(existingSession) ?? undefined);
        // Check for silent failure: error with 0 turns means resume failed
        if (isError && lastTurn?.turns === 0) {
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
        lastTurn = null;
        capturedSessionId = null;
        isError = false;
        // The retry opens a fresh conversation with its own input.
        closeSocket();
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
    closeSocket();
  }

  // Log result text
  if (lastTurn && lastTurn.text !== null) {
    log.log(`Result: ${lastTurn.text}`);
  }

  const endedAt = isoNow();

  // --- Rejected-request guard: clear broken session before saving ---
  // When the provider rejects the request itself (e.g. payload too large due
  // to inline image content), the session is fine to discard — persisting the
  // failing session_id would make every subsequent message in this thread
  // resume the same broken context and fail identically.
  // A retired runner's (trigger, key) mapping belongs to its successor.
  const cleared = handedOver ? null : clearRejectedSession(
    db, lastTurn, sessionMode, triggerName, sessionKey,
    capturedSessionId, existingSession, log,
  );
  if (cleared !== null) {
    // Don't save the failing session below
    capturedSessionId = null;
  }

  // --- Save session for persistent triggers ---
  if (sessionMode === "persistent" && capturedSessionId && !handedOver) {
    upsertTriggerSession(db, triggerName, sessionKey, capturedSessionId);
    log.log(`Saved session for key=${sessionKey}: ${capturedSessionId}`);
  }

  // --- Record metrics ---
  // Usage of the run window across the session and its nested agents: the
  // result message only covers the parent's own model calls.
  const sessionRef = capturedSessionId ? sessions.ref(capturedSessionId) : null;
  const runUsage = sessionRef ? sessions.usage(sessionRef, { from: startedAt, to: endedAt }) : null;
  const usageTotals = {
    inputTokens: runUsage?.inputTokens ?? 0,
    outputTokens: runUsage?.outputTokens ?? 0,
    cacheReadTokens: runUsage?.cacheReadTokens ?? 0,
    cacheCreationTokens: runUsage?.cacheWriteTokens ?? 0,
    costUsd: runUsage?.cost?.amount ?? 0,
  };
  try {
    recordMetrics(db, {
      sessionType: "trigger",
      sessionId: capturedSessionId ?? "",
      triggerName,
      startedAt,
      endedAt,
      durationMs: lastTurn?.durationMs ?? 0,
      ...usageTotals,
      numTurns: lastTurn?.turns ?? 0,
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
        durationMs: lastTurn?.durationMs ?? 0,
        ...usageTotals,
        numTurns: lastTurn?.turns ?? 0,
        isError,
      },
      log,
      db,
    );
  } catch {
    // Usage reporting should never block trigger completion
  }

  // --- Mark run completed ---
  // Always close the run, even without a session_id — otherwise it would be
  // reported as running forever.
  if (runId !== null) {
    try {
      db.prepare(
        "UPDATE trigger_runs SET session_id = COALESCE(?, session_id), completed_at = datetime('now') WHERE id = ?",
      ).run(capturedSessionId, runId);
    } catch {
      // Non-fatal
    }
  }
  notify("run_end");
  await notifier?.flush(300);

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
