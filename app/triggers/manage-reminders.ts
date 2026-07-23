#!/usr/bin/env bun
/**
 * Reminder management CLI
 *
 * Three trigger types:
 *   - time         : fires at a specific wall-clock time (default, existing behavior)
 *   - email_reply  : fires when a reply arrives in an email thread
 *   - script_check : fires when a shell command exits 0
 *
 * Usage: bun /atlas/app/triggers/manage-reminders.ts <command> [flags]
 */

import { Database } from "bun:sqlite";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { openDb } from "../lib/db.ts";

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

export function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of args) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/s);
    if (m) {
      flags[m[1]] = m[2] ?? "true";
    }
  }
  return flags;
}

/** Positional (non-`--flag`) tokens, in order. */
export function parsePositionals(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("--"));
}

/**
 * Resolve a reminder id for cancel/delete from either `--id=<n>` or a bare
 * positional (`reminder cancel 42`). Validates that the result is a positive
 * integer so a missing flag value (`--id` → "true") or a typo fails loudly with
 * an actionable message instead of querying for id `NaN` / `"true"`.
 *
 * Throws on invalid input; the CLI call-site converts the error via `die`.
 *
 * @param flagId       flags["id"] — may be undefined, a number-string, or "true"
 *                     when `--id` was passed without a value.
 * @param positionals  positional tokens for the command (command token removed).
 * @param command      "cancel" | "delete" — used only for error messages.
 */
export function resolveReminderId(
  flagId: string | undefined,
  positionals: string[],
  command: string,
): number {
  // `--id` without a value parses to "true"; treat that as "not provided"
  // and fall back to the first positional token.
  let raw = flagId && flagId !== "true" ? flagId : undefined;
  if (raw === undefined) raw = positionals[0];

  if (raw === undefined || raw === "") {
    throw new Error(
      `${command} requires a reminder id — e.g. \`reminder ${command} 42\` or \`reminder ${command} --id=42\` (find ids with \`reminder list\`).`,
    );
  }

  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `Invalid reminder id: "${raw}". Expected a positive integer — e.g. \`reminder ${command} 42\`.`,
    );
  }
  return n;
}

/**
 * Parse a human-friendly time string into a UTC storage datetime string.
 * Supported formats:
 *   - "+30m", "+2h", "+1d", "+14d"   — relative offset, single unit
 *   - "+1d2h30m", "+2h30m", "+90m"   — relative offset, combined units (order: d, h, m)
 *   - "14:00"                        — today at given time (local)
 *   - "2026-03-08 14:00"             — full date + time (local)
 *   - "2026-03-08T14:00:00"          — ISO-style (local)
 */
export function parseAt(at: string): string {
  const now = new Date();

  // Relative offset: single (+30m, +2h, +1d) or combined (+1d2h30m, +2h30m).
  // Units must appear in descending order (d, h, m) and at least one is required.
  const rel = at.match(/^\+(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/);
  if (rel && (rel[1] || rel[2] || rel[3])) {
    const days = parseInt(rel[1] ?? "0", 10);
    const hours = parseInt(rel[2] ?? "0", 10);
    const mins = parseInt(rel[3] ?? "0", 10);
    const ms = ((days * 24 + hours) * 60 + mins) * 60_000;
    return new Date(now.getTime() + ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  }

  // Time only (today): "14:00" or "14:00:00"
  const timeOnly = at.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (timeOnly) {
    const target = new Date(now);
    target.setHours(parseInt(timeOnly[1], 10), parseInt(timeOnly[2], 10), parseInt(timeOnly[3] ?? "0", 10), 0);
    return toUtcStorage(target);
  }

  // Full datetime: "2026-03-08 14:00" or "2026-03-08T14:00:00" (treat as local time)
  const fullMatch = at.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2}(?::\d{2})?)$/);
  if (fullMatch) {
    const parsed = new Date(`${fullMatch[1]}T${fullMatch[2]}:00`);
    if (isNaN(parsed.getTime())) die(`Cannot parse date/time: ${at}`);
    return toUtcStorage(parsed);
  }

  die(`Unrecognized time format: "${at}". Use "+30m", "+2h", "+1d", "+14d", "+2h30m" (combined; order d,h,m), "14:00", "2026-03-08 14:00", or "2026-03-08T14:00:00"`);
}

/**
 * Parse a recurring interval string (without leading "+") into seconds.
 * Accepted formats: "30m", "2h", "1d", "90s"
 * Minimum: 60 seconds.
 */
export function parseRecurringInterval(value: string): number {
  const m = value.match(/^(\d+)([smhd])$/);
  if (!m) {
    throw new Error(`Unrecognized --recurring format: "${value}". Use "30m", "2h", "1d" (no leading +). Minimum interval is 60s.`);
  }
  const amount = parseInt(m[1], 10);
  const unit = m[2];
  const seconds =
    unit === "s" ? amount
    : unit === "m" ? amount * 60
    : unit === "h" ? amount * 3_600
    : amount * 86_400;
  if (seconds < 60) {
    throw new Error(`--recurring interval must be at least 60 seconds (got ${seconds}s). Use "1m" or larger.`);
  }
  return seconds;
}

/**
 * Parse a check-interval string into seconds. Accepted: "1m", "5m", "1h".
 * Minimum: 60 seconds — the check loop is driven by a once-per-minute cron,
 * so a sub-minute interval silently degrades to ~60s anyway. Reject it loudly
 * instead of pretending faster polling exists.
 */
export function parseCheckInterval(value: string): number {
  const m = value.match(/^(\d+)([smhd])$/);
  if (!m) {
    throw new Error(`Unrecognized --check-interval format: "${value}". Use "1m", "5m", "1h" (no leading +). Minimum is 60s.`);
  }
  const amount = parseInt(m[1], 10);
  const unit = m[2];
  const seconds =
    unit === "s" ? amount
    : unit === "m" ? amount * 60
    : unit === "h" ? amount * 3_600
    : amount * 86_400;
  if (seconds < 60) {
    throw new Error(`--check-interval must be at least 60 seconds (got ${seconds}s) — the reminder check loop runs once per minute, so faster polling is not possible.`);
  }
  return seconds;
}

/**
 * Format seconds as a human-readable interval string for display.
 */
export function formatInterval(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** Convert a Date to the UTC storage format: "YYYY-MM-DD HH:MM:SS" */
function toUtcStorage(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/**
 * Returns true if the given session has a pending reminder that represents a
 * genuine "continue later" deferral. The Stop hook uses this to allow a
 * session to exit while goals/tasks are still open — because the work is
 * legitimately scheduled to resume in this same session.
 *
 * The predicate is deliberately TIGHT so a self-issued throwaway reminder
 * cannot be used to escape the task-completion gate:
 *   - status = 'pending'
 *   - routes back into THIS session (trigger_name AND session_key both match,
 *     both non-empty) — a --new-session reminder (NULL scope) does NOT count,
 *     since the open goals live in this session_key and would be orphaned.
 *   - a real forward continuation, one of:
 *       * recurring (re-fires into this session every interval — fine for
 *         long-term monitoring; the re-wake prompt warns that it is recurring
 *         and that a permanent gate-bypass is not allowed, see `check`), OR
 *       * event-driven (email_reply / script_check — waiting on the outside
 *         world), OR
 *       * a one-shot time reminder whose fire_at is still in the future.
 *     A past-due, non-recurring one-shot does NOT count — nothing will resume it.
 */
export function hasPendingContinuation(
  db: Database,
  triggerName: string,
  sessionKey: string,
  nowIso: string,
): boolean {
  if (!triggerName || !sessionKey) return false;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM reminders
        WHERE status = 'pending'
          AND trigger_name = ?
          AND session_key = ?
          AND (
            recurring_interval_seconds IS NOT NULL
            OR trigger_type IN ('email_reply', 'script_check')
            OR (COALESCE(trigger_type, 'time') = 'time' AND fire_at > ?)
          )`,
    )
    .get(triggerName, sessionKey, nowIso) as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

/** Convert a UTC storage string to local time string for display */
function toLocalDisplay(utcStr: string): string {
  const d = new Date(utcStr.replace(" ", "T") + "Z");
  return d.toLocaleString();
}

/**
 * Compute a stable idempotency hash over the fields that semantically
 * identify a non-time reminder. Used to dedupe accidental double-creates
 * by an agent (e.g. retry loops, mid-turn steering).
 *
 * `time` triggers are NOT deduped — repeating "set a 30m timer twice" is a
 * legitimate user request. Dedupe applies only to event-shaped triggers
 * (email_reply, script_check) where double-firing on the same event is wrong.
 */
export function computeIdempotencyHash(
  triggerType: string,
  triggerConfig: string,
  prompt: string,
): string {
  return createHash("sha256")
    .update(triggerType)
    .update("\0")
    .update(triggerConfig)
    .update("\0")
    .update(prompt)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Validate that an email thread_id exists in any of the per-account email DBs.
 * Returns true if found, false otherwise. Used at --when-reply-to add time so
 * we fail loudly if the agent passes a typo / stale id.
 */
export function emailThreadExists(threadId: string, emailDbDir: string): boolean {
  if (!existsSync(emailDbDir)) return false;
  const files = readdirSync(emailDbDir).filter((f) => f.endsWith(".db"));
  for (const f of files) {
    try {
      const accountDb = new Database(`${emailDbDir}/${f}`, { readonly: true });
      const row = accountDb.prepare("SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1").get(threadId);
      accountDb.close();
      if (row) return true;
    } catch {
      // DB might be missing the threads table — skip
    }
  }
  return false;
}

/**
 * Check whether a reply that matches the email_reply trigger has arrived
 * since the reminder was created.
 *
 * Returns the matching email's sender + subject for prompt context, or null
 * if nothing has arrived yet.
 */
export function checkEmailReply(
  threadId: string,
  fromFilter: string | null,
  reminderCreatedAt: string,
  emailDbDir: string,
): { sender: string; subject: string; created_at: string } | null {
  if (!existsSync(emailDbDir)) return null;
  const files = readdirSync(emailDbDir).filter((f) => f.endsWith(".db"));
  for (const f of files) {
    try {
      const accountDb = new Database(`${emailDbDir}/${f}`, { readonly: true });
      const query = fromFilter
        ? `SELECT sender, subject, created_at FROM emails
           WHERE thread_id = ? AND direction = 'in' AND created_at > ? AND lower(sender) LIKE ?
           ORDER BY created_at ASC LIMIT 1`
        : `SELECT sender, subject, created_at FROM emails
           WHERE thread_id = ? AND direction = 'in' AND created_at > ?
           ORDER BY created_at ASC LIMIT 1`;
      const params: any[] = fromFilter
        ? [threadId, reminderCreatedAt, `%${fromFilter.toLowerCase()}%`]
        : [threadId, reminderCreatedAt];
      const row = accountDb.prepare(query).get(...params) as any;
      accountDb.close();
      if (row) return row;
    } catch {
      // Missing emails table — skip
    }
  }
  return null;
}

/**
 * Result of probing a check command once.
 *
 * Exit-code contract for --when-script-ok commands:
 *   0   → condition met, the reminder fires
 *   1   → condition not met yet, keep waiting
 *   >1  → broken command (typo, missing binary, config error)
 */
export type ScriptProbeResult = {
  /** Exit code, or null when the process was killed (e.g. timeout SIGTERM). */
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
  stdout: string;
};

/**
 * Run a shell command (via `bash -c`) once and report exit code + output.
 * Used both by the check loop and by the add-time dry-run.
 */
export function runScriptProbe(command: string, timeoutMs = 30_000): ScriptProbeResult {
  try {
    const stdout = execSync(command, {
      shell: "/bin/bash",
      stdio: "pipe",
      timeout: timeoutMs, // hard cap per check — protect cron from hangs
    });
    return { exitCode: 0, timedOut: false, stderr: "", stdout: stdout?.toString() ?? "" };
  } catch (e: any) {
    const timedOut = e?.code === "ETIMEDOUT" || (e?.signal === "SIGTERM" && e?.status == null);
    return {
      exitCode: typeof e?.status === "number" ? e.status : null,
      timedOut,
      stderr: e?.stderr?.toString() ?? "",
      stdout: e?.stdout?.toString() ?? "",
    };
  }
}

/**
 * Convenience wrapper: true iff the command exited 0 (condition met).
 */
export function runScriptCheck(command: string): boolean {
  return runScriptProbe(command).exitCode === 0;
}

/** Maximum wake attempts per reminder before a failed wake is given up. */
export const MAX_WAKE_ATTEMPTS = 3;

/**
 * Atomically claim a pending reminder for firing (pending → fired).
 * Only the process that wins the transition may fire the wake; a concurrent
 * `check` pass evaluating the same row loses the claim (returns false) and
 * must skip it. This is the guard against double-wakes when two check passes
 * overlap — the plain UPDATE it replaces had no status guard, so both passes
 * would fire the same reminder.
 */
export function claimReminder(db: Database, id: number): boolean {
  const res = db
    .prepare(
      `UPDATE reminders SET status = 'fired', fired_at = datetime('now')
        WHERE id = ? AND status = 'pending'`,
    )
    .run(id);
  return res.changes === 1;
}

/**
 * Record the outcome of a wake attempt after the spawned trigger process
 * exited. A non-zero exit means trigger-runner could not deliver the wake
 * (DB missing, originating trigger gone, "lock held but socket unavailable").
 *
 * On failure the reminder is put back to 'pending' so the next check pass
 * retries — up to MAX_WAKE_ATTEMPTS total attempts, then it stays 'fired'
 * and the loss is the caller's to log. Recurring reminders are never
 * reverted: their next occurrence is already scheduled at claim time, so a
 * retry would fire the same prompt twice.
 */
export function recordWakeOutcome(
  db: Database,
  id: number,
  exitCode: number | null,
  isRecurring: boolean,
): "delivered" | "retry" | "gave_up" {
  if (exitCode === 0) return "delivered";
  const row = db
    .prepare(`SELECT wake_attempts FROM reminders WHERE id = ?`)
    .get(id) as { wake_attempts: number | null } | undefined;
  if (!row) return "gave_up";
  const attempts = (row.wake_attempts ?? 0) + 1;
  if (isRecurring || attempts >= MAX_WAKE_ATTEMPTS) {
    db.prepare(`UPDATE reminders SET wake_attempts = ? WHERE id = ?`).run(attempts, id);
    return "gave_up";
  }
  db.prepare(
    `UPDATE reminders SET wake_attempts = ?, status = 'pending', fired_at = NULL
      WHERE id = ? AND status = 'fired'`,
  ).run(attempts, id);
  return "retry";
}

/**
 * Acquire the singleton lock for the `check` command via a PID lockfile.
 * Cron fires `check` every minute, but a pass with slow script_checks can
 * exceed that — overlapping passes double-run commands. Returns true if the
 * lock was acquired. A lockfile whose PID is dead is stale and taken over.
 */
export function acquireCheckLock(lockFile: string): boolean {
  if (existsSync(lockFile)) {
    const pid = parseInt(readFileSync(lockFile, "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false; // live process holds the lock
      } catch {
        // Process dead — stale lock, take over
      }
    }
  }
  writeFileSync(lockFile, String(process.pid));
  return true;
}

/** Release the check lock — only if this process still owns it. */
export function releaseCheckLock(lockFile: string): void {
  try {
    if (readFileSync(lockFile, "utf8").trim() === String(process.pid)) {
      unlinkSync(lockFile);
    }
  } catch {
    // Already gone or unreadable — nothing to release
  }
}

function printTable(reminders: any[], recurringOnly = false): void {
  const filtered = recurringOnly
    ? reminders.filter((r) => r.recurring_interval_seconds != null)
    : reminders;

  if (filtered.length === 0) {
    console.log("No reminders found.");
    return;
  }
  const cols = ["id", "title", "trigger", "fires_when", "recurring", "channel", "session", "status"];
  const rows = filtered.map((r) => {
    const triggerType = r.trigger_type || "time";
    const firesWhen = triggerType === "time"
      ? toLocalDisplay(r.fire_at)
      : describeNonTimeTrigger(triggerType, r.trigger_config);
    return {
      id: String(r.id),
      title: r.title,
      trigger: triggerType,
      fires_when: firesWhen,
      recurring: r.recurring_interval_seconds != null ? `every ${formatInterval(r.recurring_interval_seconds)}` : "—",
      channel: r.channel ?? "internal",
      session: r.trigger_name ? `${r.trigger_name}/${r.session_key || "_default"}` : "ephemeral",
      status: r.status,
    };
  });

  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String((r as any)[c] ?? "").length))
  );
  const header = cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  console.log(header);
  console.log(sep);
  for (const row of rows) {
    console.log(cols.map((c, i) => String((row as any)[c] ?? "").padEnd(widths[i])).join("  "));
  }
}

function describeNonTimeTrigger(triggerType: string, configJson: string | null): string {
  if (!configJson) return triggerType;
  try {
    const cfg = JSON.parse(configJson);
    if (triggerType === "email_reply") {
      const tid = String(cfg.thread_id || "").slice(0, 12);
      return cfg.from ? `reply in ${tid}… from ${cfg.from}` : `reply in ${tid}…`;
    }
    if (triggerType === "script_check") {
      const cmd = String(cfg.command || "").slice(0, 30);
      return `script ok: ${cmd}…`;
    }
  } catch {
    // ignore
  }
  return triggerType;
}

// --- Main (only runs when executed directly, not when imported by tests) ---

if (!import.meta.main) {
  // Module was imported — exported functions still available; skip CLI.
} else {

const argv = Bun.argv.slice(2);
const command = argv[0];

if (!command || command === "--help" || command === "-h") {
  console.log(`Usage: bun /atlas/app/triggers/manage-reminders.ts <command> [flags]

Commands:
  add     [--at=<time> | --when-reply-to=<thread-id> | --when-script-ok=<cmd>]
          --title=<text> --prompt=<text>
          [--from=<addr>] [--check-interval=<duration>]
          [--timeout=<time>] [--channel=internal] [--new-session]
          [--recurring=<interval>]
  list    [--all] [--recurring]
  cancel  <id> | --id=<id>
  delete  <id> | --id=<id>
  check   (evaluate due reminders — called by cron)
  has-continuation  (exit 0 if this session has a pending continuation
                     reminder — used by the Stop hook; prints yes/no)

Trigger types (pick exactly one per reminder):

  --at=<time>                  Fire at a wall-clock time. Time formats:
                                 "+30m", "+2h", "+1d", "+14d"   (relative, single unit)
                                 "+1d2h30m", "+2h30m", "+90m"   (relative, combined; order d,h,m)
                                 "14:00"                        (today, local)
                                 "2026-03-08 14:00"             (full local datetime)

  --when-reply-to=<thread-id>  Fire when an inbound email arrives in <thread-id>.
                               Optionally restrict with --from=<addr>.
                               Use 'email threads' to find thread ids.

  --when-script-ok=<cmd>       Fire when '<cmd>' exits 0. The command is run
                               under 'bash -c'. Checked every --check-interval
                               (default: 60s; minimum: 60s — the check loop
                               runs once per minute).
                               Exit-code contract:
                                 0   condition met  → reminder fires
                                 1   not met yet    → keep waiting
                                 >1  broken command → error
                               On 'add' the command is always dry-run once:
                                 exit >1 or timeout rejects the add (with
                                 stderr, so you can fix the command);
                                 exit 0 also rejects — the condition is
                                 already met, so handle the task now or fix
                                 the command to wait for a future state.
                               At check time, exit >1 is logged as an error
                               and treated as 'keep waiting'.

Optional safety net:

  --timeout=<time>             Only meaningful with --when-reply-to or
                               --when-script-ok. If the trigger condition is
                               not met by <time>, the reminder fires anyway
                               with a "[Timeout]" note appended to the prompt
                               so you can react. NO default — most real-world
                               events take days. A typical safety net is
                               --timeout=+14d. Leave unset to wait forever.

Recurring reminders (--recurring):
  Interval formats (no leading +): "30m", "2h", "1d"  (minimum: 60s / "1m")
  Fires repeatedly into the same session until cancelled.
  Note: the pending row id changes after each fire — use 'reminder list' to
  find the current one. Incompatible with --new-session.

Session routing:
  By default, reminders fire into the same session that created them.
  Use --new-session to force a standalone ephemeral session instead.

Idempotency:
  --when-reply-to and --when-script-ok are deduped over
  (trigger-config, prompt). Re-adding the same reminder returns the
  existing id instead of creating a duplicate. --at reminders are not
  deduped (setting two 30m timers is legitimate).

Examples:
  # Time-based (existing behavior, unchanged)
  reminder add --title="Standup" --at="2026-03-08 09:00" --prompt="Send daily standup"

  # Wait for an email reply (forever, no timeout)
  reminder add --title="Müller OK" --when-reply-to="thread-abc123" \\
    --prompt="Müller hat geantwortet — gleich abarbeiten"

  # Wait for a reply, but give up after two weeks
  reminder add --title="Müller OK" --when-reply-to="thread-abc123" \\
    --from="s.mueller@mueller-partner.de" --timeout="+14d" \\
    --prompt="Müller hat geantwortet (oder Timeout) — entscheiden"

  # Wait until a CI/deploy script signals ready
  reminder add --title="Deploy ready" \\
    --when-script-ok="kubectl rollout status deploy/api --timeout=10s" \\
    --check-interval="2m" --prompt="Deploy ist live — Tests fahren"
`);
  process.exit(0);
}

const flags = parseFlags(argv.slice(1));
const db = openDb();

// Ensure reminders table exists (in case db.ts hasn't run yet for this DB)
db.run(`
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    fire_at TEXT NOT NULL,
    channel TEXT DEFAULT 'internal',
    trigger_name TEXT,
    session_key TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','fired','cancelled')),
    created_at TEXT DEFAULT (datetime('now')),
    fired_at TEXT
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_reminders_status_fire ON reminders(status, fire_at)`);

// Existing migrations
try { db.run("ALTER TABLE reminders ADD COLUMN trigger_name TEXT"); } catch {}
try { db.run("ALTER TABLE reminders ADD COLUMN session_key TEXT"); } catch {}
try { db.run("ALTER TABLE reminders ADD COLUMN recurring_interval_seconds INTEGER"); } catch {}
// New (generalized trigger) migrations
try { db.run("ALTER TABLE reminders ADD COLUMN trigger_type TEXT DEFAULT 'time'"); } catch {}
try { db.run("ALTER TABLE reminders ADD COLUMN trigger_config TEXT"); } catch {}
try { db.run("ALTER TABLE reminders ADD COLUMN timeout_at TEXT"); } catch {}
try { db.run("ALTER TABLE reminders ADD COLUMN idempotency_hash TEXT"); } catch {}
try { db.run("ALTER TABLE reminders ADD COLUMN last_checked_at TEXT"); } catch {}
try { db.run("ALTER TABLE reminders ADD COLUMN wake_attempts INTEGER DEFAULT 0"); } catch {}
db.run(`CREATE INDEX IF NOT EXISTS idx_reminders_idempotency ON reminders(status, idempotency_hash)`);

switch (command) {
  case "add": {
    const title = flags["title"] || "";
    const at = flags["at"] || "";
    const replyTo = flags["when-reply-to"] || "";
    const scriptOk = flags["when-script-ok"] || "";
    const fromFilter = flags["from"] || "";
    const checkIntervalRaw = flags["check-interval"] || "";
    const timeoutRaw = flags["timeout"] || "";
    const prompt = flags["prompt"] || "";
    const channel = flags["channel"] || "internal";
    const newSession = flags["new-session"] === "true";
    const recurringRaw = flags["recurring"];
    const persistFlag = flags["persist"];

    if (persistFlag !== undefined) {
      die("--persist is not supported. Recurring reminders are session-bound by design. For cross-session schedules, use a cronjob — see 'cron --help' or the 'triggers' skill.");
    }

    if (!title) die("--title is required");
    if (!prompt) die("--prompt is required");

    // Exactly one of --at / --when-reply-to / --when-script-ok must be set
    const triggerFlagsPresent: string[] = [];
    if (at) triggerFlagsPresent.push("--at");
    if (replyTo) triggerFlagsPresent.push("--when-reply-to");
    if (scriptOk) triggerFlagsPresent.push("--when-script-ok");
    if (triggerFlagsPresent.length === 0) {
      die("One of --at, --when-reply-to, or --when-script-ok is required. These three trigger flags are mutually exclusive — pick exactly one per reminder.");
    }
    if (triggerFlagsPresent.length > 1) {
      die(`${triggerFlagsPresent.join(" and ")} cannot be combined — these trigger flags are mutually exclusive. Pick exactly one per reminder. (If you need both time and event semantics, use one reminder per trigger.)`);
    }

    // Validate --recurring flag combinations before touching the DB
    let recurringIntervalSeconds: number | null = null;
    if (recurringRaw !== undefined) {
      if (newSession) {
        die("--recurring requires the session context to inject into; --new-session creates ephemeral sessions. Use a cronjob instead.");
      }
      if (!process.env.ATLAS_TRIGGER) {
        die("--recurring can only be used from within a trigger session (the reminder needs a session to fire into).");
      }
      if (replyTo || scriptOk) {
        const eventFlag = replyTo ? "--when-reply-to" : "--when-script-ok";
        die(`--recurring is only supported with --at, but ${eventFlag} was set. Event-driven triggers (--when-reply-to, --when-script-ok) fire on edges, not on intervals; if you need repeated behavior, set a fresh reminder after each fire.`);
      }
      try {
        recurringIntervalSeconds = parseRecurringInterval(recurringRaw);
      } catch (e: any) {
        die(e.message);
      }
    }

    // --from is only meaningful with --when-reply-to
    if (fromFilter && !replyTo) {
      die("--from only applies to --when-reply-to.");
    }

    // --check-interval is only meaningful with --when-script-ok
    if (checkIntervalRaw && !scriptOk) {
      die("--check-interval only applies to --when-script-ok.");
    }

    let triggerType: string;
    let triggerConfigObj: Record<string, any> = {};
    let fireAt: string; // for compatibility with existing schema column
    let timeoutAt: string | null = null;

    if (at) {
      triggerType = "time";
      fireAt = parseAt(at);
      // --timeout doesn't make sense with --at
      if (timeoutRaw) die("--timeout doesn't apply to --at reminders (the time itself is the trigger).");
    } else if (replyTo) {
      triggerType = "email_reply";
      // Sanity: validate that the thread exists so a typo fails loudly here
      const emailDbDir = `${process.env.HOME}/.index/email`;
      if (existsSync(emailDbDir) && !emailThreadExists(replyTo, emailDbDir)) {
        console.warn(`Warning: thread '${replyTo}' was not found in any local email DB. The reminder is still scheduled but will only fire on future replies if the thread becomes known.`);
      }
      triggerConfigObj = { thread_id: replyTo };
      if (fromFilter) triggerConfigObj.from = fromFilter;
      // fire_at acts as a sentinel for the existing index — set far future
      fireAt = "9999-12-31 23:59:59";
      if (timeoutRaw) timeoutAt = parseAt(timeoutRaw);
    } else {
      // scriptOk
      triggerType = "script_check";
      const checkInterval = checkIntervalRaw
        ? (() => { try { return parseCheckInterval(checkIntervalRaw); } catch (e: any) { die(e.message); } })()
        : 60;
      triggerConfigObj = { command: scriptOk, check_interval_seconds: checkInterval };
      fireAt = "9999-12-31 23:59:59";
      if (timeoutRaw) timeoutAt = parseAt(timeoutRaw);

      // Dry-run: probe the command once so a broken command fails loudly here
      // instead of silently "waiting" forever at every check tick.
      // Contract: exit 0 = condition met, exit 1 = not met yet, >1 = broken.
      const probe = runScriptProbe(scriptOk);
      if (probe.timedOut) {
        die(
          `Dry-run of the check command timed out after 30s.\n` +
          `Check commands run under a hard 30s cap at every tick — make the command faster ` +
          `(e.g. use the tool's own --timeout flag).`,
        );
      }
      if (probe.exitCode !== 0 && probe.exitCode !== 1) {
        const hint =
          probe.exitCode === 127 ? " Exit 127 means 'command not found' — check for a typo or a missing binary on PATH."
          : probe.exitCode === 126 ? " Exit 126 means 'permission denied / not executable' — check file permissions."
          : "";
        die(
          `Dry-run of the check command failed with exit code ${probe.exitCode ?? "(killed by signal)"}.${hint}\n` +
          `Exit-code contract for --when-script-ok: 0 = condition met (reminder fires), ` +
          `1 = not met yet (keeps waiting), >1 = broken command.\n` +
          (probe.stderr.trim() ? `stderr: ${probe.stderr.trim().slice(0, 500)}\n` : "") +
          `Fix the command and re-run 'reminder add'. If the command legitimately exits >1 while ` +
          `waiting, wrap it as '<cmd> || exit 1'.`,
        );
      }
      if (probe.exitCode === 0) {
        die(
          `Reminder NOT scheduled: the check command already exits 0 — the condition you want ` +
          `to wait for is already met, so this reminder would fire immediately at the next tick.\n` +
          `Either handle the task right now (no reminder needed), or fix the command so it waits ` +
          `for the future state you actually care about.`,
        );
      }
    }

    const triggerConfig = JSON.stringify(triggerConfigObj);

    // Idempotency check for event-shaped triggers
    let existingId: number | null = null;
    if (triggerType !== "time") {
      const ihash = computeIdempotencyHash(triggerType, triggerConfig, prompt);
      const existing = db
        .prepare(
          `SELECT id FROM reminders WHERE status = 'pending' AND idempotency_hash = ? LIMIT 1`,
        )
        .get(ihash) as { id: number } | undefined;
      if (existing) {
        console.log(
          `Reminder #${existing.id} already pending for this trigger + prompt (idempotency match). Skipping duplicate.`,
        );
        process.exit(0);
      }
      var idempotencyHash: string | null = ihash;
    } else {
      var idempotencyHash: string | null = null;
    }

    // Capture trigger context
    const triggerName = newSession ? null : (process.env.ATLAS_TRIGGER || null);
    const sessionKey = newSession ? null : (process.env.ATLAS_TRIGGER_SESSION_KEY || null);

    const result = db.prepare(
      `INSERT INTO reminders (
         title, prompt, fire_at, channel, trigger_name, session_key,
         recurring_interval_seconds, trigger_type, trigger_config,
         timeout_at, idempotency_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      title,
      prompt,
      fireAt,
      channel,
      triggerName,
      sessionKey,
      recurringIntervalSeconds,
      triggerType,
      triggerConfig === "{}" ? null : triggerConfig,
      timeoutAt,
      idempotencyHash,
    );

    const id = result.lastInsertRowid;

    console.log(`Reminder #${id} scheduled: "${title}"`);
    if (triggerType === "time") {
      console.log(`  Fire at: ${toLocalDisplay(fireAt)}`);
    } else if (triggerType === "email_reply") {
      console.log(`  Fires when: reply arrives in thread ${triggerConfigObj.thread_id}${fromFilter ? ` from ${fromFilter}` : ""}`);
    } else {
      console.log(`  Fires when: '${triggerConfigObj.command}' exits 0 (checked every ${formatInterval(triggerConfigObj.check_interval_seconds)})`);
    }
    if (timeoutAt) {
      console.log(`  Timeout: ${toLocalDisplay(timeoutAt)} (fires with [Timeout] note if no trigger by then)`);
    }
    console.log(`  Channel: ${channel}`);
    if (triggerName) {
      console.log(`  Session: ${triggerName}/${sessionKey || "_default"} (will resume originating session)`);
    } else {
      console.log(`  Session: new ephemeral session`);
    }
    if (recurringIntervalSeconds !== null) {
      console.log(`  Recurring: every ${formatInterval(recurringIntervalSeconds)}. Will run until cancelled. Use 'reminder cancel --id=<id>' to stop.`);
    }
    break;
  }

  case "list": {
    const showAll = flags["all"] === "true";
    const recurringOnly = flags["recurring"] === "true";
    const sql = showAll
      ? "SELECT * FROM reminders ORDER BY id DESC"
      : "SELECT * FROM reminders WHERE status = 'pending' ORDER BY id ASC";
    const reminders = db.prepare(sql).all() as any[];
    printTable(reminders, recurringOnly);
    break;
  }

  case "cancel": {
    let id: number;
    try { id = resolveReminderId(flags["id"], parsePositionals(argv.slice(1)), "cancel"); }
    catch (e: any) { die(e.message); }

    const existing = db.prepare("SELECT * FROM reminders WHERE id = ?").get(id) as any;
    if (!existing) die(`Reminder #${id} not found`);
    if (existing.status !== "pending") die(`Reminder #${id} is already ${existing.status}`);

    db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ?").run(id);
    console.log(`Reminder #${id} cancelled: "${existing.title}"`);
    break;
  }

  case "delete": {
    let id: number;
    try { id = resolveReminderId(flags["id"], parsePositionals(argv.slice(1)), "delete"); }
    catch (e: any) { die(e.message); }

    const existing = db.prepare("SELECT * FROM reminders WHERE id = ?").get(id) as any;
    if (!existing) die(`Reminder #${id} not found`);

    db.prepare("DELETE FROM reminders WHERE id = ?").run(id);
    console.log(`Reminder #${id} deleted: "${existing.title}"`);
    break;
  }

  case "check": {
    // Pause guard: while Atlas is paused, leave reminders pending. Firing
    // anyway would mark them 'fired' while trigger-runner drops the wake
    // (it exits 0 on pause) — the reminder would be silently lost.
    if (existsSync(`${process.env.HOME}/.atlas-paused`)) {
      console.log(`[${new Date().toISOString()}] Atlas is paused — leaving reminders pending.`);
      break;
    }

    // Singleton guard: cron fires `check` every minute, but a pass with slow
    // script_checks (each up to 30s, sequential) can exceed that. Overlapping
    // passes used to run the same command concurrently and double-fire
    // reminders — skip this tick if another pass is still evaluating.
    const checkLockFile = "/tmp/.reminder-check.lock";
    if (!acquireCheckLock(checkLockFile)) {
      console.log(`[${new Date().toISOString()}] Another check pass is still running — skipping this tick.`);
      break;
    }

    // Pull all pending reminders. Evaluate per trigger_type — in two phases,
    // so a slow script_check can never delay a due time/email reminder.
    const pending = db.prepare(`SELECT * FROM reminders WHERE status = 'pending'`).all() as any[];
    const emailDbDir = `${process.env.HOME}/.index/email`;

    const nowIso = toUtcStorage(new Date());
    const due: Array<{ reminder: any; reason: "fired" | "timeout" }> = [];
    const scriptChecks: any[] = [];

    // Phase 1: cheap evaluations (time, email_reply, timeouts).
    for (const r of pending) {
      const triggerType = r.trigger_type || "time";

      if (triggerType === "time") {
        if (r.fire_at <= nowIso) {
          due.push({ reminder: r, reason: "fired" });
        }
        continue;
      }

      // Timeout takes precedence: if expired, fire with note
      if (r.timeout_at && r.timeout_at <= nowIso) {
        due.push({ reminder: r, reason: "timeout" });
        continue;
      }

      if (triggerType === "email_reply") {
        let cfg: any = {};
        try { cfg = r.trigger_config ? JSON.parse(r.trigger_config) : {}; } catch {}
        const match = checkEmailReply(cfg.thread_id, cfg.from || null, r.created_at, emailDbDir);
        if (match) {
          due.push({ reminder: r, reason: "fired" });
        }
        continue;
      }

      if (triggerType === "script_check") {
        scriptChecks.push(r);
        continue;
      }

      // Unknown trigger_type — log and skip rather than crash
      console.warn(`[${new Date().toISOString()}] Reminder #${r.id} has unknown trigger_type '${triggerType}' — skipping.`);
    }

    // Phase 2: script_checks — each blocks up to 30s (execSync cap).
    for (const r of scriptChecks) {
      let cfg: any = {};
      try { cfg = r.trigger_config ? JSON.parse(r.trigger_config) : {}; } catch {}

      const interval = cfg.check_interval_seconds || 60;
      // Throttle: only run if last_checked_at + interval <= now
      if (r.last_checked_at) {
        const lastMs = new Date(r.last_checked_at.replace(" ", "T") + "Z").getTime();
        if (Date.now() - lastMs < interval * 1000) continue;
      }
      // Claim the check slot BEFORE running the blocking command, with the
      // actual current time — so a pass that slips past the lock (stale-lock
      // takeover) won't run the same command concurrently.
      db.prepare(`UPDATE reminders SET last_checked_at = ? WHERE id = ?`).run(toUtcStorage(new Date()), r.id);
      // Contract: 0 = fire, 1 = keep waiting, >1 = broken command. Anything
      // that isn't 0/1 is treated as "keep waiting" but logged loudly — the
      // add-time dry-run should have caught permanently broken commands.
      const probe = runScriptProbe(cfg.command);
      if (probe.exitCode === 0) {
        due.push({ reminder: r, reason: "fired" });
      } else if (probe.exitCode !== 1) {
        const what = probe.timedOut ? "timed out after 30s" : `exited ${probe.exitCode ?? "via signal"}`;
        console.warn(
          `[${new Date().toISOString()}] Reminder #${r.id} check command ${what} ` +
          `(contract: 0=fire, 1=wait, >1=error) — treating as 'keep waiting'.` +
          (probe.stderr.trim() ? ` stderr: ${probe.stderr.trim().slice(0, 200)}` : ""),
        );
      }
    }

    if (due.length === 0) {
      releaseCheckLock(checkLockFile);
      console.log(`[${new Date().toISOString()}] No due reminders.`);
      break;
    }

    console.log(`[${new Date().toISOString()}] Found ${due.length} due reminder(s).`);

    // Watch a spawned wake process: all trigger-runner failure exits happen
    // fast (worst case ~60s internal lock wait). If the process is still
    // alive after the confirm window it is running a session — the wake was
    // delivered; unref() so this cron pass isn't pinned for the session's
    // lifetime. On a fast non-zero exit, revert the reminder to 'pending'
    // for retry on the next tick (bounded by MAX_WAKE_ATTEMPTS).
    const WAKE_CONFIRM_MS = 120_000;
    const watchWake = async (proc: ReturnType<typeof Bun.spawn>, reminder: any): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stillRunning = await Promise.race([
        proc.exited.then(() => false),
        new Promise<boolean>((res) => { timer = setTimeout(() => res(true), WAKE_CONFIRM_MS); }),
      ]);
      if (timer) clearTimeout(timer);
      if (stillRunning) {
        proc.unref();
        return;
      }
      const outcome = recordWakeOutcome(
        db,
        reminder.id,
        proc.exitCode,
        reminder.recurring_interval_seconds != null,
      );
      if (outcome === "retry") {
        console.error(`[${new Date().toISOString()}] Reminder #${reminder.id} wake failed (exit ${proc.exitCode}) — reverted to pending, will retry next tick.`);
      } else if (outcome === "gave_up") {
        console.error(`[${new Date().toISOString()}] Reminder #${reminder.id} wake failed (exit ${proc.exitCode}) — retries exhausted, wake lost. Check /atlas/logs/trigger-*.log.`);
      }
    };
    const wakeOutcomes: Promise<void>[] = [];

    for (const { reminder, reason } of due) {
      // Atomic claim (pending → fired): only the winner fires. Guards against
      // a concurrent check pass firing the same reminder twice.
      if (!claimReminder(db, reminder.id)) {
        console.log(`[${new Date().toISOString()}] Reminder #${reminder.id} already claimed by another pass — skipping.`);
        continue;
      }

      console.log(`[${new Date().toISOString()}] Firing reminder #${reminder.id}: "${reminder.title}" (reason=${reason})`);

      // Re-schedule recurring reminders (only for time-trigger; enforced at add time)
      if (reminder.recurring_interval_seconds != null) {
        const newResult = db.prepare(
          `INSERT INTO reminders (
             title, prompt, fire_at, channel, trigger_name, session_key,
             recurring_interval_seconds, trigger_type, trigger_config,
             timeout_at, idempotency_hash
           )
           VALUES (?, ?, datetime('now', '+' || ? || ' seconds'), ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          reminder.title,
          reminder.prompt,
          reminder.recurring_interval_seconds,
          reminder.channel,
          reminder.trigger_name,
          reminder.session_key,
          reminder.recurring_interval_seconds,
          reminder.trigger_type || "time",
          reminder.trigger_config,
          reminder.timeout_at,
          reminder.idempotency_hash,
        );
        console.log(`[${new Date().toISOString()}] Reminder #${reminder.id} is recurring — next fire scheduled as #${newResult.lastInsertRowid} in ${formatInterval(reminder.recurring_interval_seconds)}`);
      }

      const channel = reminder.channel || "internal";

      // Wrap the user's prompt with reminder context and memory instructions.
      // Append a [Timeout] note when the trigger fired because of timeout.
      const timeoutNote = reason === "timeout"
        ? `\n\n[Timeout: the trigger condition was not met within the configured window; firing anyway so you can decide how to proceed.]`
        : "";

      // A recurring reminder re-fires forever and counts as a valid
      // "continuation" for the Stop-gate — which means it could mask open goals
      // indefinitely. Make that explicit on every re-wake so the session
      // actively resolves the work instead of riding the recurring bypass.
      const recurringNote = reminder.recurring_interval_seconds != null
        ? `\n\n[Recurring reminder, every ${formatInterval(reminder.recurring_interval_seconds)}. It keeps this session's open goals/tasks from blocking exit — but that is NOT a free pass to leave work unfinished. Each time it fires, make real progress; when the underlying work is done, cancel it with \`reminder cancel --id=<current-id>\` (find it via \`reminder list\`). Do not rely on it as a permanent gate bypass.]`
        : "";

      const promptText = `[Reminder #${reminder.id}: "${reminder.title}"]\n\n${reminder.prompt}${timeoutNote}${recurringNote}\n\nIMPORTANT: After completing this task, write a brief note to today's journal (memory/journal/) documenting what you did and any messages you sent. This ensures other sessions (e.g. Signal) have context if the user replies.`;

      // Routing sanity: if the originating trigger was deleted or disabled,
      // trigger-runner would exit without delivering (silently for disabled).
      // Fall back to a direct ephemeral session so the prompt still reaches
      // a session instead of being lost.
      let routeViaTrigger = Boolean(reminder.trigger_name);
      if (routeViaTrigger) {
        try {
          const t = db
            .prepare("SELECT enabled FROM triggers WHERE name = ?")
            .get(reminder.trigger_name) as { enabled: number } | undefined;
          if (!t || !t.enabled) {
            console.warn(`[${new Date().toISOString()}] Reminder #${reminder.id}: originating trigger '${reminder.trigger_name}' is ${t ? "disabled" : "gone"} — falling back to a direct ephemeral session.`);
            routeViaTrigger = false;
          }
        } catch {
          // triggers table missing — let trigger-runner decide
        }
      }

      let argv: string[];
      if (routeViaTrigger) {
        const sessionKey = reminder.session_key || "_default";
        console.log(`[${new Date().toISOString()}] Reminder #${reminder.id}: routing to ${reminder.trigger_name}/${sessionKey}`);
        argv = ["/atlas/app/triggers/trigger.sh", reminder.trigger_name, promptText, sessionKey];
      } else {
        argv = ["/atlas/app/triggers/trigger-runner", "--direct", promptText, "--channel", channel];
      }

      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(argv, {
          env: {
            ...process.env,
            ATLAS_REMINDER_ID: String(reminder.id),
            ATLAS_REMINDER_TITLE: reminder.title,
          },
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
        });
      } catch (err) {
        // Spawn itself failed (e.g. missing binary) — treat like a failed
        // wake so the reminder is retried instead of silently lost.
        console.error(`[${new Date().toISOString()}] Reminder #${reminder.id} spawn failed: ${err}`);
        recordWakeOutcome(db, reminder.id, 1, reminder.recurring_interval_seconds != null);
        continue;
      }

      console.log(`[${new Date().toISOString()}] Reminder #${reminder.id} spawned (pid=${proc.pid})`);
      wakeOutcomes.push(watchWake(proc, reminder));
    }

    // Release the pass lock BEFORE waiting on wake outcomes: a routed wake
    // that starts a fresh session keeps its process alive for the whole
    // session, and the next check tick must not be blocked by that. The
    // atomic claim + pre-run last_checked_at protect the released window.
    releaseCheckLock(checkLockFile);
    await Promise.all(wakeOutcomes);
    break;
  }

  case "has-continuation": {
    // Used by the Stop hook (task-session.sh) to decide whether open goals/
    // tasks are legitimately deferred to a future wake of THIS session.
    // Prints "yes"/"no" and mirrors it in the exit code (0 = yes, 1 = no).
    const triggerName = process.env.ATLAS_TRIGGER || "";
    const sessionKey = process.env.ATLAS_TRIGGER_SESSION_KEY || "";
    const nowIso = toUtcStorage(new Date());
    const ok = hasPendingContinuation(db, triggerName, sessionKey, nowIso);
    console.log(ok ? "yes" : "no");
    process.exit(ok ? 0 : 1);
  }

  default:
    die(`Unknown command '${command}'. Run with --help for usage.`);
}

} // end import.meta.main guard
