#!/usr/bin/env bun
/**
 * Reminder management CLI
 * Usage: bun /atlas/app/triggers/manage-reminders.ts <command> [flags]
 *
 * Commands:
 *   add     --title=<text> --at=<time> --prompt=<text> [--channel=internal]
 *   list    [--all]
 *   cancel  --id=<id>
 *   delete  --id=<id>
 *   check   (fire due reminders — called by cron)
 */

import { Database } from "bun:sqlite";
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
 * Parse a human-friendly time string into a UTC ISO 8601 datetime string.
 * Supported formats:
 *   - "+30m", "+2h", "+1d"  — relative offsets
 *   - "14:00"               — today at given time (local)
 *   - "2026-03-08 14:00"    — full date + time (local)
 *   - "2026-03-08T14:00:00" — ISO-style (local)
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
    // If the time has already passed today, don't auto-advance to tomorrow — just use as-is
    return toUtcStorage(target);
  }

  // Full datetime: "2026-03-08 14:00" or "2026-03-08T14:00:00" (treat as local time)
  const fullMatch = at.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2}(?::\d{2})?)$/);
  if (fullMatch) {
    // Parse as local time by using Date constructor with local-timezone interpretation
    const parsed = new Date(`${fullMatch[1]}T${fullMatch[2]}:00`);
    if (isNaN(parsed.getTime())) die(`Cannot parse date/time: ${at}`);
    return toUtcStorage(parsed);
  }

  die(`Unrecognized --at format: "${at}". Use "+30m", "+2h", "+1d", "14:00", "2026-03-08 14:00", or "2026-03-08T14:00:00"`);
}

/** Convert a Date to the UTC storage format: "YYYY-MM-DD HH:MM:SS" */
function toUtcStorage(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/** Convert a UTC storage string to local time string for display */
function toLocalDisplay(utcStr: string): string {
  // SQLite stores as "YYYY-MM-DD HH:MM:SS" (UTC)
  const d = new Date(utcStr.replace(" ", "T") + "Z");
  return d.toLocaleString();
}

function printTable(reminders: any[]): void {
  if (reminders.length === 0) {
    console.log("No reminders found.");
    return;
  }
  const cols = ["id", "title", "fire_at (local)", "channel", "session", "status"];
  const rows = reminders.map((r) => ({
    id: String(r.id),
    title: r.title,
    "fire_at (local)": toLocalDisplay(r.fire_at),
    channel: r.channel ?? "internal",
    session: r.trigger_name ? `${r.trigger_name}/${r.session_key || "_default"}` : "ephemeral",
    status: r.status,
  }));

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

// --- Main ---

const argv = Bun.argv.slice(2);
const command = argv[0];

if (!command || command === "--help" || command === "-h") {
  console.log(`Usage: bun /atlas/app/triggers/manage-reminders.ts <command> [flags]

Commands:
  add     --title=<text> --at=<time> --prompt=<text> [--channel=internal] [--new-session]
  list    [--all]
  cancel  --id=<id>
  delete  --id=<id>
  check   (fire due reminders — called by cron)

Time formats for --at:
  "+30m", "+2h", "+1d"           relative offset
  "14:00"                         today at given time
  "2026-03-08 14:00"              specific date + time (local timezone)
  "2026-03-08T14:00:00"           ISO-style (local timezone)

Session routing:
  By default, reminders fire into the same session that created them
  (e.g., a Signal reminder wakes the Signal session).
  Use --new-session to force a standalone ephemeral session instead.`);
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

// Migration: add trigger_name and session_key columns to existing tables
try { db.run("ALTER TABLE reminders ADD COLUMN trigger_name TEXT"); } catch {}
try { db.run("ALTER TABLE reminders ADD COLUMN session_key TEXT"); } catch {}

switch (command) {
  case "add": {
    const title = flags["title"] || "";
    const at = flags["at"] || "";
    const prompt = flags["prompt"] || "";
    const channel = flags["channel"] || "internal";
    const newSession = flags["new-session"] === "true";

    if (!title) die("--title is required");
    if (!at) die("--at is required");
    if (!prompt) die("--prompt is required");

    const fireAt = parseAt(at);
    const fireAtLocal = toLocalDisplay(fireAt);

    // Capture trigger context from environment (set by trigger-runner)
    // so the reminder fires into the same session that created it.
    // --new-session forces an ephemeral session (ignores trigger context).
    const triggerName = newSession ? null : (process.env.ATLAS_TRIGGER || null);
    const sessionKey = newSession ? null : (process.env.ATLAS_TRIGGER_SESSION_KEY || null);

    const result = db.prepare(
      `INSERT INTO reminders (title, prompt, fire_at, channel, trigger_name, session_key) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(title, prompt, fireAt, channel, triggerName, sessionKey);

    const id = result.lastInsertRowid;
    console.log(`Reminder #${id} scheduled: "${title}"`);
    console.log(`  Fire at: ${fireAtLocal}`);
    console.log(`  Channel: ${channel}`);
    if (triggerName) {
      console.log(`  Session: ${triggerName}/${sessionKey || "_default"} (will resume originating session)`);
    } else {
      console.log(`  Session: new ephemeral session`);
    }
    break;
  }

  case "list": {
    const showAll = flags["all"] === "true";
    const sql = showAll
      ? "SELECT * FROM reminders ORDER BY fire_at DESC"
      : "SELECT * FROM reminders WHERE status = 'pending' ORDER BY fire_at ASC";
    const reminders = db.prepare(sql).all() as any[];
    printTable(reminders);
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
    const due = db.prepare(
      `SELECT * FROM reminders WHERE status = 'pending' AND fire_at <= datetime('now')`
    ).all() as any[];

    if (due.length === 0) {
      console.log(`[${new Date().toISOString()}] No due reminders.`);
      break;
    }

    console.log(`[${new Date().toISOString()}] Found ${due.length} due reminder(s).`);

    for (const reminder of due) {
      console.log(`[${new Date().toISOString()}] Firing reminder #${reminder.id}: "${reminder.title}"`);

      // Mark as fired immediately to prevent double-firing if cron overlaps
      db.prepare(
        `UPDATE reminders SET status = 'fired', fired_at = datetime('now') WHERE id = ?`
      ).run(reminder.id);

      const channel = reminder.channel || "internal";

      // Wrap the user's prompt with reminder context and memory instructions
      const promptText = `[Reminder #${reminder.id}: "${reminder.title}"]\n\n${reminder.prompt}\n\nIMPORTANT: After completing this task, write a brief note to today's journal (memory/journal/) documenting what you did and any messages you sent. This ensures other sessions (e.g. Signal) have context if the user replies.`;

      let proc;
      if (reminder.trigger_name) {
        // Fire into the originating session via trigger.sh
        // This resumes or injects into the same session that created the reminder
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
        // No trigger context — spawn ephemeral session (original behavior)
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

      // Fire-and-forget: log the PID but don't await
      console.log(`[${new Date().toISOString()}] Reminder #${reminder.id} spawned (pid=${proc.pid})`);
    }
    break;
  }

  default:
    die(`Unknown command '${command}'. Run with --help for usage.`);
}
