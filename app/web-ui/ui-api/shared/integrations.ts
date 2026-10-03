/**
 * Integration and service health: which messaging integrations are
 * configured, and whether the supervisord programs that run them are up.
 *
 * How each integration runs in the container:
 *   signal   — config `signal.number`; programs signal-daemon + signal-listen
 *              (~/supervisor.d/signal.conf, set up via the triggers skill)
 *   email    — config `email.imap_host`; program email-poller
 *              (~/supervisor.d/email-poller.conf, written by init.sh phase 9b)
 *   whatsapp — paired auth in ~/.local/share/whatsapp/auth; program whatsapp-daemon
 *   telegram — config `telegram.bot_token` / TELEGRAM_BOT_TOKEN; program telegram-daemon
 *   web      — this server; always on
 *
 * `supervisorctl status` is spawned at most once per CACHE_MS. When it is
 * missing (local dev) or the socket is down, states degrade to "unknown".
 * For local development ATLAS_SUPERVISORCTL_STATUS_FILE can point at a file
 * with fake `supervisorctl status` output (the dev seed writes one).
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { resolveConfig } from "../../../lib/config";
import { home, paths } from "./env";

/** running: all programs up · degraded: some up · stopped: none up / not installed ·
 *  unknown: supervisord unreachable · not_configured: integration not set up */
export type HealthState = "running" | "degraded" | "stopped" | "unknown" | "not_configured";

export interface ProgramStatus {
  name: string;
  /** supervisord state (RUNNING, STOPPED, FATAL, BACKOFF, ...), "NOT_INSTALLED", or "UNKNOWN" */
  state: string;
}

export type IntegrationKey = "signal" | "email" | "whatsapp" | "telegram" | "web";

export interface IntegrationHealth {
  key: IntegrationKey;
  label: string;
  configured: boolean;
  /** Where the configuration was found, e.g. "config.yml signal.number". */
  configuredVia: string | null;
  state: HealthState;
  /** One-line human explanation of `state`. */
  detail: string;
  programs: ProgramStatus[];
}

export interface ServiceHealth {
  name: string;
  label: string;
  state: HealthState;
  detail: string;
}

const CACHE_MS = 5_000;
let cache: { at: number; value: Map<string, string> | null } | null = null;
let refreshing = false;

/**
 * Program name → supervisord state, or null when supervisord is unreachable.
 * Stale-while-revalidate: only the very first call runs supervisorctl
 * synchronously; later refreshes run in the background so the status strip
 * polling never blocks the event loop (chat SSE etc.).
 */
export function supervisorStatus(): Map<string, string> | null {
  if (!cache) {
    cache = { at: Date.now(), value: parseSupervisorStatus(readSupervisorOutputSync()) };
  } else if (Date.now() - cache.at >= CACHE_MS && !refreshing) {
    refreshing = true;
    readSupervisorOutput()
      .then((out) => (cache = { at: Date.now(), value: parseSupervisorStatus(out) }))
      .finally(() => (refreshing = false));
  }
  return cache.value;
}

function fakeOutput(): string | null | undefined {
  const fake = process.env.ATLAS_SUPERVISORCTL_STATUS_FILE;
  if (!fake) return undefined;
  try {
    return readFileSync(fake, "utf-8");
  } catch {
    return null;
  }
}

function readSupervisorOutputSync(): string | null {
  const fake = fakeOutput();
  if (fake !== undefined) return fake;
  try {
    const res = Bun.spawnSync(["supervisorctl", "status"], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
    return res.stdout.toString() + res.stderr.toString();
  } catch {
    return null; // not on PATH
  }
}

async function readSupervisorOutput(): Promise<string | null> {
  const fake = fakeOutput();
  if (fake !== undefined) return fake;
  try {
    const proc = Bun.spawn(["supervisorctl", "status"], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    return out + err;
  } catch {
    return null;
  }
}

function parseSupervisorStatus(out: string | null): Map<string, string> | null {
  if (out === null) return null;
  const states = new Map<string, string>();
  for (const line of out.split("\n")) {
    const m = line.match(/^(\S+)\s+(RUNNING|STARTING|BACKOFF|STOPPING|STOPPED|EXITED|FATAL|UNKNOWN)\b/);
    if (m) states.set(m[1]!.replace(/^[^:]+:/, ""), m[2]!);
  }
  // Non-empty output without any program line means an error (socket missing, refused, ...)
  return states.size > 0 || out.trim() === "" ? states : null;
}

/** Programs declared in ~/supervisor.d/*.conf. */
function installedPrograms(): Set<string> {
  const names = new Set<string>();
  const dir = paths.supervisorD();
  if (!existsSync(dir)) return names;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".conf")) continue;
    try {
      for (const m of readFileSync(join(dir, f), "utf-8").matchAll(/^\[program:([^\]]+)\]/gm)) names.add(m[1]!.trim());
    } catch {}
  }
  return names;
}

function rawConfig(): Record<string, any> {
  try {
    return (yaml.load(readFileSync(paths.config(), "utf-8")) as Record<string, any>) ?? {};
  } catch {
    return {};
  }
}

function programHealth(
  programs: string[],
  status: Map<string, string> | null,
  installed: Set<string>,
): { state: HealthState; detail: string; programs: ProgramStatus[] } {
  const list: ProgramStatus[] = programs.map((name) => ({
    name,
    state: status?.get(name) ?? (installed.has(name) ? "UNKNOWN" : "NOT_INSTALLED"),
  }));
  if (!status) {
    return { state: "unknown", detail: "supervisorctl unavailable — process state unknown", programs: list };
  }
  const running = list.filter((p) => p.state === "RUNNING").length;
  if (running === list.length) return { state: "running", detail: "Running", programs: list };
  const down = list.filter((p) => p.state !== "RUNNING").map((p) => `${p.name} ${p.state.toLowerCase().replace("_", " ")}`);
  return { state: running > 0 ? "degraded" : "stopped", detail: down.join(", "), programs: list };
}

export function getIntegrationHealth(): IntegrationHealth[] {
  const config = resolveConfig(home());
  const raw = rawConfig();
  const status = supervisorStatus();
  const installed = installedPrograms();

  const build = (
    key: IntegrationKey,
    label: string,
    configuredVia: string | null,
    programs: string[],
  ): IntegrationHealth => {
    if (!configuredVia) {
      return { key, label, configured: false, configuredVia: null, state: "not_configured", detail: "Not configured", programs: [] };
    }
    return { key, label, configured: true, configuredVia, ...programHealth(programs, status, installed) };
  };

  const whatsappAuth = join(home(), ".local/share/whatsapp/auth/creds.json");
  const telegramToken = raw.telegram?.bot_token || process.env.TELEGRAM_BOT_TOKEN;

  const whatsapp = build(
    "whatsapp",
    "WhatsApp",
    existsSync(whatsappAuth) ? "paired device (~/.local/share/whatsapp)" : installed.has("whatsapp-daemon") ? "supervisor.d" : null,
    ["whatsapp-daemon"],
  );
  if (whatsapp.configured && !existsSync(whatsappAuth) && whatsapp.state === "running") {
    whatsapp.state = "degraded";
    whatsapp.detail = "Daemon running, device not paired yet";
  }

  return [
    build(
      "signal",
      "Signal",
      config.signal.number ? "config signal.number" : installed.has("signal-daemon") ? "supervisor.d" : null,
      ["signal-daemon", "signal-listen"],
    ),
    build("email", "Email", config.email.imap_host ? "config email.imap_host" : null, ["email-poller"]),
    whatsapp,
    build(
      "telegram",
      "Telegram",
      telegramToken ? "config telegram.bot_token" : installed.has("telegram-daemon") ? "supervisor.d" : null,
      ["telegram-daemon"],
    ),
    {
      key: "web",
      label: "Web",
      configured: true,
      configuredVia: "built in",
      state: "running",
      detail: "Web UI and chat are served by this process",
      programs: [],
    },
  ];
}

/** Core services besides integrations. The scheduler matters most: without it no cron trigger or reminder fires. */
export function getServiceHealth(): ServiceHealth[] {
  const status = supervisorStatus();
  const one = (name: string, label: string): ServiceHealth => {
    if (!status) return { name, label, state: "unknown", detail: "supervisorctl unavailable" };
    const s = status.get(name);
    if (s === "RUNNING") return { name, label, state: "running", detail: "Running" };
    return { name, label, state: "stopped", detail: s ? s.toLowerCase() : "not registered" };
  };
  return [one("supercronic", "Scheduler (cron)"), one("metrics", "Metrics exporter")];
}

/** Test hook: drop the cached supervisorctl result. */
export function resetSupervisorCache(): void {
  cache = null;
}
