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
  subagent_review: string;
  hooks: string;
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
}

export interface FailureHandlingConfig {
  notification_command: string;
  backoff_initial_seconds: number;
  backoff_max_seconds: number;
  notification_threshold_minutes: number;
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

export interface AtlasConfig {
  agent: AgentConfig;
  models: ModelsConfig;
  memory: MemoryConfig;
  signal: SignalConfig;
  email: EmailConfig;
  daily_cleanup: DailyCleanupConfig;
  web_ui: WebUiConfig;
  failure_handling: FailureHandlingConfig;
  stt: SttConfig;
  webhook: WebhookConfig;
  usage_reporting: UsageReportingConfig;
  workspace: WorkspaceConfig;
  plugins: PluginsConfig;
}

export type ConfigSource = "env" | "runtime" | "file" | "default";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: AtlasConfig = {
  agent: { name: "Atlas", email: "" },
  models: { main: "sonnet", trigger: "opus", cron: "sonnet", subagent_review: "sonnet", hooks: "haiku" },
  memory: { load_memory_md: true, load_journal_days: 7 },
  signal: { number: "", history_turns: 20, whitelist: [] },
  email: {
    imap_host: "", imap_port: 993, smtp_host: "", smtp_port: 587,
    username: "", password_file: "/home/agent/secrets/email-password",
    folder: "INBOX", whitelist: [], mark_read: true,
  },
  daily_cleanup: { enabled: true, retention_days: 30, metrics_retention_days: 90 },
  web_ui: { port: 8080, bind: "127.0.0.1" },
  failure_handling: {
    notification_command: "", backoff_initial_seconds: 30,
    backoff_max_seconds: 900, notification_threshold_minutes: 30,
  },
  stt: { enabled: true, url: "http://stt:5092/v1/audio/transcriptions" },
  webhook: { relay_url: "https://webhooks.unclutter.pro" },
  usage_reporting: { enabled: false, webhook_url: "", webhook_secret: "", include_tokens: false },
  workspace: { projects_dir: "" }, // empty = $HOME/projects (resolved at runtime)
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
  { env: "ATLAS_AGENT_NAME", aliases: ["AGENT_NAME"], path: "agent.name", type: "string" },
  { env: "ATLAS_AGENT_EMAIL", path: "agent.email", type: "string" },
  { env: "ATLAS_MODEL_MAIN", path: "models.main", type: "string" },
  { env: "ATLAS_MODEL_TRIGGER", path: "models.trigger", type: "string" },
  { env: "ATLAS_MODEL_CRON", path: "models.cron", type: "string" },
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
  { env: "ATLAS_DAILY_CLEANUP_ENABLED", path: "daily_cleanup.enabled", type: "boolean" },
  { env: "ATLAS_DAILY_CLEANUP_RETENTION_DAYS", path: "daily_cleanup.retention_days", type: "number" },
  { env: "ATLAS_DAILY_CLEANUP_METRICS_RETENTION_DAYS", path: "daily_cleanup.metrics_retention_days", type: "number" },
  { env: "ATLAS_WEB_UI_PORT", path: "web_ui.port", type: "number" },
  { env: "ATLAS_WEB_UI_BIND", path: "web_ui.bind", type: "string" },
  { env: "ATLAS_FAILURE_NOTIFICATION_COMMAND", path: "failure_handling.notification_command", type: "string" },
  { env: "ATLAS_FAILURE_BACKOFF_INITIAL", path: "failure_handling.backoff_initial_seconds", type: "number" },
  { env: "ATLAS_FAILURE_BACKOFF_MAX", path: "failure_handling.backoff_max_seconds", type: "number" },
  { env: "ATLAS_FAILURE_NOTIFICATION_THRESHOLD", path: "failure_handling.notification_threshold_minutes", type: "number" },
  { env: "ATLAS_STT_ENABLED", path: "stt.enabled", type: "boolean" },
  { env: "ATLAS_STT_URL", aliases: ["STT_URL"], path: "stt.url", type: "string" },
  { env: "ATLAS_WEBHOOK_RELAY_URL", path: "webhook.relay_url", type: "string" },
  { env: "ATLAS_USAGE_ENABLED", path: "usage_reporting.enabled", type: "boolean" },
  { env: "ATLAS_USAGE_WEBHOOK_URL", path: "usage_reporting.webhook_url", type: "string" },
  { env: "ATLAS_USAGE_WEBHOOK_SECRET", path: "usage_reporting.webhook_secret", type: "string" },
  { env: "ATLAS_USAGE_INCLUDE_TOKENS", path: "usage_reporting.include_tokens", type: "boolean" },
  { env: "ATLAS_PROJECTS_DIR", path: "workspace.projects_dir", type: "string" },
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

// ---------------------------------------------------------------------------
// Model name utilities
// ---------------------------------------------------------------------------

const MODEL_SHORTHAND: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};

/**
 * Expand a model shorthand (e.g. "opus") to its full API name
 * (e.g. "claude-opus-4-6"). If the value is already a full name or
 * unrecognised, it is returned as-is.
 */
export function expandModelName(shorthand: string): string {
  return MODEL_SHORTHAND[shorthand] ?? shorthand;
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
