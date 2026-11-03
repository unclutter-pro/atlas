import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// js-yaml is already installed with app/lib. Integration scripts have no separate package.
const yaml = createRequire(new URL("../../lib/package.json", import.meta.url).href)("js-yaml") as {
  load(text: string): unknown;
};

export interface TalkConfig {
  url: string;
  username: string;
  appPassword: string;
  passwordFile: string;
  instance: string;
  rooms: string[];
  whitelist: string[];
  mentionAliases: string[];
  workerTrigger: string;
  requestTimeoutMs: number;
  pollTimeoutSeconds: number;
  discoveryIntervalMs: number;
  maxConnections: number;
  backoffMs: number;
  maxBackoffMs: number;
  initialHistoryLimit: number;
}

export interface TalkConfigOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  /** Validate settings without opening the password file or exposing its value. */
  requirePassword?: boolean;
}

function list(value: unknown, key: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
    throw new Error(`talk.${key} must be a list of nonempty strings`);
  }
  return [...new Set(value.map((v: string) => v.trim()))];
}

function readConfig(data: unknown, home: string): unknown {
  if (data === undefined) {
    const path = join(home, "config.yml");
    try {
      data = existsSync(path) ? yaml.load(readFileSync(path, "utf8")) : {};
    } catch {
      throw new Error("Cannot read Talk configuration from config.yml");
    }
  }
  return data;
}

export function isTalkConfigured(data?: unknown, options: TalkConfigOptions = {}): boolean {
  const env = options.env ?? process.env;
  const root = readConfig(data, options.home ?? env.HOME ?? process.env.HOME ?? "/home/agent") as any;
  return Boolean(String(env.TALK_URL ?? root?.talk?.url ?? "").trim()
    && String(env.TALK_USERNAME ?? root?.talk?.username ?? "").trim());
}

/** Loads credentials from an env override or a separate file, never from config.yml. */
export function loadTalkConfig(data?: unknown, options: TalkConfigOptions = {}): TalkConfig {
  return parseTalkConfig(readConfig(data, options.home ?? options.env?.HOME ?? process.env.HOME ?? "/home/agent"), options);
}

export function parseTalkConfig(
  data: unknown,
  options: TalkConfigOptions = {},
): TalkConfig {
  const { env = process.env, requirePassword = true } = options;
  const home = options.home ?? env.HOME ?? process.env.HOME ?? "/home/agent";
  const root = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, any> : {};
  const section = root.talk ?? {};
  if (!section || typeof section !== "object" || Array.isArray(section)) throw new Error("talk must be a configuration object");
  if (section.password || section.app_password) throw new Error("Store the Talk app password in talk.password_file or TALK_APP_PASSWORD, not config.yml");
  const urlText = String(env.TALK_URL ?? section.url ?? "").trim();
  const username = String(env.TALK_USERNAME ?? section.username ?? "").trim();
  if (!urlText || !username) throw new Error("Talk requires talk.url and talk.username");
  if (/[\r\n:]/.test(username)) throw new Error("Invalid Talk username");
  let url: URL;
  try { url = new URL(urlText); } catch { throw new Error("talk.url must be an absolute HTTPS URL"); }
  if (url.username || url.password || url.search || url.hash) throw new Error("talk.url cannot contain credentials, a query or a fragment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && section.allow_insecure_http === true)) {
    throw new Error("Talk requires HTTPS; only set talk.allow_insecure_http for a trusted test network");
  }
  const normalizedUrl = url.href.replace(/\/+$/, "");
  const passwordFile = String(env.TALK_PASSWORD_FILE ?? section.password_file ?? join(home, "secrets", "talk-app-password"));
  let appPassword = requirePassword ? env.TALK_APP_PASSWORD?.trim() ?? "" : "";
  if (requirePassword && !appPassword) {
    try { appPassword = readFileSync(passwordFile, "utf8").trim(); }
    catch { throw new Error("Talk app password missing: use TALK_APP_PASSWORD or talk.password_file"); }
  }
  if (requirePassword && !appPassword) throw new Error("Talk app password is empty");
  const number = (key: string, fallback: number, min: number, max: number) => {
    if (section[key] == null) return fallback;
    const n = Number(section[key]);
    if (!Number.isFinite(n) || n < min || n > max || !Number.isInteger(n)) throw new Error(`talk.${key} must be an integer between ${min} and ${max}`);
    return n;
  };
  const rooms = list(section.rooms, "rooms");
  if (rooms.some((r) => !/^[A-Za-z0-9]{1,64}$/.test(r))) throw new Error("talk.rooms contains an invalid room token");
  const workerTrigger = String(section.worker_trigger ?? "talk-worker");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(workerTrigger)) throw new Error("Invalid talk.worker_trigger");
  const backoffMs = number("backoff_seconds", 2, 1, 60) * 1000;
  const maxBackoffMs = number("max_backoff_seconds", 120, 1, 3600) * 1000;
  if (maxBackoffMs < backoffMs) throw new Error("talk.max_backoff_seconds must be at least talk.backoff_seconds");
  return {
    url: normalizedUrl,
    username,
    appPassword,
    passwordFile,
    instance: createHash("sha256").update(normalizedUrl).update("\0").update(username).digest("hex").slice(0, 24),
    rooms,
    whitelist: list(section.whitelist, "whitelist"),
    mentionAliases: list(section.mention_aliases, "mention_aliases"),
    workerTrigger,
    requestTimeoutMs: number("request_timeout_seconds", 45, 1, 180) * 1000,
    pollTimeoutSeconds: number("poll_timeout_seconds", 25, 1, 60),
    discoveryIntervalMs: number("discovery_interval_seconds", 30, 1, 300) * 1000,
    maxConnections: number("max_connections", 4, 1, 32),
    backoffMs,
    maxBackoffMs,
    initialHistoryLimit: number("initial_history_limit", 100, 1, 200),
  };
}

/** Empty room list means the account's joined conversations, never arbitrary rooms. */
export function roomAllowed(config: Pick<TalkConfig, "rooms">, room: string): boolean {
  return !config.rooms.length || config.rooms.includes(room);
}

/** Whitelist entries are exact local user IDs. Bots, guests and federation stay passive. */
export function actorAllowed(config: Pick<TalkConfig, "whitelist">, actorType: string, actorId: string): boolean {
  return Boolean(actorId) && actorType === "users" && (!config.whitelist.length || config.whitelist.includes(actorId));
}
