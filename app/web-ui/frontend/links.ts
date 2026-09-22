/**
 * Canonical URLs for every object. Always link through these so areas can
 * point at each other without knowing each other's internals.
 * The owning area must serve each of these paths.
 */

import { withQuery, type QueryPatch } from "./router";

const enc = encodeURIComponent;

/**
 * Activity list filters (all optional). `from`/`to` are inclusive UTC days
 * (YYYY-MM-DD), the same days Usage and Overview count in, so numbers match.
 */
export interface ActivityFilter extends QueryPatch {
  trigger?: string;
  /** running | ok | failed */
  status?: "running" | "ok" | "failed";
  /** signal | email | web | whatsapp | telegram | internal … */
  channel?: string;
  /** cron | webhook | manual (trigger type = cause) */
  type?: string;
  from?: string;
  to?: string;
  q?: string;
}

export const links = {
  overview: () => "/",
  /** A web chat by session key; without one, /chat opens the last or newest chat. */
  chat: (sessionKey?: string) => (sessionKey ? `/chat/${enc(sessionKey)}` : "/chat"),

  // Activity (owner: activity area)
  activity: (filter: ActivityFilter = {}) => withQuery("/activity", filter),
  /** One trigger run (trigger_runs.id): cause, session, outcome, transcript. */
  run: (id: number | string) => `/activity/${enc(String(id))}`,
  /** A Claude session by session_id (transcript; links to its runs). */
  session: (sessionId: string) => `/activity/session/${enc(sessionId)}`,
  /** An inbound message (messages.id) and the run it caused. */
  message: (id: number | string) => `/activity/message/${enc(String(id))}`,

  // Automations (owner: automations area)
  automations: () => "/automations",
  trigger: (name: string) => `/automations/${enc(name)}`,
  reminders: () => "/automations?view=reminders",

  // Knowledge (owner: knowledge area)
  knowledge: () => "/knowledge",
  /** Path relative to ~/memory, e.g. "projects/atlas.md". */
  memoryFile: (path: string) => `/knowledge/file/${path.split("/").map(enc).join("/")}`,
  journal: (date?: string) => (date ? `/knowledge/journal/${enc(date)}` : "/knowledge/journal"),
  knowledgeSearch: (q: string) => withQuery("/knowledge", { q }),

  // Usage (owner: usage area)
  /** range = 7d | 30d | 90d; from/to (inclusive UTC days) imply a custom range. */
  usage: (filter: UsageFilter = {}) => withQuery("/usage", filter),

  // Storage (owner: storage area)
  storage: () => "/storage",
  /** Path relative to HOME, e.g. "memory/MEMORY.md". Omit for the root listing. */
  storageBrowse: (path?: string) => (path ? `/storage/browse/${path.split("/").map(enc).join("/")}` : "/storage/browse"),

  // Settings (owner: settings area)
  settings: (section?: SettingsSection) => (section ? `/settings/${section}` : "/settings"),
};

export interface UsageFilter extends QueryPatch {
  range?: string;
  from?: string;
  to?: string;
  trigger?: string;
  type?: string;
}

export type SettingsSection = "personality" | "integrations" | "configuration" | "secrets" | "extensions";
