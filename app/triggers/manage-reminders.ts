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
import { existsSync, readdirSync } from "fs";
import { openDb } from "../lib/db.ts";

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of args) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/s);
    if (m) {
      flags[m[1]] = m[2] ?? "true";
    }
  }
  return flags;
}

/**
 * Parse a human-friendly time string into a UTC storage datetime string.
 * Supported formats:
 *   - "+30m", "+2h", "+1d", "+14d"  — relative offsets
 *   - "14:00"                        — today at given time (local)
 *   - "2026-03-08 14:00"             — full date + time (local)
 *   - "2026-03-08T14:00:00"          — ISO-style (local)
 */
function parseAt(at: string): string {
  const now = new Date();

  // Relative: +Nm, +Nh, +Nd
  const relMatch = at.match(/^\+(\d+)([mhd])$/);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const ms = unit === "m" ? amount * 60_000
              : unit === "h" ? amount * 3_600_000
              : amount * 86_400_000;
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

  die(`Unrecognized time format: "${at}". Use "+30m", "+2h", "+1d", "+14d", "14:00", "2026-03-08 14:00", or "2026-03-08T14:00:00"`);
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
 * Parse a check-interval string into seconds. Accepted: "30s", "1m", "5m", "1h".
 * Minimum: 10 seconds (script_check is a polling trigger, sub-10s is wasteful).
 */
export function parseCheckInterval(value: string): number {
  const m = value.match(/^(\d+)([smhd])$/);
  if (!m) {
    throw new Error(`Unrecognized --check-interval format: "${value}". Use "30s", "1m", "1h" (no leading +). Minimum is 10s.`);
  }
  const amount = parseInt(m[1], 10);
  const unit = m[2];
  const seconds =
    unit === "s" ? amount
    : unit === "m" ? amount * 60
    : unit === "h" ? amount * 3_600
    : amount * 86_400;
  if (seconds < 10) {
    throw new Error(`--check-interval must be at least 10 seconds (got ${seconds}s).`);
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
 * Run a shell script (via `bash -c`) and return true if it exited 0.
 * Stdout/stderr are captured to avoid leaking into the parent log; the
 * stop signal is purely the exit code.
 */
export function runScriptCheck(command: string): boolean {
  try {
    execSync(command, {
      shell: "/bin/bash",
      stdio: "pipe",
      timeout: 30_000, // 30s hard cap per check — protect cron from hangs
    });
    return true;
  } catch {
    return false;
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
  cancel  --id=<id>
  delete  --id=<id>
  check   (evaluate due reminders — called by cron)

Trigger types (pick exactly one per reminder):

  --at=<time>                  Fire at a wall-clock time. Time formats:
                                 "+30m", "+2h", "+1d", "+14d"  (relative)
                                 "14:00"                        (today, local)
                                 "2026-03-08 14:00"             (full local datetime)

  --when-reply-to=<thread-id>  Fire when an inbound email arrives in <thread-id>.
                               Optionally restrict with --from=<addr>.
                               Use 'email threads' to find thread ids.

  --when-script-ok=<cmd>       Fire when '<cmd>' exits 0. The command is run
                               under 'bash -c'. Checked every --check-interval
                               (default: 60s; minimum: 10s).

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
    --check-interval="30s" --prompt="Deploy ist live — Tests fahren"
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
    const id = flags["id"] || "";
    if (!id) die("--id is required");

    const existing = db.prepare("SELECT * FROM reminders WHERE id = ?").get(parseInt(id, 10)) as any;
    if (!existing) die(`Reminder #${id} not found`);
    if (existing.status !== "pending") die(`Reminder #${id} is already ${existing.status}`);

    db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ?").run(parseInt(id, 10));
    console.log(`Reminder #${id} cancelled: "${existing.title}"`);
    break;
  }

  case "delete": {
    const id = flags["id"] || "";
    if (!id) die("--id is required");

    const existing = db.prepare("SELECT * FROM reminders WHERE id = ?").get(parseInt(id, 10)) as any;
    if (!existing) die(`Reminder #${id} not found`);

    db.prepare("DELETE FROM reminders WHERE id = ?").run(parseInt(id, 10));
    console.log(`Reminder #${id} deleted: "${existing.title}"`);
    break;
  }

  case "check": {
    // Pull all pending reminders. Evaluate per trigger_type.
    const pending = db.prepare(`SELECT * FROM reminders WHERE status = 'pending'`).all() as any[];
    const emailDbDir = `${process.env.HOME}/.index/email`;

    const nowIso = toUtcStorage(new Date());
    const due: Array<{ reminder: any; reason: "fired" | "timeout" }> = [];

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

      let cfg: any = {};
      try { cfg = r.trigger_config ? JSON.parse(r.trigger_config) : {}; } catch {}

      if (triggerType === "email_reply") {
        const match = checkEmailReply(cfg.thread_id, cfg.from || null, r.created_at, emailDbDir);
        if (match) {
          due.push({ reminder: r, reason: "fired" });
        }
        continue;
      }

      if (triggerType === "script_check") {
        const interval = cfg.check_interval_seconds || 60;
        // Throttle: only run if last_checked_at + interval <= now
        if (r.last_checked_at) {
          const lastMs = new Date(r.last_checked_at.replace(" ", "T") + "Z").getTime();
          if (Date.now() - lastMs < interval * 1000) continue;
        }
        const ok = runScriptCheck(cfg.command);
        db.prepare(`UPDATE reminders SET last_checked_at = ? WHERE id = ?`).run(nowIso, r.id);
        if (ok) {
          due.push({ reminder: r, reason: "fired" });
        }
        continue;
      }

      // Unknown trigger_type — log and skip rather than crash
      console.warn(`[${new Date().toISOString()}] Reminder #${r.id} has unknown trigger_type '${triggerType}' — skipping.`);
    }

    if (due.length === 0) {
      console.log(`[${new Date().toISOString()}] No due reminders.`);
      break;
    }

    console.log(`[${new Date().toISOString()}] Found ${due.length} due reminder(s).`);

    for (const { reminder, reason } of due) {
      console.log(`[${new Date().toISOString()}] Firing reminder #${reminder.id}: "${reminder.title}" (reason=${reason})`);

      db.prepare(
        `UPDATE reminders SET status = 'fired', fired_at = datetime('now') WHERE id = ?`
      ).run(reminder.id);

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

      const promptText = `[Reminder #${reminder.id}: "${reminder.title}"]\n\n${reminder.prompt}${timeoutNote}\n\nIMPORTANT: After completing this task, write a brief note to today's journal (memory/journal/) documenting what you did and any messages you sent. This ensures other sessions (e.g. Signal) have context if the user replies.`;

      let proc;
      if (reminder.trigger_name) {
        const sessionKey = reminder.session_key || "_default";
        console.log(`[${new Date().toISOString()}] Reminder #${reminder.id}: routing to ${reminder.trigger_name}/${sessionKey}`);
        proc = Bun.spawn(
          ["/atlas/app/triggers/trigger.sh", reminder.trigger_name, promptText, sessionKey],
          {
            env: {
              ...process.env,
              ATLAS_REMINDER_ID: String(reminder.id),
              ATLAS_REMINDER_TITLE: reminder.title,
            },
            stdin: "ignore",
            stdout: "inherit",
            stderr: "inherit",
          }
        );
      } else {
        proc = Bun.spawn(
          ["/atlas/app/triggers/trigger-runner", "--direct", promptText, "--channel", channel],
          {
            env: {
              ...process.env,
              ATLAS_REMINDER_ID: String(reminder.id),
              ATLAS_REMINDER_TITLE: reminder.title,
            },
            stdin: "ignore",
            stdout: "inherit",
            stderr: "inherit",
          }
        );
      }

      console.log(`[${new Date().toISOString()}] Reminder #${reminder.id} spawned (pid=${proc.pid})`);
    }
    break;
  }

  default:
    die(`Unknown command '${command}'. Run with --help for usage.`);
}

} // end import.meta.main guard
