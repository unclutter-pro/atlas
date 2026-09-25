/**
 * Unified Configuration Resolution for Atlas
 *
 * Resolution order (highest priority wins):
 *   1. Environment variables (ATLAS_* prefix)
 *   2. Runtime config overrides ($HOME/.atlas-runtime-config.json)
 *   3. config.yml ($HOME/config.yml)
 *   4. Built-in defaults
 *
 * Backwards-compatible: legacy env vars (AGENT_NAME, SIGNAL_NUMBER, etc.) still work.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentConfig {
  name: string;
  email: string;
}

export interface ModelsConfig {
  main: string;
  trigger: string;
  cron: string;
  /** Nightly memory consolidation (dreaming trigger) — deep cross-session synthesis. */
  dreaming: string;
  subagent_review: string;
  hooks: string;
  /** Extra user-defined keys, addressable via a trigger's `model_key`. */
  [key: string]: string;
}

export interface MemoryConfig {
  load_memory_md: boolean;
  load_journal_days: number;
}

export interface SignalConfig {
  number: string;
  history_turns: number;
  whitelist: string[];
}

export interface EmailConfig {
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  username: string;
  password_file: string;
  folder: string;
  whitelist: string[];
  mark_read: boolean;
}

export interface DailyCleanupConfig {
  enabled: boolean;
  retention_days: number;
  metrics_retention_days: number;
}

export interface WebUiConfig {
  port: number;
  bind: string;
  /**
   * Hostnames the web UI answers to besides localhost and IP literals
   * (DNS-rebinding guard). "*.example.com" matches subdomains, "*" disables the check.
   */
  allowed_hosts: string[];
}

export interface SttConfig {
  enabled: boolean;
  url: string;
}

export interface WebhookConfig {
  relay_url: string;
}

export interface UsageReportingConfig {
  enabled: boolean;
  webhook_url: string;
  webhook_secret: string;
  include_tokens: boolean;
}

export interface PluginsConfig {
  /** Plugin enable/disable overrides. Key: "plugin-id@marketplace-id", value: true/false */
  enabled: Record<string, boolean>;
}

export interface WorkspaceConfig {
  projects_dir: string;
}

export interface HarnessConfig {
  /**
   * Agent backend that runs sessions and owns their storage
   * (docs/harness-interface.md). Registered: "claude-code".
   */
  backend: string;
}

export interface AtlasConfig {
  /**
   * IANA time zone ("Europe/Berlin", "America/New_York") used for day
   * boundaries (web-ui), cron scheduling (supercronic, via sync-crontab's
   * CRON_TZ) and agent sessions (journal dates). Empty ⇒ detect from the
   * container runtime (TZ env, /etc/timezone, /etc/localtime), then UTC.
   * Resolve with resolveTimezone() in lib/timezone.ts, not this field
   * directly — it validates the value and applies the fallback chain.
   */
  timezone: string;
  agent: AgentConfig;
  models: ModelsConfig;
  memory: MemoryConfig;
  signal: SignalConfig;
  email: EmailConfig;
  daily_cleanup: DailyCleanupConfig;
  web_ui: WebUiConfig;
  stt: SttConfig;
  webhook: WebhookConfig;
  usage_reporting: UsageReportingConfig;
  workspace: WorkspaceConfig;
  harness: HarnessConfig;
  plugins: PluginsConfig;
}

export type ConfigSource = "env" | "runtime" | "file" | "default";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: AtlasConfig = {
  timezone: "",
  agent: { name: "Atlas", email: "" },
  models: { main: "sonnet", trigger: "opus", cron: "sonnet", dreaming: "opus", subagent_review: "sonnet", hooks: "haiku" },
  memory: { load_memory_md: true, load_journal_days: 7 },
  signal: { number: "", history_turns: 20, whitelist: [] },
  email: {
    imap_host: "", imap_port: 993, smtp_host: "", smtp_port: 587,
    username: "", password_file: "/home/agent/secrets/email-password",
    folder: "INBOX", whitelist: [], mark_read: true,
  },
  daily_cleanup: { enabled: true, retention_days: 30, metrics_retention_days: 90 },
  web_ui: { port: 8080, bind: "127.0.0.1", allowed_hosts: [] },
  stt: { enabled: true, url: "http://stt:5092/v1/audio/transcriptions" },
  webhook: { relay_url: "https://webhooks.unclutter.pro" },
  usage_reporting: { enabled: false, webhook_url: "", webhook_secret: "", include_tokens: false },
  workspace: { projects_dir: "" }, // empty = $HOME/projects (resolved at runtime)
  harness: { backend: "claude-code" },
  plugins: {
    enabled: {
      // Enabled by default
      "skill-creator@claude-plugins-official": true,
      "code-simplifier@claude-plugins-official": true,
      "security-guidance@claude-plugins-official": true,
      // Disabled by default — not needed for most instances
      "frontend-design@claude-plugins-official": false,
      "feature-dev@claude-plugins-official": false,
      "hookify@claude-plugins-official": false,
      "claude-code-setup@claude-plugins-official": false,
      "plugin-dev@claude-plugins-official": false,
      "mcp-server-dev@claude-plugins-official": false,
      "agent-sdk-dev@claude-plugins-official": false,
      "code-review@claude-plugins-official": false,
      "pr-review-toolkit@claude-plugins-official": false,
      "commit-commands@claude-plugins-official": false,
      "ralph-loop@claude-plugins-official": false,
    },
  },
};

// ---------------------------------------------------------------------------
// ENV variable mapping
// ---------------------------------------------------------------------------

type EnvMapping = {
  env: string;
  aliases?: string[];  // Legacy env var names
  path: string;        // Dot-path in config (e.g. "agent.name")
  type: "string" | "number" | "boolean" | "string[]";
};

const ENV_MAPPINGS: EnvMapping[] = [
  { env: "ATLAS_TIMEZONE", path: "timezone", type: "string" },
  { env: "ATLAS_AGENT_NAME", aliases: ["AGENT_NAME"], path: "agent.name", type: "string" },
  { env: "ATLAS_AGENT_EMAIL", path: "agent.email", type: "string" },
  { env: "ATLAS_MODEL_MAIN", path: "models.main", type: "string" },
  { env: "ATLAS_MODEL_TRIGGER", path: "models.trigger", type: "string" },
  { env: "ATLAS_MODEL_CRON", path: "models.cron", type: "string" },
  { env: "ATLAS_MODEL_DREAMING", path: "models.dreaming", type: "string" },
  { env: "ATLAS_MODEL_SUBAGENT_REVIEW", path: "models.subagent_review", type: "string" },
  { env: "ATLAS_MODEL_HOOKS", path: "models.hooks", type: "string" },
  { env: "ATLAS_MEMORY_LOAD_MEMORY_MD", path: "memory.load_memory_md", type: "boolean" },
  { env: "ATLAS_MEMORY_LOAD_JOURNAL_DAYS", path: "memory.load_journal_days", type: "number" },
  { env: "ATLAS_SIGNAL_NUMBER", aliases: ["SIGNAL_NUMBER"], path: "signal.number", type: "string" },
  { env: "ATLAS_SIGNAL_HISTORY_TURNS", path: "signal.history_turns", type: "number" },
  { env: "ATLAS_SIGNAL_WHITELIST", path: "signal.whitelist", type: "string[]" },
  { env: "ATLAS_EMAIL_IMAP_HOST", aliases: ["EMAIL_IMAP_HOST"], path: "email.imap_host", type: "string" },
  { env: "ATLAS_EMAIL_IMAP_PORT", aliases: ["EMAIL_IMAP_PORT"], path: "email.imap_port", type: "number" },
  { env: "ATLAS_EMAIL_SMTP_HOST", aliases: ["EMAIL_SMTP_HOST"], path: "email.smtp_host", type: "string" },
  { env: "ATLAS_EMAIL_SMTP_PORT", aliases: ["EMAIL_SMTP_PORT"], path: "email.smtp_port", type: "number" },
  { env: "ATLAS_EMAIL_USERNAME", aliases: ["EMAIL_USERNAME"], path: "email.username", type: "string" },
  { env: "ATLAS_EMAIL_PASSWORD_FILE", path: "email.password_file", type: "string" },
  { env: "ATLAS_EMAIL_FOLDER", path: "email.folder", type: "string" },
  { env: "ATLAS_EMAIL_WHITELIST", path: "email.whitelist", type: "string[]" },
  { env: "ATLAS_EMAIL_MARK_READ", path: "email.mark_read", type: "boolean" },
  { env: "ATLAS_EMAIL_IDLE_TIMEOUT", aliases: ["EMAIL_IDLE_TIMEOUT"], path: "email.idle_timeout", type: "number" },
  { env: "ATLAS_DAILY_CLEANUP_ENABLED", path: "daily_cleanup.enabled", type: "boolean" },
  { env: "ATLAS_DAILY_CLEANUP_RETENTION_DAYS", path: "daily_cleanup.retention_days", type: "number" },
  { env: "ATLAS_DAILY_CLEANUP_METRICS_RETENTION_DAYS", path: "daily_cleanup.metrics_retention_days", type: "number" },
  { env: "ATLAS_WEB_UI_PORT", path: "web_ui.port", type: "number" },
  { env: "ATLAS_WEB_UI_BIND", path: "web_ui.bind", type: "string" },
  { env: "ATLAS_WEB_UI_ALLOWED_HOSTS", path: "web_ui.allowed_hosts", type: "string[]" },
  { env: "ATLAS_STT_ENABLED", path: "stt.enabled", type: "boolean" },
  { env: "ATLAS_STT_URL", aliases: ["STT_URL"], path: "stt.url", type: "string" },
  { env: "ATLAS_WEBHOOK_RELAY_URL", path: "webhook.relay_url", type: "string" },
  { env: "ATLAS_USAGE_ENABLED", path: "usage_reporting.enabled", type: "boolean" },
  { env: "ATLAS_USAGE_WEBHOOK_URL", path: "usage_reporting.webhook_url", type: "string" },
  { env: "ATLAS_USAGE_WEBHOOK_SECRET", path: "usage_reporting.webhook_secret", type: "string" },
  { env: "ATLAS_USAGE_INCLUDE_TOKENS", path: "usage_reporting.include_tokens", type: "boolean" },
  { env: "ATLAS_PROJECTS_DIR", path: "workspace.projects_dir", type: "string" },
  { env: "ATLAS_HARNESS_BACKEND", path: "harness.backend", type: "string" },
];

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function getNestedValue(obj: Record<string, any>, path: string): any {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, any>, path: string, value: any): void {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null || typeof current[parts[i]] !== "object") {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

function coerceValue(raw: string, type: EnvMapping["type"]): any {
  switch (type) {
    case "number": return parseInt(raw, 10);
    case "boolean": return raw === "true" || raw === "1";
    case "string[]": return raw.split(",").map((s) => s.trim()).filter(Boolean);
    default: return raw;
  }
}

function readEnvVar(mapping: EnvMapping): string | undefined {
  // Primary env var takes precedence
  if (process.env[mapping.env] !== undefined) return process.env[mapping.env];
  // Check aliases (legacy names)
  if (mapping.aliases) {
    for (const alias of mapping.aliases) {
      if (process.env[alias] !== undefined) return process.env[alias];
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Source tracking
// ---------------------------------------------------------------------------

let lastSources: Map<string, ConfigSource> = new Map();

/**
 * Get the source that provided a specific config value.
 */
export function getConfigSource(path: string): ConfigSource {
  return lastSources.get(path) ?? "default";
}

/**
 * Built-in defaults (a copy), before config.yml, runtime overrides and env.
 * Unlike resolveConfig(), this does not touch the recorded sources.
 */
export function getConfigDefaults(): AtlasConfig {
  return structuredClone(DEFAULTS);
}

/**
 * Environment variable that overrides a config key, e.g. "models.cron" →
 * "ATLAS_MODEL_CRON". Undefined when the key has no env mapping.
 */
export function getEnvVarName(path: string): string | undefined {
  return ENV_MAPPINGS.find((m) => m.path === path)?.env;
}

/**
 * Get all config sources as a plain object (for API responses).
 */
export function getConfigSources(): Record<string, ConfigSource> {
  return Object.fromEntries(lastSources);
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the full Atlas configuration by merging defaults, config.yml,
 * runtime overrides, and environment variables.
 */
export function resolveConfig(home?: string): AtlasConfig {
  const homeDir = home ?? process.env.HOME ?? "/home/agent";
  const configPath = join(homeDir, "config.yml");
  const runtimePath = join(homeDir, ".atlas-runtime-config.json");

  // Start with defaults
  const config = deepClone(DEFAULTS);
  const sources = new Map<string, ConfigSource>();

  // Set all defaults
  for (const mapping of ENV_MAPPINGS) {
    sources.set(mapping.path, "default");
  }

  // Layer 1: config.yml
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = yaml.load(raw) as Record<string, any> | null;
      if (parsed && typeof parsed === "object") {
        for (const mapping of ENV_MAPPINGS) {
          const val = getNestedValue(parsed, mapping.path);
          if (val !== undefined && val !== null) {
            setNestedValue(config, mapping.path, val);
            sources.set(mapping.path, "file");
          }
        }
      }
    } catch {
      // config.yml parse error — proceed with defaults
    }
  }

  // Layer 2: Runtime config overrides
  if (existsSync(runtimePath)) {
    try {
      const raw = readFileSync(runtimePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, any>;
      if (parsed && typeof parsed === "object") {
        for (const mapping of ENV_MAPPINGS) {
          const val = getNestedValue(parsed, mapping.path);
          if (val !== undefined && val !== null) {
            setNestedValue(config, mapping.path, val);
            sources.set(mapping.path, "runtime");
          }
        }
      }
    } catch {
      // Runtime config parse error — skip
    }
  }

  // Layer 3: Environment variables (highest priority)
  for (const mapping of ENV_MAPPINGS) {
    const raw = readEnvVar(mapping);
    if (raw !== undefined) {
      setNestedValue(config, mapping.path, coerceValue(raw, mapping.type));
      sources.set(mapping.path, "env");
    }
  }

  // Resolve workspace.projects_dir default
  if (!config.workspace.projects_dir) {
    config.workspace.projects_dir = join(homeDir, "projects");
  }

  // Custom models.<key> entries are user-defined and therefore not env-mapped,
  // but a trigger's model_key can address any of them. Merge them in so they
  // survive; the env-mapped keys above keep their resolved precedence.
  const envMappedPaths = new Set(ENV_MAPPINGS.map((m) => m.path));
  const mergeCustomModels = (parsed: Record<string, any> | null | undefined, source: ConfigSource) => {
    if (!parsed?.models || typeof parsed.models !== "object") return;
    const models = config.models as unknown as Record<string, string>;
    for (const [key, value] of Object.entries(parsed.models)) {
      if (typeof value !== "string" || envMappedPaths.has(`models.${key}`)) continue;
      models[key] = value;
      sources.set(`models.${key}`, source);
    }
  };

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      mergeCustomModels(yaml.load(raw) as Record<string, any> | null, "file");
    } catch { /* already handled above */ }
  }
  if (existsSync(runtimePath)) {
    try {
      const raw = readFileSync(runtimePath, "utf-8");
      mergeCustomModels(JSON.parse(raw) as Record<string, any>, "runtime");
    } catch { /* already handled above */ }
  }

  // Resolve plugins config (merge from config.yml and runtime, not env-mapped)
  // config.yml plugins.enabled overrides defaults
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = yaml.load(raw) as Record<string, any> | null;
      if (parsed?.plugins?.enabled && typeof parsed.plugins.enabled === "object") {
        config.plugins.enabled = { ...config.plugins.enabled, ...parsed.plugins.enabled };
      }
    } catch { /* already handled above */ }
  }
  // Runtime overrides for plugins
  if (existsSync(runtimePath)) {
    try {
      const raw = readFileSync(runtimePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, any>;
      if (parsed?.plugins?.enabled && typeof parsed.plugins.enabled === "object") {
        config.plugins.enabled = { ...config.plugins.enabled, ...parsed.plugins.enabled };
      }
    } catch { /* already handled above */ }
  }

  lastSources = sources;
  return config as AtlasConfig;
}

/**
 * Redact sensitive values from config for API responses.
 */
export function redactConfig(config: AtlasConfig): Record<string, any> {
  const obj = JSON.parse(JSON.stringify(config));
  // Redact secrets
  if (obj.email?.password_file) obj.email.password_file = "***";
  if (obj.usage_reporting?.webhook_secret) obj.usage_reporting.webhook_secret = "***";
  return obj;
}
