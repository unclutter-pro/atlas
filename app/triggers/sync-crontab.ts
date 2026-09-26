#!/usr/bin/env bun
/**
 * Sync crontab from database triggers + static defaults.
 * Run after any trigger create/update/delete.
 * Writes in place so supercronic's -inotify watch survives and reloads.
 */
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { openDb } from "../lib/db.ts";
import { resolveTimezone } from "../lib/timezone.ts";
const CRONTAB_OUT = process.env.HOME + "/crontab";
const STATIC_CRONTAB = "/atlas/app/defaults/crontab";
const MARKER = "# === AUTO-GENERATED TRIGGERS (do not edit below) ===";
// supercronic (aptible/supercronic) honors a CRON_TZ=<zone> line in the
// crontab for scheduling — the same convention as robfig/cron and Vixie
// cron's CRON_TZ. It matters when the resolved Atlas zone differs from the
// container's own TZ env (Dockerfile/docker-compose default to
// Europe/Berlin): without it, cron lines schedule in the container zone
// regardless of what config.yml/ATLAS_TIMEZONE says. It affects scheduling
// only, not the fired process's own environment — trigger-runner sets its
// own TZ from the same resolveTimezone() at startup for that.
const CRON_TZ_RE = /^\s*CRON_TZ\s*=/m;

// Read static crontab (everything above the marker, or the whole file)
let staticPart = "";
try {
  const existing = readFileSync(CRONTAB_OUT, "utf-8");
  const markerIdx = existing.indexOf(MARKER);
  staticPart = markerIdx >= 0 ? existing.slice(0, markerIdx).trimEnd() : existing.trimEnd();
} catch {
  // No existing crontab — use defaults
  try {
    staticPart = readFileSync(STATIC_CRONTAB, "utf-8").trimEnd();
  } catch {
    staticPart = `# ${process.env.AGENT_NAME || "Atlas"} Crontab (supercronic)`;
  }
}

// Read enabled cron triggers from DB
let cronLines: string[] = [];
try {
  const db = openDb({ readonly: true });
  const triggers = db.prepare(
    "SELECT name, schedule FROM triggers WHERE type = 'cron' AND enabled = 1 AND schedule IS NOT NULL"
  ).all() as { name: string; schedule: string }[];

  cronLines = triggers
    .filter(t => /^[a-z0-9_-]+$/.test(t.name) && /^[\d\s*\/,-]+$/.test(t.schedule))
    .map(t => `${t.schedule}  /atlas/app/triggers/trigger.sh ${t.name}`);
  db.close();
} catch (err) {
  console.error("Warning: could not read triggers from DB:", err);
}

// Resolve the Atlas zone and warn (not fail) on an invalid explicit value —
// the crontab still gets written, just with the runtime/UTC fallback.
const tz = resolveTimezone(process.env.HOME);
if (tz.invalid) {
  console.warn(`Warning: invalid timezone "${tz.invalid}" (source: ${tz.source}) — scheduling with ${tz.timeZone} instead.`);
}

// Write combined crontab. CRON_TZ goes first so it applies to the static
// part too, unless that part already sets its own (a user-authored line
// above the marker wins).
const parts = CRON_TZ_RE.test(staticPart) ? [] : [`CRON_TZ=${tz.timeZone}`, ""];
parts.push(staticPart, "", MARKER);
if (cronLines.length > 0) {
  parts.push(...cronLines);
} else {
  parts.push("# (no cron triggers configured)");
}
parts.push("");

writeFileSync(CRONTAB_OUT, parts.join("\n"));
console.log(`Crontab synced: ${cronLines.length} cron trigger(s), CRON_TZ=${tz.timeZone}`);
