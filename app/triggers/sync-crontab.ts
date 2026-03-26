#!/usr/bin/env bun
/**
 * Sync crontab from database triggers + static defaults.
 * Run after any trigger create/update/delete.
 * supercronic auto-detects file changes.
 */
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { openDb } from "../lib/db.ts";
const CRONTAB_OUT = process.env.HOME + "/crontab";
const STATIC_CRONTAB = "/atlas/app/defaults/crontab";
const MARKER = "# === AUTO-GENERATED TRIGGERS (do not edit below) ===";

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

// Write combined crontab
const parts = [staticPart, "", MARKER];
if (cronLines.length > 0) {
  parts.push(...cronLines);
} else {
  parts.push("# (no cron triggers configured)");
}
parts.push("");

writeFileSync(CRONTAB_OUT, parts.join("\n"));
console.log(`Crontab synced: ${cronLines.length} cron trigger(s)`);
