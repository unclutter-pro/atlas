/**
 * Trigger input validation, shared by the API (authoritative) and the
 * create/edit form (instant feedback). Rules mirror triggers/manage.ts so a
 * trigger saved here behaves exactly like one created with the CLI.
 * Pure module (no Bun APIs).
 */

import { parseCron } from "../shared/cron";

export const TRIGGER_TYPES = ["cron", "webhook", "manual"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];
export const SESSION_MODES = ["ephemeral", "persistent"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export const NAME_RE = /^[a-z0-9_-]+$/;
const MODEL_KEY_RE = /^[a-zA-Z0-9_.-]+$/;
const CHANNEL_RE = /^[a-z0-9_-]+$/;

/** Body of POST /ui/api/automations/triggers and PUT …/triggers/:name. */
export interface TriggerInput {
  /** Create only; immutable afterwards. */
  name?: string;
  /** Create only; immutable afterwards. */
  type?: TriggerType;
  description?: string;
  channel?: string;
  /** Cron triggers only. */
  schedule?: string | null;
  sessionMode?: SessionMode;
  /** "" or null = default model lookup. */
  modelKey?: string | null;
  prompt?: string;
  /** Webhook triggers only. Update: undefined keeps the secret, "" or null removes it. */
  webhookSecret?: string | null;
  enabled?: boolean;
}

export type FieldErrors = Partial<Record<keyof TriggerInput, string>>;

/**
 * Validate a create (`mode = "create"`) or update body. For updates `type`
 * is the stored trigger type. Returns field → message; empty when valid.
 */
export function validateTriggerInput(input: TriggerInput, mode: "create" | "update", type?: TriggerType): FieldErrors {
  const e: FieldErrors = {};
  const t = mode === "create" ? input.type : type;

  if (mode === "create") {
    const name = input.name ?? "";
    if (!name) e.name = "Name is required";
    else if (!NAME_RE.test(name)) e.name = "Lowercase letters, digits, dashes and underscores only";
    else if (name.length > 64) e.name = "At most 64 characters";
    if (!input.type) e.type = "Type is required";
    else if (!TRIGGER_TYPES.includes(input.type)) e.type = "Type must be cron, webhook or manual";
  }

  if (input.description !== undefined && typeof input.description !== "string") e.description = "Must be text";
  else if ((input.description ?? "").length > 500) e.description = "At most 500 characters";

  if (input.channel !== undefined && (typeof input.channel !== "string" || !CHANNEL_RE.test(input.channel))) {
    e.channel = "Lowercase letters, digits, dashes and underscores only";
  }

  if (input.sessionMode !== undefined && !SESSION_MODES.includes(input.sessionMode)) {
    e.sessionMode = "Session mode must be ephemeral or persistent";
  }

  if (input.modelKey != null && input.modelKey.trim() !== "" && !MODEL_KEY_RE.test(input.modelKey.trim())) {
    e.modelKey = "A config.yml model key (letters, digits, dot, dash, underscore)";
  }

  if (input.prompt !== undefined && typeof input.prompt !== "string") e.prompt = "Must be text";

  if (t === "cron") {
    const needSchedule = mode === "create" || input.schedule !== undefined;
    if (needSchedule) {
      const r = parseCron(input.schedule ?? "");
      if (!r.ok) e.schedule = r.error;
    }
  }

  if (t === "webhook" && input.webhookSecret) {
    if (typeof input.webhookSecret !== "string" || /\s/.test(input.webhookSecret)) e.webhookSecret = "No spaces or line breaks";
    else if (input.webhookSecret.length > 200) e.webhookSecret = "At most 200 characters";
  }

  if (input.enabled !== undefined && typeof input.enabled !== "boolean") e.enabled = "Must be true or false";
  return e;
}
