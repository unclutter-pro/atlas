/**
 * /ui/api/automations/* — triggers and reminders (frontend/pages/automations/).
 *
 *   GET    /ui/api/automations                         trigger list + reminder counts
 *   GET    /ui/api/automations/options                 model keys, channels, time zone
 *   GET    /ui/api/automations/cron?expr=              validate + describe a schedule
 *   POST   /ui/api/automations/triggers                create
 *   GET    /ui/api/automations/triggers/:name          detail (config, prompt, stats)
 *   PUT    /ui/api/automations/triggers/:name          update
 *   DELETE /ui/api/automations/triggers/:name          delete
 *   GET    /ui/api/automations/triggers/:name/runs     run history (?page=&pageSize=)
 *   POST   /ui/api/automations/triggers/:name/toggle   {enabled?} (flips when absent)
 *   POST   /ui/api/automations/triggers/:name/run      {payload?} fire via trigger.sh
 *   POST   /ui/api/automations/triggers/:name/secret   reveal the webhook secret
 *   GET    /ui/api/automations/reminders               ?status=pending|all
 *   POST   /ui/api/automations/reminders/:id/cancel
 *
 * Side effects match triggers/manage.ts and the legacy routes: crontab sync
 * after cron changes, trigger_sessions cleanup on delete, prompt in
 * ~/triggers/<name>/prompt.md when the DB prompt is empty, runs through
 * trigger.sh (refused while paused).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { resolveConfig } from "../../lib/config";
import { isAtlasPaused } from "../../lib/kill-switch";
import { resolveTimezone } from "../../lib/timezone";
import { elapsedMs, fireTrigger, getDb, home, paths, syncCrontab, toIso } from "./shared/env";
import { HttpError, badRequest, handler, intParam, json, notFound, query, readJson, type ApiRoutes } from "./shared/http";
import { describeCron, nextRuns, parseCron } from "./shared/cron";
import { NAME_RE, validateTriggerInput, type SessionMode, type TriggerInput, type TriggerType } from "./automations/validate";
import { RUNS_BASE } from "./shared/runs";

export type { TriggerInput, TriggerType, SessionMode } from "./automations/validate";

/** The single Atlas time zone (lib/timezone.ts's resolveTimezone), used for cron previews and next-run times. */
const atlasTimeZone = () => resolveTimezone(home()).timeZone;

// --- Response types ----------------------------------------------------------

export type RunOutcome = "running" | "ok" | "failed";

export interface RunSummary {
  /** trigger_runs.id — /activity/:id */
  id: number;
  status: RunOutcome;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
  sessionKey: string;
  sessionId: string | null;
  /** First 200 chars of the payload, if any. */
  payloadPreview: string | null;
}

export interface ScheduleInfo {
  expr: string;
  /** Plain English, null when the shape has no good phrasing. */
  text: string | null;
  valid: boolean;
  error: string | null;
}

export interface TriggerSummary {
  name: string;
  type: TriggerType;
  description: string;
  channel: string;
  enabled: boolean;
  sessionMode: SessionMode;
  modelKey: string | null;
  schedule: ScheduleInfo | null;
  /** Next cron fire time (enabled cron triggers only). */
  nextRunAt: string | null;
  /** POST path for webhook triggers. */
  webhookPath: string | null;
  runCount: number;
  lastRunAt: string | null;
  lastRun: RunSummary | null;
  running: number;
  last7d: { runs: number; failures: number; costUsd: number };
}

export interface AutomationsResponse {
  triggers: TriggerSummary[];
  reminders: { pending: number; nextFireAt: string | null };
  paused: boolean;
  timeZone: string;
}

export interface WindowStats {
  runs: number;
  failures: number;
  costUsd: number;
  avgDurationMs: number | null;
  avgCostUsd: number | null;
}

export interface TriggerDetail extends TriggerSummary {
  createdAt: string | null;
  prompt: string;
  /** db = triggers.prompt; file = ~/triggers/<name>/prompt.md; default = runner's fallback text. */
  promptSource: "db" | "file" | "default";
  promptFile: string;
  nextRuns: string[];
  webhook: {
    path: string;
    hasSecret: boolean;
    secretMasked: string | null;
    /** Public relay URL (webhook_channel), when the trigger was created through the CLI relay flow. */
    relayUrl: string | null;
  } | null;
  model: { key: string; effectiveKey: string; model: string; isDefault: boolean; unknownKey: boolean };
  stats: { d7: WindowStats; d30: WindowStats };
  runningRuns: RunSummary[];
  reminders: ReminderItem[];
  paused: boolean;
  timeZone: string;
}

export interface RunsResponse {
  items: RunSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ReminderItem {
  id: number;
  title: string;
  prompt: string;
  status: "pending" | "fired" | "cancelled";
  /** null for event reminders (fire_at 9999-…). */
  fireAt: string | null;
  firedAt: string | null;
  createdAt: string | null;
  channel: string;
  /** time | reply | email_reply | script_check … (null on DBs without the column). */
  triggerType: string | null;
  triggerConfig: string | null;
  triggerName: string | null;
  sessionKey: string | null;
  recurringIntervalSeconds: number | null;
  timeoutAt: string | null;
}

export interface RemindersResponse {
  items: ReminderItem[];
  counts: { pending: number; fired: number; cancelled: number };
}

export interface OptionsResponse {
  /** config.yml models.<key> → model. */
  models: Record<string, string>;
  defaultModelKey: string;
  channels: string[];
  timeZone: string;
}

export interface CronPreviewResponse extends ScheduleInfo {
  next: string[];
  timeZone: string;
}

// --- Helpers -----------------------------------------------------------------

interface TriggerRow {
  id: number;
  name: string;
  type: TriggerType;
  description: string | null;
  channel: string | null;
  schedule: string | null;
  webhook_secret: string | null;
  webhook_channel: string | null;
  prompt: string | null;
  session_mode: SessionMode | null;
  model_key: string | null;
  enabled: number;
  last_run: string | null;
  run_count: number | null;
  created_at: string | null;
}

interface RunRow {
  id: number;
  trigger_name: string;
  session_key: string;
  session_id: string | null;
  payload: string | null;
  started_at: string | null;
  completed_at: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  is_error: number | null;
}

/** trigger-runner falls back to this key when triggers.model_key is NULL (ATLAS_CRON is unset for trigger runs). */
const DEFAULT_MODEL_KEY = "trigger";
const CHANNELS = ["internal", "signal", "email", "web", "whatsapp", "telegram"];

// Run + matched metrics row, same matching as Activity (shared/runs.ts).
const RUN_SELECT = `SELECT r.* FROM (${RUNS_BASE}) r`;

function toRun(r: RunRow): RunSummary {
  const status: RunOutcome = !r.completed_at ? "running" : r.is_error ? "failed" : "ok";
  const payload = r.payload?.trim() || null;
  return {
    id: r.id,
    status,
    startedAt: toIso(r.started_at),
    completedAt: toIso(r.completed_at),
    durationMs: status === "running" ? elapsedMs(r.started_at) : (r.duration_ms ?? elapsedMs(r.started_at, r.completed_at)),
    costUsd: r.cost_usd,
    sessionKey: r.session_key,
    sessionId: r.session_id,
    payloadPreview: payload ? payload.slice(0, 200) : null,
  };
}

function scheduleInfo(expr: string | null): ScheduleInfo | null {
  if (!expr) return null;
  const p = parseCron(expr);
  return p.ok
    ? { expr, text: describeCron(p.spec), valid: true, error: null }
    : { expr, text: null, valid: false, error: p.error };
}

function nextCronRuns(t: Pick<TriggerRow, "type" | "enabled" | "schedule">, count: number): string[] {
  if (t.type !== "cron" || !t.enabled || !t.schedule) return [];
  const p = parseCron(t.schedule);
  return p.ok ? nextRuns(p.spec, count, new Date(), atlasTimeZone()).map((d) => d.toISOString()) : [];
}

function loadTrigger(name: string): TriggerRow | null {
  return (getDb().query("SELECT * FROM triggers WHERE name = ?").get(name) as TriggerRow | null) ?? null;
}

function requireTrigger(name: string | undefined): TriggerRow {
  if (!name || !NAME_RE.test(name)) notFound("No such trigger");
  return loadTrigger(name) ?? notFound(`No trigger named "${name}"`);
}

const sinceIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

function promptFilePath(name: string): string {
  return join(paths.triggers(), name, "prompt.md");
}

function readPrompt(t: TriggerRow): { prompt: string; source: "db" | "file" | "default" } {
  if (t.prompt) return { prompt: t.prompt, source: "db" };
  const file = promptFilePath(t.name);
  if (existsSync(file)) {
    try {
      return { prompt: readFileSync(file, "utf8"), source: "file" };
    } catch {}
  }
  return { prompt: `Trigger '${t.name}' was fired.`, source: "default" };
}

function writePromptFile(name: string, prompt: string): void {
  const file = promptFilePath(name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, prompt, "utf8");
}

function maskSecret(s: string): string {
  return s.length <= 4 ? "••••" : `${"•".repeat(Math.min(12, s.length - 2))}${s.slice(-2)}`;
}

function modelInfo(modelKey: string | null): TriggerDetail["model"] {
  const models = resolveConfig(home()).models as unknown as Record<string, string>;
  const key = modelKey?.trim() || DEFAULT_MODEL_KEY;
  // Same lookup as trigger-runner's resolveModel().
  const known = key in models;
  return {
    key,
    effectiveKey: known ? key : DEFAULT_MODEL_KEY,
    model: models[key] ?? models[DEFAULT_MODEL_KEY] ?? "opus",
    isDefault: !modelKey?.trim(),
    unknownKey: !known,
  };
}

function relayUrl(webhookChannel: string | null): string | null {
  if (!webhookChannel) return null;
  const base = resolveConfig(home()).webhook?.relay_url;
  return base ? `${base.replace(/\/+$/, "")}/${webhookChannel}` : null;
}

/** Same format as triggers/manage.ts: "<name>-<12 hex>". */
function generateWebhookChannelId(name: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `${name}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function windowStats(name: string, days: number): WindowStats {
  const db = getDb();
  const since = sinceIso(days);
  const runs = db
    .query("SELECT COUNT(*) AS n FROM trigger_runs WHERE trigger_name = ? AND julianday(started_at) >= julianday(?)")
    .get(name, since) as { n: number };
  const m = db
    .query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(is_error), 0) AS failures, COALESCE(SUM(cost_usd), 0) AS cost,
              AVG(duration_ms) AS avg_ms
       FROM session_metrics WHERE session_type = 'trigger' AND trigger_name = ? AND julianday(started_at) >= julianday(?)`,
    )
    .get(name, since) as { n: number; failures: number; cost: number; avg_ms: number | null };
  return {
    runs: runs.n,
    failures: m.failures,
    costUsd: m.cost,
    avgDurationMs: m.avg_ms == null ? null : Math.round(m.avg_ms),
    avgCostUsd: m.n ? m.cost / m.n : null,
  };
}

function summarize(t: TriggerRow, last: RunSummary | null, running: number, last7d: TriggerSummary["last7d"]): TriggerSummary {
  return {
    name: t.name,
    type: t.type,
    description: t.description ?? "",
    channel: t.channel || "internal",
    enabled: !!t.enabled,
    sessionMode: t.session_mode || "ephemeral",
    modelKey: t.model_key,
    schedule: t.type === "cron" ? scheduleInfo(t.schedule) : null,
    nextRunAt: nextCronRuns(t, 1)[0] ?? null,
    webhookPath: t.type === "webhook" ? `/api/webhook/${t.name}` : null,
    runCount: t.run_count ?? 0,
    lastRunAt: last?.startedAt ?? toIso(t.last_run),
    lastRun: last,
    running,
    last7d,
  };
}

// --- Reminders ---------------------------------------------------------------

function reminderColumns(): Set<string> {
  const rows = getDb().query("PRAGMA table_info(reminders)").all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function toReminder(r: Record<string, unknown>): ReminderItem {
  const fireAt = r.fire_at as string;
  const str = (k: string) => (r[k] == null ? null : String(r[k]));
  return {
    id: r.id as number,
    title: String(r.title ?? ""),
    prompt: String(r.prompt ?? ""),
    status: r.status as ReminderItem["status"],
    fireAt: fireAt?.startsWith("9999-") ? null : toIso(fireAt),
    firedAt: toIso(str("fired_at")),
    createdAt: toIso(str("created_at")),
    channel: String(r.channel ?? "internal"),
    triggerType: str("trigger_type"),
    triggerConfig: str("trigger_config"),
    triggerName: str("trigger_name"),
    sessionKey: str("session_key"),
    recurringIntervalSeconds: r.recurring_interval_seconds == null ? null : Number(r.recurring_interval_seconds),
    timeoutAt: toIso(str("timeout_at")),
  };
}

function listReminders(opts: { status: "pending" | "all"; triggerName?: string; limit?: number }): ReminderItem[] {
  const cols = reminderColumns();
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status === "pending") where.push("status = 'pending'");
  if (opts.triggerName) {
    if (!cols.has("trigger_name")) return [];
    where.push("trigger_name = ?");
    params.push(opts.triggerName);
  }
  // Pending first (soonest first, event reminders last), then history newest first.
  const sql = `SELECT * FROM reminders ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,
             CASE WHEN status = 'pending' THEN fire_at END ASC,
             COALESCE(fired_at, fire_at) DESC, id DESC
    LIMIT ?`;
  params.push(opts.limit ?? 200);
  return (getDb().query(sql).all(...params) as Record<string, unknown>[]).map(toReminder);
}

// --- Handlers ----------------------------------------------------------------

function listAutomations(): AutomationsResponse {
  const db = getDb();
  const triggers = db.query("SELECT * FROM triggers ORDER BY type, name").all() as TriggerRow[];
  const lastRuns = db
    .query(`${RUN_SELECT} WHERE r.id IN (SELECT MAX(id) FROM trigger_runs GROUP BY trigger_name)`)
    .all() as RunRow[];
  const lastByName = new Map(lastRuns.map((r) => [r.trigger_name, toRun(r)]));
  const running = new Map(
    (db.query("SELECT trigger_name, COUNT(*) AS n FROM trigger_runs WHERE completed_at IS NULL GROUP BY trigger_name").all() as Array<{ trigger_name: string; n: number }>).map((r) => [r.trigger_name, r.n]),
  );
  const since = sinceIso(7);
  const runs7 = new Map(
    (db.query("SELECT trigger_name, COUNT(*) AS n FROM trigger_runs WHERE julianday(started_at) >= julianday(?) GROUP BY trigger_name").all(since) as Array<{ trigger_name: string; n: number }>).map((r) => [r.trigger_name, r.n]),
  );
  const metrics7 = new Map(
    (
      db
        .query(
          `SELECT trigger_name, COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(is_error), 0) AS failures
           FROM session_metrics WHERE session_type = 'trigger' AND julianday(started_at) >= julianday(?) GROUP BY trigger_name`,
        )
        .all(since) as Array<{ trigger_name: string; cost: number; failures: number }>
    ).map((r) => [r.trigger_name, r]),
  );
  const pending = db
    .query(`SELECT COUNT(*) AS n, MIN(CASE WHEN fire_at < '9999' THEN fire_at END) AS next FROM reminders WHERE status = 'pending'`)
    .get() as { n: number; next: string | null };

  return {
    triggers: triggers.map((t) =>
      summarize(t, lastByName.get(t.name) ?? null, running.get(t.name) ?? 0, {
        runs: runs7.get(t.name) ?? 0,
        failures: metrics7.get(t.name)?.failures ?? 0,
        costUsd: metrics7.get(t.name)?.cost ?? 0,
      }),
    ),
    reminders: { pending: pending.n, nextFireAt: toIso(pending.next) },
    paused: isAtlasPaused(home()),
    timeZone: atlasTimeZone(),
  };
}

function triggerDetail(t: TriggerRow): TriggerDetail {
  const db = getDb();
  const runningRuns = (db.query(`${RUN_SELECT} WHERE r.trigger_name = ? AND r.completed_at IS NULL ORDER BY r.id DESC`).all(t.name) as RunRow[]).map(toRun);
  const lastRow = db.query(`${RUN_SELECT} WHERE r.trigger_name = ? ORDER BY r.id DESC LIMIT 1`).get(t.name) as RunRow | null;
  const d7 = windowStats(t.name, 7);
  const d30 = windowStats(t.name, 30);
  const { prompt, source } = readPrompt(t);
  return {
    ...summarize(t, lastRow ? toRun(lastRow) : null, runningRuns.length, { runs: d7.runs, failures: d7.failures, costUsd: d7.costUsd }),
    createdAt: toIso(t.created_at),
    prompt,
    promptSource: source,
    promptFile: `~/triggers/${t.name}/prompt.md`,
    nextRuns: nextCronRuns(t, 5),
    webhook:
      t.type === "webhook"
        ? {
            path: `/api/webhook/${t.name}`,
            hasSecret: !!t.webhook_secret,
            secretMasked: t.webhook_secret ? maskSecret(t.webhook_secret) : null,
            relayUrl: relayUrl(t.webhook_channel),
          }
        : null,
    model: modelInfo(t.model_key),
    stats: { d7, d30 },
    runningRuns,
    reminders: listReminders({ status: "all", triggerName: t.name, limit: 20 }),
    paused: isAtlasPaused(home()),
    timeZone: atlasTimeZone(),
  };
}

function fieldError(errors: Record<string, string | undefined>): never {
  const [field, msg] = Object.entries(errors).find(([, m]) => m)!;
  throw new HttpError(400, `${field}: ${msg}`);
}

function createTrigger(input: TriggerInput): TriggerRow {
  const errors = validateTriggerInput(input, "create");
  if (Object.keys(errors).length) fieldError(errors);
  const name = input.name!;
  const type = input.type!;
  if (loadTrigger(name)) throw new HttpError(409, `A trigger named "${name}" already exists`);

  const secret = type === "webhook" ? input.webhookSecret?.trim() || null : null;
  getDb()
    .query(
      `INSERT INTO triggers (name, type, description, channel, schedule, webhook_secret, webhook_channel, prompt, session_mode, model_key, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
    )
    .run(
      name,
      type,
      input.description?.trim() ?? "",
      input.channel || "internal",
      type === "cron" ? input.schedule!.trim().replace(/\s+/g, " ") : null,
      secret,
      type === "webhook" ? generateWebhookChannelId(name) : null,
      input.sessionMode ?? "ephemeral",
      input.modelKey?.trim() || null,
      input.enabled === false ? 0 : 1,
    );
  // Like the CLI: the prompt lives in ~/triggers/<name>/prompt.md, the DB prompt stays empty.
  mkdirSync(join(paths.triggers(), name), { recursive: true });
  if (input.prompt?.trim()) writePromptFile(name, input.prompt);
  if (type === "cron") syncCrontab();
  return loadTrigger(name)!;
}

function updateTrigger(t: TriggerRow, input: TriggerInput): TriggerRow {
  if (input.name !== undefined && input.name !== t.name) badRequest("name: Triggers cannot be renamed");
  if (input.type !== undefined && input.type !== t.type) badRequest("type: The trigger type cannot be changed");
  const errors = validateTriggerInput(input, "update", t.type);
  if (Object.keys(errors).length) fieldError(errors);

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => {
    sets.push(`${col} = ?`);
    params.push(v);
  };
  if (input.description !== undefined) set("description", input.description.trim());
  if (input.channel !== undefined) set("channel", input.channel || "internal");
  if (input.sessionMode !== undefined) set("session_mode", input.sessionMode);
  if (input.modelKey !== undefined) set("model_key", input.modelKey?.trim() || null);
  if (input.enabled !== undefined) set("enabled", input.enabled ? 1 : 0);
  if (t.type === "cron" && input.schedule !== undefined) set("schedule", input.schedule!.trim().replace(/\s+/g, " "));
  if (t.type === "webhook" && input.webhookSecret !== undefined) set("webhook_secret", input.webhookSecret?.trim() || null);
  if (input.prompt !== undefined) {
    // Keep the prompt where it lives: a non-empty DB prompt wins over prompt.md at run time.
    if (t.prompt) set("prompt", input.prompt);
    else writePromptFile(t.name, input.prompt);
  }

  if (sets.length) getDb().query(`UPDATE triggers SET ${sets.join(", ")} WHERE id = ?`).run(...params, t.id);
  if (t.type === "cron") syncCrontab();
  return loadTrigger(t.name)!;
}

export const routes: ApiRoutes = {
  "/ui/api/automations": {
    GET: handler(() => json(listAutomations() satisfies AutomationsResponse)),
  },

  "/ui/api/automations/options": {
    GET: handler(() => {
      const models = { ...(resolveConfig(home()).models as unknown as Record<string, string>) };
      return json({ models, defaultModelKey: DEFAULT_MODEL_KEY, channels: CHANNELS, timeZone: atlasTimeZone() } satisfies OptionsResponse);
    }),
  },

  "/ui/api/automations/cron": {
    GET: handler((req) => {
      const expr = query(req).get("expr") ?? "";
      const p = parseCron(expr);
      const tz = atlasTimeZone();
      const body: CronPreviewResponse = p.ok
        ? { expr, text: describeCron(p.spec), valid: true, error: null, next: nextRuns(p.spec, 5, new Date(), tz).map((d) => d.toISOString()), timeZone: tz }
        : { expr, text: null, valid: false, error: p.error, next: [], timeZone: tz };
      return json(body);
    }),
  },

  "/ui/api/automations/triggers": {
    POST: handler(async (req) => {
      const input = await readJson<TriggerInput>(req);
      const t = createTrigger(input);
      return json(triggerDetail(t), { status: 201 });
    }),
  },

  "/ui/api/automations/triggers/:name": {
    GET: handler((req) => json(triggerDetail(requireTrigger(req.params.name)))),
    PUT: handler(async (req) => {
      const t = requireTrigger(req.params.name);
      const input = await readJson<TriggerInput>(req);
      return json(triggerDetail(updateTrigger(t, input)));
    }),
    DELETE: handler(async (req) => {
      const t = requireTrigger(req.params.name);
      await readJson(req);
      const db = getDb();
      db.query("DELETE FROM triggers WHERE id = ?").run(t.id);
      db.query("DELETE FROM trigger_sessions WHERE trigger_name = ?").run(t.name);
      if (t.type === "cron") syncCrontab();
      return json({ ok: true, name: t.name });
    }),
  },

  "/ui/api/automations/triggers/:name/runs": {
    GET: handler((req) => {
      const t = requireTrigger(req.params.name);
      const q = query(req);
      const page = intParam(q.get("page"), 1, 1);
      const pageSize = intParam(q.get("pageSize"), 25, 1, 200);
      const db = getDb();
      const total = (db.query("SELECT COUNT(*) AS n FROM trigger_runs WHERE trigger_name = ?").get(t.name) as { n: number }).n;
      const rows = db
        .query(`${RUN_SELECT} WHERE r.trigger_name = ? ORDER BY r.id DESC LIMIT ? OFFSET ?`)
        .all(t.name, pageSize, (page - 1) * pageSize) as RunRow[];
      return json({ items: rows.map(toRun), total, page, pageSize } satisfies RunsResponse);
    }),
  },

  "/ui/api/automations/triggers/:name/toggle": {
    POST: handler(async (req) => {
      const t = requireTrigger(req.params.name);
      const body = await readJson<{ enabled?: boolean }>(req);
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") badRequest("enabled must be true or false");
      const enabled = body.enabled ?? !t.enabled;
      getDb().query("UPDATE triggers SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, t.id);
      if (t.type === "cron") syncCrontab();
      return json({ ok: true, name: t.name, enabled });
    }),
  },

  "/ui/api/automations/triggers/:name/run": {
    POST: handler(async (req) => {
      const t = requireTrigger(req.params.name);
      const body = await readJson<{ payload?: string }>(req);
      if (body.payload !== undefined && typeof body.payload !== "string") badRequest("payload must be a string");
      if (isAtlasPaused(home())) throw new HttpError(409, "Atlas is paused. Resume it before running triggers.");
      if (!t.enabled) throw new HttpError(409, "Trigger is disabled. Enable it before running.");
      const payload = body.payload ?? "";
      // Webhooks fire like a delivery (runner assigns webhook-<runId>); others use the manual key, like /api/v1.
      const ok = t.type === "webhook" ? fireTrigger(t.name, payload) : fireTrigger(t.name, payload, "_manual");
      if (!ok) throw new HttpError(503, "trigger.sh is not available here (only inside the Atlas container)");
      return json({ ok: true, name: t.name, firedAt: new Date().toISOString() }, { status: 202 });
    }),
  },

  "/ui/api/automations/triggers/:name/secret": {
    POST: handler(async (req) => {
      const t = requireTrigger(req.params.name);
      await readJson(req);
      if (t.type !== "webhook" || !t.webhook_secret) notFound("This trigger has no webhook secret");
      return json({ secret: t.webhook_secret });
    }),
  },

  "/ui/api/automations/reminders": {
    GET: handler((req) => {
      const status = query(req).get("status") === "pending" ? "pending" : "all";
      const counts = getDb().query("SELECT status, COUNT(*) AS n FROM reminders GROUP BY status").all() as Array<{ status: string; n: number }>;
      const c = Object.fromEntries(counts.map((r) => [r.status, r.n]));
      return json({
        items: listReminders({ status }),
        counts: { pending: c.pending ?? 0, fired: c.fired ?? 0, cancelled: c.cancelled ?? 0 },
      } satisfies RemindersResponse);
    }),
  },

  "/ui/api/automations/reminders/:id/cancel": {
    POST: handler(async (req) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) notFound("No such reminder");
      await readJson(req);
      const r = getDb().query("SELECT id, title, status FROM reminders WHERE id = ?").get(id) as { id: number; title: string; status: string } | null;
      if (!r) notFound(`Reminder #${id} not found`);
      // Same rule as `reminder cancel`: only pending reminders can be cancelled.
      if (r.status !== "pending") throw new HttpError(409, `Reminder #${id} is already ${r.status}`);
      getDb().query("UPDATE reminders SET status = 'cancelled' WHERE id = ?").run(id);
      return json({ ok: true, id, status: "cancelled" });
    }),
  },
};
