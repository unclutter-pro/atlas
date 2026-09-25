/**
 * /ui/api/settings/* — "How is Atlas set up?" (frontend/pages/settings/).
 *
 *   personality    IDENTITY.md + SOUL.md
 *   integrations   configured? running? which config keys enable it
 *   configuration  effective config with the source of every value; raw config.yml editor
 *   secrets        names + mtime only; values are write-only
 *   extensions     user-extensions.sh (runs at container start)
 */

import { existsSync, readFileSync } from "fs";
import yaml from "js-yaml";
import { getConfigSources, getEnvVarName, redactConfig, resolveConfig, type ConfigSource } from "../../lib/config";
import { getDb, home, isTestRun, paths, syncCrontab, toIso } from "./shared/env";
import { badRequest, handler, json, readJson, type ApiRoutes } from "./shared/http";
import { getIntegrationHealth, getServiceHealth, supervisorStatus, type IntegrationHealth, type IntegrationKey, type ServiceHealth } from "./shared/integrations";
import {
  assertVersion,
  contentField,
  deleteSecret,
  displayPath,
  listSecrets,
  readDoc,
  writeAtomic,
  writeSecret,
  type FileDoc,
  type SecretItem,
} from "./settings/files";
import { checkBashSyntax, validateConfigYaml, type ValidationIssue, type ValidationResult } from "./settings/validate";
import { maskSecrets, unmaskSecrets } from "./settings/mask";

export type { ConfigSource, FileDoc, SecretItem, ValidationIssue, ValidationResult };

/** Writes the configured agent backend's settings (hooks, permissions, plugins). */
const CONFIGURE_HARNESS = "/atlas/app/triggers/harness/configure.ts";

// --- Response types ----------------------------------------------------------

export interface PersonalityResponse {
  identity: FileDoc;
  soul: FileDoc;
}

export interface ConfigKeyView {
  key: string;
  /** Redacted, JSON-typed value; null when unset. */
  value: unknown;
  source: ConfigSource;
  /** Value is sensitive and never sent; `value` is "set" or null. */
  secret?: boolean;
}

export interface IntegrationView extends IntegrationHealth {
  /** What turns this integration on. */
  enabledBy: string;
  settings: ConfigKeyView[];
  /** Enabled/disabled trigger(s) handling this channel. */
  triggers: { name: string; enabled: boolean }[];
  lastMessageAt: string | null;
  messages24h: number;
}

export interface IntegrationsResponse {
  integrations: IntegrationView[];
  services: ServiceHealth[];
  supervisorAvailable: boolean;
}

export interface ConfigEntry extends ConfigKeyView {
  section: string;
  /** Set when config.yml has a value that runtime/env overrides. */
  fileValue?: unknown;
  /** Environment variable that overrides this key, if there is one. */
  envVar?: string;
}

export interface ConfigurationResponse {
  file: FileDoc;
  validation: ValidationResult;
  entries: ConfigEntry[];
  runtime: { path: string; exists: boolean; keys: string[]; error: string | null };
  plugins: { id: string; enabled: boolean }[];
}

export interface ConfigSaveResponse {
  ok: true;
  file: FileDoc;
  validation: ValidationResult;
  /** Side effects that ran (both only exist inside the container). */
  applied: { harnessSettings: boolean; crontab: boolean };
}

export interface SecretsResponse {
  dir: string;
  items: SecretItem[];
}

export interface ExtensionsResponse {
  file: FileDoc;
}

export interface ExtensionsSaveResponse {
  ok: true;
  file: FileDoc;
  /** null when bash is unavailable and the syntax check was skipped. */
  issues: ValidationIssue[] | null;
}

// --- Config helpers ----------------------------------------------------------

const REDACTED_KEYS = new Set(["email.password_file", "usage_reporting.webhook_secret"]);

function getPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function loadYaml(file: string): Record<string, unknown> {
  try {
    const v = yaml.load(readFileSync(file, "utf-8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function loadRuntime(): { data: Record<string, unknown>; exists: boolean; error: string | null } {
  const file = paths.runtimeConfig();
  if (!existsSync(file)) return { data: {}, exists: false, error: null };
  try {
    const v = JSON.parse(readFileSync(file, "utf-8"));
    return { data: v && typeof v === "object" ? v : {}, exists: true, error: null };
  } catch (err) {
    return { data: {}, exists: true, error: err instanceof Error ? err.message : String(err) };
  }
}

function redactValue(key: string, v: unknown): unknown {
  if (v == null) return null;
  return REDACTED_KEYS.has(key) && v !== "" ? "***" : v;
}

function flattenLeaves(obj: unknown, prefix = ""): Array<[string, unknown]> {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return [[prefix, obj]];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => flattenLeaves(v, prefix ? `${prefix}.${k}` : k));
}

/** Effective values of every key lib/config knows, with the layer each came from. */
function configEntries(): ConfigEntry[] {
  const resolved = redactConfig(resolveConfig(home()));
  const sources = getConfigSources();
  const file = loadYaml(paths.config());
  const keys = Object.keys(sources);
  if (!keys.includes("workspace.projects_dir")) keys.push("workspace.projects_dir");
  return keys.map((key) => {
    const source = sources[key] ?? "default";
    const entry: ConfigEntry = { key, section: key.split(".")[0]!, value: getPath(resolved, key) ?? null, source, envVar: getEnvVarName(key) };
    if (source === "runtime" || source === "env") {
      const fv = getPath(file, key);
      if (fv !== undefined && fv !== null) entry.fileValue = redactValue(key, fv);
    }
    return entry;
  });
}

function keyView(entries: Map<string, ConfigEntry>, key: string): ConfigKeyView {
  const e = entries.get(key);
  return e ? { key, value: e.value, source: e.source } : { key, value: null, source: "default" };
}

// --- Integrations ------------------------------------------------------------

const INTEGRATION_KEYS: Record<IntegrationKey, string[]> = {
  signal: ["signal.number", "signal.whitelist", "signal.history_turns"],
  email: ["email.imap_host", "email.imap_port", "email.smtp_host", "email.smtp_port", "email.username", "email.folder", "email.whitelist", "email.mark_read"],
  whatsapp: [],
  telegram: [],
  web: ["web_ui.bind", "web_ui.port"],
};

const ENABLED_BY: Record<IntegrationKey, string> = {
  signal: "signal.number in config.yml (daemon via ~/supervisor.d/signal.conf)",
  email: "email.imap_host in config.yml (poller provisioned at container start)",
  whatsapp: "A paired device in ~/.local/share/whatsapp/auth",
  telegram: "telegram.bot_token in config.yml or TELEGRAM_BOT_TOKEN",
  web: "Always on",
};

function channelActivity(channel: string): { lastMessageAt: string | null; messages24h: number; triggers: { name: string; enabled: boolean }[] } {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT MAX(created_at) AS last, SUM(CASE WHEN created_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS recent
       FROM messages WHERE channel = ?`,
    )
    .get(channel) as { last: string | null; recent: number | null } | null;
  const triggers = db.prepare("SELECT name, enabled FROM triggers WHERE channel = ? ORDER BY name").all(channel) as { name: string; enabled: number }[];
  return {
    lastMessageAt: toIso(row?.last),
    messages24h: row?.recent ?? 0,
    triggers: triggers.map((t) => ({ name: t.name, enabled: !!t.enabled })),
  };
}

function integrations(): IntegrationsResponse {
  const health = getIntegrationHealth();
  const entries = new Map(configEntries().map((e) => [e.key, e]));
  const raw = loadYaml(paths.config());

  const views = health.map((h): IntegrationView => {
    const settings = INTEGRATION_KEYS[h.key].map((k) => keyView(entries, k));
    if (h.key === "email") {
      // password_file is a path; show whether the file exists, not where it points.
      const pw = resolveConfig(home()).email.password_file;
      const src = getConfigSources()["email.password_file"] ?? "default";
      settings.push({ key: "email.password_file", value: pw && existsSync(pw) ? "set" : null, source: src, secret: true });
    }
    if (h.key === "telegram") {
      const fromFile = getPath(raw, "telegram.bot_token");
      const set = !!fromFile || !!process.env.TELEGRAM_BOT_TOKEN;
      settings.push({ key: "telegram.bot_token", value: set ? "set" : null, source: fromFile ? "file" : process.env.TELEGRAM_BOT_TOKEN ? "env" : "default", secret: true });
    }
    return { ...h, enabledBy: ENABLED_BY[h.key], settings, ...channelActivity(h.key) };
  });

  return { integrations: views, services: getServiceHealth(), supervisorAvailable: supervisorStatus() !== null };
}

// --- Configuration -----------------------------------------------------------

function configuration(): ConfigurationResponse {
  const file = readDoc(paths.config());
  const runtime = loadRuntime();
  const resolved = resolveConfig(home());
  return {
    file: { ...file, content: maskSecrets(file.content) },
    validation: file.exists ? validateConfigYaml(file.content) : { syntaxError: null, issues: [] },
    entries: configEntries(),
    runtime: {
      path: displayPath(paths.runtimeConfig()),
      exists: runtime.exists,
      keys: flattenLeaves(runtime.data).map(([k]) => k).filter(Boolean),
      error: runtime.error,
    },
    plugins: Object.entries(resolved.plugins.enabled)
      .map(([id, enabled]) => ({ id, enabled: !!enabled }))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.id.localeCompare(b.id)),
  };
}

/** Same side effects as the legacy PATCH /api/v1/config: regenerate the agent backend's settings, then the crontab. */
function applyConfig(): ConfigSaveResponse["applied"] {
  let harnessSettings = false;
  if (!isTestRun() && existsSync(CONFIGURE_HARNESS)) {
    try {
      harnessSettings = Bun.spawnSync(["bun", "run", CONFIGURE_HARNESS], { stdout: "ignore", stderr: "pipe", timeout: 30_000 }).exitCode === 0;
    } catch {}
  }
  const crontab = !isTestRun() && existsSync(paths.syncCrontab);
  syncCrontab();
  return { harnessSettings, crontab };
}

// --- Secrets -----------------------------------------------------------------

function secretUsage(): (name: string) => string[] {
  const refs = flattenLeaves(resolveConfig(home())).filter(([, v]) => typeof v === "string" && v.includes("/secrets/")) as [string, string][];
  return (name) => refs.filter(([, v]) => v.endsWith(`/secrets/${name}`)).map(([k]) => k);
}

// --- Routes ------------------------------------------------------------------

const PERSONALITY_FILES = { identity: paths.identity, soul: paths.soul } as const;

async function saveDoc(req: Request, abs: string): Promise<FileDoc> {
  const body = await readJson(req);
  const content = contentField(body);
  assertVersion(abs, body.version);
  writeAtomic(abs, content);
  return readDoc(abs);
}

export const routes: ApiRoutes = {
  "/ui/api/settings/personality": {
    GET: handler(() => json({ identity: readDoc(paths.identity()), soul: readDoc(paths.soul()) } satisfies PersonalityResponse)),
  },
  "/ui/api/settings/personality/:file": {
    PUT: handler(async (req) => {
      const which = req.params.file as keyof typeof PERSONALITY_FILES;
      if (!Object.hasOwn(PERSONALITY_FILES, which)) badRequest("File must be 'identity' or 'soul'");
      return json(await saveDoc(req, PERSONALITY_FILES[which]()));
    }),
  },

  "/ui/api/settings/integrations": {
    GET: handler(() => json(integrations())),
  },

  "/ui/api/settings/configuration": {
    GET: handler(() => json(configuration())),
    PUT: handler(async (req) => {
      const body = await readJson(req);
      const content = unmaskSecrets(contentField(body), readDoc(paths.config()).content);
      const validation = validateConfigYaml(content);
      if (validation.syntaxError) {
        const at = validation.syntaxError.line ? ` (line ${validation.syntaxError.line})` : "";
        return json({ error: `Invalid YAML${at}: ${validation.syntaxError.message}`, validation }, { status: 400 });
      }
      const errors = validation.issues.filter((i) => i.severity === "error");
      if (errors.length && body.force !== true) {
        return json({ error: `${errors.length} value${errors.length > 1 ? "s have" : " has"} the wrong type`, validation }, { status: 422 });
      }
      assertVersion(paths.config(), body.version);
      writeAtomic(paths.config(), content);
      const saved = readDoc(paths.config());
      return json({ ok: true, file: { ...saved, content: maskSecrets(saved.content) }, validation, applied: applyConfig() } satisfies ConfigSaveResponse);
    }),
  },
  "/ui/api/settings/configuration/validate": {
    POST: handler(async (req) =>
      json(validateConfigYaml(unmaskSecrets(contentField(await readJson(req)), readDoc(paths.config()).content))),
    ),
  },

  "/ui/api/settings/secrets": {
    GET: handler(() => json({ dir: displayPath(paths.secrets()), items: listSecrets(secretUsage()) } satisfies SecretsResponse)),
  },
  "/ui/api/settings/secrets/:name": {
    PUT: handler(async (req) => {
      const body = await readJson(req);
      if (typeof body.value !== "string" || body.value === "") badRequest("Missing 'value' field");
      if (body.value.length > 64 * 1024) badRequest("Secret too large (max 64 KB)");
      const name = req.params.name!;
      const { created } = writeSecret(name, body.value);
      return json({ ok: true, name, created }, { status: created ? 201 : 200 });
    }),
    DELETE: handler(async (req) => {
      await readJson(req);
      deleteSecret(req.params.name!);
      return json({ ok: true, name: req.params.name });
    }),
  },

  "/ui/api/settings/extensions": {
    GET: handler(() => json({ file: readDoc(paths.extensions()) } satisfies ExtensionsResponse)),
    PUT: handler(async (req) => {
      const body = await readJson(req);
      const content = contentField(body);
      const issues = checkBashSyntax(content);
      if (issues?.length && body.force !== true) {
        return json({ error: "Syntax error in script", issues }, { status: 422 });
      }
      assertVersion(paths.extensions(), body.version);
      writeAtomic(paths.extensions(), content);
      return json({ ok: true, file: readDoc(paths.extensions()), issues } satisfies ExtensionsSaveResponse);
    }),
  },
  "/ui/api/settings/extensions/validate": {
    POST: handler(async (req) => json({ issues: checkBashSyntax(contentField(await readJson(req))) })),
  },
};
