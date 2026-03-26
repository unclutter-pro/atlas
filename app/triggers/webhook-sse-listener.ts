#!/usr/bin/env bun
/**
 * Webhook SSE Listener Daemon
 *
 * Connects to the smee.io-compatible relay server for each enabled webhook trigger
 * and fires the trigger when events arrive. Supports middleware filter scripts.
 *
 * Usage: bun /atlas/app/triggers/webhook-sse-listener.ts
 *
 * supervisord config:
 *   [program:webhook-listener]
 *   command=/atlas/app/bin/webhook-listener
 *   autostart=true
 *   autorestart=true
 *   stdout_logfile=/atlas/logs/webhook-sse.log
 *   stderr_logfile=/atlas/logs/webhook-sse-error.log
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, appendFileSync } from "fs";
import { openDb } from "../lib/db.ts";
const LOG_PATH = "/atlas/logs/webhook-sse.log";
const TRIGGER_SH = "/atlas/app/triggers/trigger.sh";
const HOME = process.env.HOME ?? "";

// ------- Logging -------

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
}

// ------- Config -------

function readRelayUrl(): string {
  const defaultRelayUrl = "https://webhooks.unclutter.pro";
  const userConfigPath = HOME + "/config.yml";
  const appConfigPath = "/atlas/app/defaults/config.yml";
  for (const configPath of [userConfigPath, appConfigPath]) {
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, "utf8");
        const match = content.match(/^\s*relay_url:\s*["']?([^"'\n]+)["']?/m);
        if (match?.[1]) return match[1].trim();
      } catch {}
    }
  }
  return defaultRelayUrl;
}

// ------- DB -------

interface WebhookTrigger {
  name: string;
  webhook_channel: string;
  enabled: number;
  session_mode: string;
}

function getWebhookTriggers(): WebhookTrigger[] {
  try {
    const db = openDb({ readonly: true });
    const rows = db
      .prepare(
        "SELECT name, webhook_channel, enabled, session_mode FROM triggers WHERE type = 'webhook' AND enabled = 1 AND webhook_channel IS NOT NULL AND webhook_channel != ''"
      )
      .all() as WebhookTrigger[];
    db.close();
    return rows;
  } catch (err) {
    log(`ERROR reading triggers from DB: ${err}`);
    return [];
  }
}

// ------- Middleware filter -------

/**
 * Run the filter script for a trigger if it exists.
 * Pipes the event JSON to stdin.
 * Returns true if the trigger should fire (filter passes or no filter).
 * Returns false if the filter exits non-zero (skip this event).
 */
async function runMiddlewareFilter(
  triggerName: string,
  eventJson: string
): Promise<boolean> {
  const filterPath = `${HOME}/triggers/${triggerName}/filter.sh`;
  if (!existsSync(filterPath)) return true; // No filter — pass

  try {
    const proc = Bun.spawn(["bash", filterPath], {
      stdin: new TextEncoder().encode(eventJson),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      log(`Trigger '${triggerName}': filtered by middleware (exit=${exitCode})`);
      return false;
    }
    return true;
  } catch (err) {
    log(`ERROR running filter for '${triggerName}': ${err} — allowing event`);
    return true; // Fail open: if filter crashes, allow the event
  }
}

// ------- Trigger firing -------

async function fireTrigger(
  triggerName: string,
  payloadJson: string,
  sessionKey: string
): Promise<void> {
  log(`Firing trigger '${triggerName}' (session_key=${sessionKey})`);
  try {
    const proc = Bun.spawn(["bash", TRIGGER_SH, triggerName, payloadJson, sessionKey], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    await proc.exited;
  } catch (err) {
    log(`ERROR firing trigger '${triggerName}': ${err}`);
  }
}

// ------- SSE parsing -------

interface SmeeEvent {
  body: unknown;
  query: Record<string, string>;
  timestamp: number | string;
  // smee.io flattens HTTP headers into top-level keys alongside body/query/timestamp
  [key: string]: unknown;
}

/**
 * Parse SSE stream lines into events.
 * SSE format: "event: webhook\ndata: {...}\n\n"
 * Returns parsed SmeeEvent or null if not a complete/valid event.
 */
function parseSseLine(
  buffer: string
): { remaining: string; event: SmeeEvent | null } {
  const doubleNewline = buffer.indexOf("\n\n");
  if (doubleNewline === -1) {
    return { remaining: buffer, event: null };
  }

  const block = buffer.slice(0, doubleNewline);
  const remaining = buffer.slice(doubleNewline + 2);

  let dataLine: string | null = null;
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) {
      dataLine = line.slice(5).trim();
    }
  }

  if (!dataLine) {
    return { remaining, event: null };
  }

  try {
    const event = JSON.parse(dataLine) as SmeeEvent;
    return { remaining, event };
  } catch {
    return { remaining, event: null };
  }
}

// ------- SSE connection per trigger -------

interface TriggerConnection {
  triggerName: string;
  channelId: string;
  abortController: AbortController;
}

const activeConnections = new Map<string, TriggerConnection>();

async function connectToChannel(
  triggerName: string,
  channelId: string,
  relayUrl: string
): Promise<void> {
  const url = `${relayUrl}/${channelId}`;
  log(`Connecting to SSE channel for trigger '${triggerName}': ${url}`);

  const abortController = new AbortController();
  activeConnections.set(triggerName, { triggerName, channelId, abortController });

  // Inner loop: reconnect on failure
  while (!abortController.signal.aborted) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
        signal: abortController.signal,
      });

      if (!response.ok) {
        log(`SSE connection failed for '${triggerName}' (HTTP ${response.status}) — retrying in 5s`);
        await sleep(5000, abortController.signal);
        continue;
      }

      if (!response.body) {
        log(`SSE no body for '${triggerName}' — retrying in 5s`);
        await sleep(5000, abortController.signal);
        continue;
      }

      log(`SSE connected for trigger '${triggerName}'`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Read SSE stream
      while (!abortController.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          log(`SSE stream ended for '${triggerName}' — reconnecting in 5s`);
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process all complete events in the buffer
        while (true) {
          const { remaining, event } = parseSseLine(buffer);
          buffer = remaining;
          if (!event) break;

          // Handle the event asynchronously (don't block the read loop)
          handleSseEvent(triggerName, event).catch((err) =>
            log(`ERROR handling SSE event for '${triggerName}': ${err}`)
          );
        }
      }

      reader.cancel();
    } catch (err: unknown) {
      if (abortController.signal.aborted) break;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("aborted") || msg.includes("AbortError")) break;
      log(`SSE error for '${triggerName}': ${msg} — reconnecting in 5s`);
    }

    if (!abortController.signal.aborted) {
      await sleep(5000, abortController.signal);
    }
  }

  log(`SSE listener stopped for trigger '${triggerName}'`);
}

async function handleSseEvent(triggerName: string, event: SmeeEvent): Promise<void> {
  log(`SSE event received for trigger '${triggerName}' (timestamp=${event.timestamp})`);

  // smee.io flattens HTTP headers into top-level keys alongside body/query/timestamp.
  // Extract them back into a headers object.
  const reservedKeys = new Set(["body", "query", "timestamp"]);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(event)) {
    if (!reservedKeys.has(key) && typeof value === "string") {
      headers[key.toLowerCase()] = value;
    }
  }

  const payloadJson = JSON.stringify({
    body: event.body,
    headers,
    query: event.query,
    timestamp: event.timestamp,
  });

  // Run middleware filter if present
  const shouldFire = await runMiddlewareFilter(triggerName, payloadJson);
  if (!shouldFire) return;

  // Use _default session key for webhooks (can be customized via filter.sh output in future)
  await fireTrigger(triggerName, payloadJson, "_default");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    });
  });
}

// ------- Connection manager -------

/**
 * Reconcile active connections against current DB state.
 * Starts connections for new triggers, stops connections for removed/disabled ones.
 */
async function reconcileConnections(relayUrl: string): Promise<void> {
  const triggers = getWebhookTriggers();
  const triggerMap = new Map(triggers.map((t) => [t.name, t]));

  // Stop connections for triggers that no longer exist or are disabled
  for (const [name, conn] of activeConnections.entries()) {
    const trigger = triggerMap.get(name);
    if (!trigger || trigger.enabled !== 1) {
      log(`Stopping SSE connection for trigger '${name}' (removed or disabled)`);
      conn.abortController.abort();
      activeConnections.delete(name);
    } else if (trigger.webhook_channel !== conn.channelId) {
      // Channel ID changed — restart connection
      log(`Channel changed for trigger '${name}' — restarting connection`);
      conn.abortController.abort();
      activeConnections.delete(name);
    }
  }

  // Start connections for new triggers
  for (const trigger of triggers) {
    if (!activeConnections.has(trigger.name)) {
      // Start connection in background (not awaited — runs as concurrent loop)
      connectToChannel(trigger.name, trigger.webhook_channel, relayUrl).catch((err) =>
        log(`FATAL error in SSE connection for '${trigger.name}': ${err}`)
      );
    }
  }
}

// ------- Main -------

async function main(): Promise<void> {
  log("Webhook SSE listener starting");

  const relayUrl = readRelayUrl();
  log(`Relay URL: ${relayUrl}`);

  // Initial reconcile
  await reconcileConnections(relayUrl);

  // Periodic reconcile: every 60s check for new/removed/disabled triggers
  const reconcileTimer = setInterval(async () => {
    try {
      await reconcileConnections(relayUrl);
    } catch (err) {
      log(`ERROR during reconcile: ${err}`);
    }
  }, 60_000);

  // Graceful shutdown on SIGTERM / SIGINT
  const shutdown = () => {
    log("Webhook SSE listener shutting down");
    clearInterval(reconcileTimer);
    for (const conn of activeConnections.values()) {
      conn.abortController.abort();
    }
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  log("Webhook SSE listener running");
}

main().catch((err) => {
  log(`FATAL: ${err}`);
  process.exit(1);
});
