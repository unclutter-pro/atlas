#!/usr/bin/env bun
/**
 * Dev seed: build an isolated Atlas HOME with a fresh DB and realistic data.
 *
 *   bun dev/seed.ts /tmp/atlas-dev
 *   HOME=/tmp/atlas-dev ATLAS_SUPERVISORCTL_STATUS_FILE=/tmp/atlas-dev/.dev/supervisorctl-status.txt PORT=3100 bun server.ts
 *
 * Never point this at a real HOME: the target's .index/atlas.db and seeded
 * files are overwritten. A non-empty directory without the seed marker is
 * refused unless --force is passed.
 *
 * Fixtures are relative to "now", so re-seed to get fresh "today" numbers.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { responseCost } from "../../lib/harness/claude-pricing";

const args = process.argv.slice(2);
const force = args.includes("--force");
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  console.error("usage: bun dev/seed.ts <dir> [--force]");
  process.exit(1);
}
const HOME = resolve(target);
const MARKER = join(HOME, ".atlas-dev-seed");

if (HOME === resolve(homedir()) || HOME === resolve(process.env.HOME ?? "")) {
  console.error(`Refusing to seed your real HOME (${HOME}).`);
  process.exit(1);
}
if (existsSync(HOME) && readdirSync(HOME).length > 0 && !existsSync(MARKER) && !force) {
  console.error(`${HOME} is not empty and was not created by this script. Pass --force to seed anyway.`);
  process.exit(1);
}

// Re-seed: drop what a previous run created so dated fixtures don't pile up.
if (existsSync(MARKER)) {
  for (const d of ["memory", "triggers", ".claude/projects", "secrets", "supervisor.d", ".dev"]) rmSync(join(HOME, d), { recursive: true, force: true });
  rmSync(join(HOME, ".atlas-paused"), { force: true });
}
mkdirSync(join(HOME, ".index"), { recursive: true });
for (const f of ["atlas.db", "atlas.db-wal", "atlas.db-shm"]) rmSync(join(HOME, ".index", f), { force: true });
writeFileSync(MARKER, new Date().toISOString());

// lib/atlas-db resolves the DB path from HOME at import time.
process.env.HOME = HOME;
const { getDb } = await import("../../lib/atlas-db");
const db = getDb();

// Columns the reminder CLI (triggers/manage-reminders.ts) adds on first use in the container.
for (const col of [
  "trigger_name TEXT",
  "session_key TEXT",
  "recurring_interval_seconds INTEGER",
  "trigger_type TEXT DEFAULT 'time'",
  "trigger_config TEXT",
  "timeout_at TEXT",
  "idempotency_hash TEXT",
  "last_checked_at TEXT",
  "wake_attempts INTEGER DEFAULT 0",
]) {
  try {
    db.run(`ALTER TABLE reminders ADD COLUMN ${col}`);
  } catch {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
const between = (a: number, b: number) => a + rand() * (b - a);

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** SQLite datetime('now') format (UTC, no zone). */
const sqlTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
/** trigger-runner isoNow() format. */
const isoTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const dateStr = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const uuid = () => crypto.randomUUID();

function write(rel: string, content: string) {
  const p = join(HOME, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

interface TriggerFixture {
  name: string;
  type: "cron" | "webhook" | "manual";
  description: string;
  channel: string;
  schedule?: string;
  webhook_secret?: string;
  prompt: string;
  session_mode: "ephemeral" | "persistent";
  model_key?: string;
  enabled?: boolean;
}

const TRIGGERS: TriggerFixture[] = [
  { name: "daily-digest", type: "cron", description: "Morning summary of inbox, calendar and open tasks", channel: "signal", schedule: "0 7 * * *", prompt: "Summarize yesterday's inbox, today's calendar and open tasks. Send the digest via signal.", session_mode: "ephemeral" },
  { name: "inbox-sweep", type: "cron", description: "Check email for anything urgent", channel: "internal", schedule: "*/30 * * * *", prompt: "", session_mode: "ephemeral", model_key: "haiku" },
  { name: "dreaming", type: "cron", description: "Nightly memory consolidation", channel: "internal", schedule: "0 3 * * *", prompt: "", session_mode: "ephemeral", model_key: "opus" },
  { name: "weekly-review", type: "cron", description: "Weekly project review", channel: "email", schedule: "0 9 * * 1", prompt: "Review all active projects in memory/projects and email a status report.", session_mode: "ephemeral", enabled: false },
  { name: "github-events", type: "webhook", description: "GitHub push and PR events", channel: "internal", webhook_secret: "dev-secret-123", prompt: "A GitHub event arrived:\n\n{{payload}}\n\nTriage it. Only notify me for failing CI on main.", session_mode: "ephemeral" },
  { name: "deploy-hook", type: "webhook", description: "Deploy notifications from CI", channel: "signal", prompt: "Deployment event: {{payload}}", session_mode: "persistent" },
  { name: "signal-chat", type: "manual", description: "Signal messenger conversations", channel: "signal", prompt: "", session_mode: "persistent" },
  { name: "email-handler", type: "webhook", description: "Email conversations (IMAP)", channel: "email", prompt: "{{payload}}", session_mode: "persistent" },
  { name: "web-chat", type: "manual", description: "Web UI chat message handler", channel: "web", prompt: "", session_mode: "persistent" },
  { name: "whatsapp-chat", type: "webhook", description: "WhatsApp messenger conversations", channel: "whatsapp", prompt: "", session_mode: "persistent" },
  { name: "research", type: "manual", description: "Ad-hoc deep research task", channel: "internal", prompt: "Research the topic in the payload and write findings to memory/notes/.\n\n{{payload}}", session_mode: "ephemeral" },
];

const insTrigger = db.prepare(
  `INSERT INTO triggers (name, type, description, channel, schedule, webhook_secret, prompt, session_mode, model_key, enabled, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
for (const t of TRIGGERS) {
  insTrigger.run(t.name, t.type, t.description, t.channel, t.schedule ?? null, t.webhook_secret ?? null, t.prompt, t.session_mode, t.model_key ?? null, t.enabled === false ? 0 : 1, sqlTime(NOW - 40 * DAY));
}
write("triggers/inbox-sweep/prompt.md", "Check the inbox (`email list --unread`). Flag anything urgent via signal. Ignore newsletters.\n");
write("triggers/dreaming/prompt.md", "Consolidate today's journal into MEMORY.md and topic files. Remove stale facts.\n");
write("triggers/signal-chat/prompt.md", '<message from="{{sender}}">\n{{payload}}\n</message>\n\nPlease respond directly using `signal send "{{sender}}" "..."`.\n');
write("triggers/web-chat/prompt.md", 'New web UI message:\n\n{{payload}}\n\nReply to the user\'s "message" field conversationally.\n');

// ---------------------------------------------------------------------------
// Runs, metrics, messages, transcripts
// ---------------------------------------------------------------------------

const insRun = db.prepare(
  `INSERT INTO trigger_runs (trigger_name, session_key, session_mode, session_id, payload, started_at, completed_at)
   VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
);
const insMetric = db.prepare(
  `INSERT INTO session_metrics (session_type, session_id, trigger_name, started_at, ended_at, duration_ms,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, num_turns, is_error, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const insMessage = db.prepare(`INSERT INTO messages (channel, sender, content, created_at, session_key) VALUES (?, ?, ?, ?, ?) RETURNING id`);
const upsertSession = db.prepare(
  `INSERT INTO trigger_sessions (trigger_name, session_key, session_id, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(trigger_name, session_key) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
);

const SIGNAL_CONTACTS = [
  { number: "+491701234567", name: "Max" },
  { number: "+491759876543", name: "Lena" },
];
const SIGNAL_TEXTS = [
  "Can you move my 3pm call with the bank to tomorrow?",
  "What's on my calendar this week?",
  "Remind me to renew the domain before Friday",
  "Summarize the thread with Jonas about the offsite",
  "Did the invoice from Hetzner arrive?",
  "Book a table for 4 on Saturday, somewhere near Kreuzberg",
];
const EMAILS = [
  { from: "jonas@example.com", subject: "Offsite planning", body: "Hi, can we lock the dates for the offsite? Oct 14-16 works for most." },
  { from: "billing@hetzner.com", subject: "Invoice 2026-09", body: "Your invoice for September is available." },
  { from: "anna@customer.io", subject: "Contract renewal", body: "Please send the updated contract draft by Thursday." },
];
const WEB_TEXTS = ["Draft a reply to Anna about the contract", "What did we decide about the SQLite migration?", "List my open tasks"];
const ERRORS = [
  "Error: signal-cli exited with code 1 (rate limited)",
  "API Error: 529 overloaded_error",
  "Tool Bash failed: email: IMAP login failed (AUTHENTICATIONFAILED)",
  "Session exceeded max turns (60)",
];

interface RunPlan {
  trigger: string;
  startMs: number;
  durationMs: number;
  running?: boolean;
  error?: boolean;
  noSessionYet?: boolean;
}

const plans: RunPlan[] = [];
// 10 days of history, ~4 runs/day
for (let d = 9; d >= 0; d--) {
  const dayStart = NOW - d * DAY - (NOW % DAY); // UTC midnight of that day
  const add = (trigger: string, hour: number, dur: [number, number]) => {
    const start = dayStart + hour * HOUR + Math.floor(between(0, 50)) * MIN;
    if (start < NOW - 5 * MIN) plans.push({ trigger, startMs: start, durationMs: Math.floor(between(dur[0], dur[1])) });
  };
  add("daily-digest", 5, [40_000, 140_000]);
  add("dreaming", 1, [180_000, 600_000]);
  if (rand() < 0.8) add("signal-chat", Math.floor(between(8, 20)), [15_000, 90_000]);
  if (rand() < 0.5) add("email-handler", Math.floor(between(9, 17)), [20_000, 120_000]);
  if (rand() < 0.35) add(pick(["github-events", "deploy-hook", "web-chat", "research", "inbox-sweep"]), Math.floor(between(8, 22)), [10_000, 400_000]);
}
// Guaranteed variety: web chat, frequent cheap cron runs today, a failing webhook
plans.push({ trigger: "web-chat", startMs: NOW - DAY - 3 * HOUR, durationMs: 42_000 });
plans.push({ trigger: "web-chat", startMs: NOW - 2 * HOUR, durationMs: 65_000 });
for (let i = 1; i <= 5; i++) plans.push({ trigger: "inbox-sweep", startMs: NOW - i * 30 * MIN, durationMs: Math.floor(between(8_000, 25_000)) });
plans.push({ trigger: "github-events", startMs: NOW - 5 * HOUR, durationMs: 31_000, error: true });
// A few failures
for (const idx of [3, 11, 19, 27]) if (plans[idx]) plans[idx]!.error = true;
// Currently running
plans.push({ trigger: "research", startMs: NOW - 7 * MIN, durationMs: 0, running: true });
plans.push({ trigger: "signal-chat", startMs: NOW - 40_000, durationMs: 0, running: true, noSessionYet: true });
plans.sort((a, b) => a.startMs - b.startMs);

const triggerModel = (name: string) => TRIGGERS.find((t) => t.name === name)?.model_key ?? (TRIGGERS.find((t) => t.name === name)?.type === "cron" ? "sonnet" : "opus");

const runCounts = new Map<string, { count: number; last: number }>();
let seededRuns = 0;
let transcripts = 0;

for (const plan of plans) {
  const t = TRIGGERS.find((x) => x.name === plan.trigger)!;
  const sessionId = plan.noSessionYet ? null : uuid();
  let sessionKey = "_default";
  let payload: string | null = null;
  let userText = t.prompt || `Run trigger ${t.name}`;

  if (t.name === "signal-chat") {
    const c = pick(SIGNAL_CONTACTS);
    const text = pick(SIGNAL_TEXTS);
    sessionKey = c.number;
    const msgId = (insMessage.get("signal", c.number, text, sqlTime(plan.startMs - 2000), c.number) as { id: number }).id;
    payload = `<signal-message from="${c.number}" name="${c.name}" at="${isoTime(plan.startMs - 2000)}" inbox-id="${msgId}">\n  ${text}\n</signal-message>`;
    userText = payload;
  } else if (t.name === "email-handler") {
    const e = pick(EMAILS);
    sessionKey = e.from;
    insMessage.get("email", e.from, `Subject: ${e.subject}\n\n${e.body}`, sqlTime(plan.startMs - 5000), e.from);
    payload = JSON.stringify({ from: e.from, subject: e.subject, body: e.body, message_id: `<${uuid()}@mail>` });
    userText = payload;
  } else if (t.name === "web-chat") {
    const text = pick(WEB_TEXTS);
    insMessage.get("web", "user", text, sqlTime(plan.startMs - 1000), "_default");
    payload = JSON.stringify({ message: text });
    userText = payload;
  } else if (t.type === "webhook") {
    payload = t.name === "github-events"
      ? JSON.stringify({ action: pick(["push", "pull_request.opened", "check_suite.completed"]), repository: "unclutter-pro/atlas", ref: "refs/heads/master", conclusion: pick(["success", "failure"]) })
      : JSON.stringify({ service: "api", environment: "production", status: pick(["succeeded", "failed"]), version: `v1.${Math.floor(between(20, 40))}.0` });
    userText = t.prompt.replace("{{payload}}", payload);
  } else if (t.name === "research") {
    payload = pick(["Compare SQLite FTS5 vs. tantivy for memory search", "Summarize the EU AI Act obligations for agent products"]);
    userText = t.prompt.replace("{{payload}}", payload);
  }

  const started = sqlTime(plan.startMs);
  const completed = plan.running ? null : sqlTime(plan.startMs + plan.durationMs);
  const runId = (insRun.get(t.name, sessionKey, t.session_mode, sessionId, payload, started, completed) as { id: number }).id;
  // Webhook runs without an explicit key get a synthetic one (see trigger-runner).
  if (t.type === "webhook" && t.name !== "email-handler" && t.name !== "whatsapp-chat") {
    sessionKey = `webhook-${runId}`;
    db.run("UPDATE trigger_runs SET session_key = ? WHERE id = ?", [sessionKey, runId]);
  }
  seededRuns++;

  const rc = runCounts.get(t.name) ?? { count: 0, last: 0 };
  runCounts.set(t.name, { count: rc.count + 1, last: plan.startMs });
  if (sessionId && t.session_mode === "persistent") upsertSession.run(t.name, sessionKey, sessionId, started);
  if (plan.running || !sessionId) continue;

  const model = triggerModel(t.name);
  const modelId = `claude-${model}`;
  const turns = Math.max(1, Math.round(plan.durationMs / 12_000));
  const input = Math.round(between(800, 4000) * turns);
  const output = Math.round(between(150, 900) * turns);
  const cacheRead = Math.round(between(8_000, 30_000) * turns);
  const cacheCreate = Math.round(between(2_000, 12_000));
  const cost = responseCost(modelId, {
    input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate,
  });
  insMetric.run("trigger", sessionId, t.name, isoTime(plan.startMs), isoTime(plan.startMs + plan.durationMs), plan.durationMs, input, output, cacheRead, cacheCreate, Number(cost.toFixed(6)), turns, plan.error ? 1 : 0, sqlTime(plan.startMs + plan.durationMs));

  writeTranscript(sessionId, plan, userText, plan.error ? pick(ERRORS) : null);
  transcripts++;
}

const updTrigger = db.prepare("UPDATE triggers SET run_count = ?, last_run = ? WHERE name = ?");
for (const [name, rc] of runCounts) updTrigger.run(rc.count, sqlTime(rc.last), name);

// Direct (non-trigger) sessions, e.g. `claude` in a terminal
for (let i = 0; i < 3; i++) {
  const start = NOW - Math.floor(between(1, 8)) * DAY;
  const dur = Math.floor(between(60_000, 900_000));
  insMetric.run("direct", uuid(), null, isoTime(start), isoTime(start + dur), dur, 12000, 3400, 88000, 9000, Number(between(0.2, 1.4).toFixed(4)), 14, 0, sqlTime(start + dur));
}

// Runs of a trigger that was deleted afterwards: the LEFT JOIN in ui-api/usage
// finds no row, so these classify as "other" while sharing a NULL triggers.type
// with the direct sessions above.
for (let i = 0; i < 2; i++) {
  const start = NOW - Math.floor(between(1, 8)) * DAY;
  const dur = Math.floor(between(60_000, 900_000));
  insMetric.run("trigger", uuid(), "retired-digest", isoTime(start), isoTime(start + dur), dur, 9000, 2100, 44000, 6000, Number(between(0.1, 0.8).toFixed(4)), 9, 0, sqlTime(start + dur));
}

// Messages injected into an already-running session (no run of their own)
insMessage.get("signal", "+491701234567", "Also: add the Hetzner invoice to the accounting folder", sqlTime(NOW - 20_000), "+491701234567");
insMessage.get("whatsapp", "+4915112345678", "Are we still on for lunch tomorrow?", sqlTime(NOW - 3 * HOUR), "+4915112345678");

function writeTranscript(sessionId: string, plan: RunPlan, userText: string, error: string | null) {
  const ts = (off: number) => new Date(plan.startMs + off).toISOString();
  const step = plan.durationMs / 5;
  const toolId = `toolu_${uuid().replace(/-/g, "").slice(0, 20)}`;
  const lines: unknown[] = [
    { type: "user", sessionId, timestamp: ts(0), uuid: uuid(), message: { role: "user", content: userText } },
    {
      type: "assistant",
      sessionId,
      timestamp: ts(step),
      uuid: uuid(),
      message: {
        id: `msg_${uuid().slice(0, 8)}`,
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [
          { type: "thinking", thinking: "Let me check the relevant context first." },
          { type: "text", text: "Checking the current state." },
          { type: "tool_use", id: toolId, name: "Bash", input: { command: plan.trigger === "signal-chat" ? "signal history +491701234567 --limit 5" : "email list --unread --limit 10" } },
        ],
        usage: { input_tokens: 1200, output_tokens: 180, cache_read_input_tokens: 14000 },
      },
    },
    {
      type: "user",
      sessionId,
      timestamp: ts(step * 2),
      uuid: uuid(),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: error ?? "3 unread messages:\n- Jonas: Offsite planning\n- Hetzner: Invoice 2026-09\n- Anna: Contract renewal", is_error: !!error }] },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: ts(step * 4),
      uuid: uuid(),
      message: {
        id: `msg_${uuid().slice(0, 8)}`,
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: error ? `I couldn't finish: ${error}` : "Done. I sent a short summary and noted the follow-ups in today's journal." }],
        usage: { input_tokens: 400, output_tokens: 90, cache_read_input_tokens: 15500 },
      },
    },
  ];
  write(`.claude/projects/-home-agent/${sessionId}.jsonl`, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// Web chat sessions list
db.run("INSERT OR IGNORE INTO chat_sessions (session_key, channel, title, created_at, updated_at) VALUES ('ops-questions', 'web', 'Ops questions', ?, ?)", [sqlTime(NOW - 3 * DAY), sqlTime(NOW - 2 * DAY)]);

// ---------------------------------------------------------------------------
// Reminders, webhook queue
// ---------------------------------------------------------------------------

const insReminder = db.prepare(
  `INSERT INTO reminders (title, prompt, fire_at, channel, status, created_at, fired_at, trigger_name, session_key, trigger_type, trigger_config)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
insReminder.run("Renew atlas.dev domain", "Remind Max to renew the atlas.dev domain (expires Friday).", sqlTime(NOW + 2 * HOUR), "signal", "pending", sqlTime(NOW - DAY), null, "signal-chat", "+491701234567", "time", null);
insReminder.run("Follow up with Anna", "Check whether Anna replied about the contract; if not, draft a nudge.", sqlTime(NOW + 26 * HOUR), "email", "pending", sqlTime(NOW - 2 * DAY), null, "email-handler", "anna@customer.io", "time", null);
insReminder.run("Offsite dates reply", "When Jonas replies, confirm the offsite dates.", "9999-12-31 23:59:59", "email", "pending", sqlTime(NOW - 5 * HOUR), null, "email-handler", "jonas@example.com", "reply", JSON.stringify({ reply_to: "jonas@example.com" }));
insReminder.run("Weekly backup check", "Verify last night's backup completed.", sqlTime(NOW + 4 * DAY), "internal", "pending", sqlTime(NOW - 3 * DAY), null, null, null, "time", null);
insReminder.run("Call the bank", "Remind Max to call the bank about the transfer limit.", sqlTime(NOW - DAY), "signal", "fired", sqlTime(NOW - 3 * DAY), sqlTime(NOW - DAY), "signal-chat", "+491701234567", "time", null);
insReminder.run("Old idea", "Ping about the conference CFP.", sqlTime(NOW - 4 * DAY), "internal", "cancelled", sqlTime(NOW - 6 * DAY), null, null, null, "time", null);

db.run(
  `INSERT INTO webhook_queue (url, payload, secret, attempts, last_error, created_at, next_retry_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [
    "https://usage.example.com/atlas",
    JSON.stringify({ event: "session.completed", trigger: "daily-digest", cost_usd: 0.42 }),
    "whsec_dev",
    3,
    "HTTP 502 Bad Gateway",
    sqlTime(NOW - 6 * HOUR),
    sqlTime(NOW + 30 * MIN),
  ],
);

// ---------------------------------------------------------------------------
// Workspace files
// ---------------------------------------------------------------------------

write(
  "config.yml",
  `agent:
  name: "Atlas"
  email: "atlas@example.com"

models:
  main: sonnet
  trigger: opus
  cron: sonnet

signal:
  number: "+491700000000"
  whitelist: ["+491701234567", "+491759876543"]

email:
  imap_host: imap.example.com
  smtp_host: smtp.example.com
  username: atlas@example.com
  whitelist: ["*@example.com", "anna@customer.io"]

daily_cleanup:
  retention_days: 30

usage_reporting:
  enabled: true
  webhook_url: https://usage.example.com/atlas
`,
);
write(".atlas-runtime-config.json", JSON.stringify({ models: { cron: "haiku" } }, null, 2) + "\n");
write(
  "IDENTITY.md",
  `# Atlas

You are Atlas, Max's autonomous assistant. You run in a container and handle
email, Signal and scheduled work on your own.

- Language: English with Max, German with German contacts
- Timezone: Europe/Berlin
`,
);
write(
  "SOUL.md",
  `# Soul

Be direct and brief. Prefer doing over asking when the action is reversible.
Never send money or sign anything without explicit confirmation.
`,
);
write(
  "user-extensions.sh",
  `#!/bin/bash
# User Extensions — runs on every container start.
brew install ripgrep jq
pip install --quiet python-dateutil
`,
);
write("secrets/email-password", "dev-password\n");
write("secrets/github-token", "ghp_dev_token\n");
write("secrets/openai-api-key", "sk-dev\n");

write(
  "memory/MEMORY.md",
  `# Memory

## People
- **Max** — owner. Prefers Signal for anything urgent, email for long form.
- **Jonas** — co-founder, organizes the offsite. See [entities/jonas](entities/jonas.md).
- **Anna** (customer.io) — contract renewal due end of September.

## Active projects
- Atlas web UI rewrite (React + Bun) — see projects/atlas-web-ui.md
- Offsite Oct 14–16, Lisbon (dates pending confirmation)

## Preferences
- Daily digest at 07:00, max 10 bullet points
- Never schedule meetings before 10:00
`,
);
write("memory/projects/atlas-web-ui.md", "# Atlas web UI\n\nMigrating HTMX pages to React. New IA: Overview, Activity, Automations, Knowledge, Usage, Settings.\n\n## Decisions\n- No Hono in new code\n- Single binary via bun build --compile\n");
write("memory/entities/jonas.md", "# Jonas\n\nCo-founder. Email jonas@example.com. Handles finance and events.\n");
write("memory/decisions/2026-09-sqlite-fts.md", "# Use SQLite FTS5 for memory search\n\nDate: 2026-09-10\n\nChosen over tantivy: no extra service, good enough for <100k docs.\n");
write("memory/workflows/deploy.md", "# Deploy workflow\n\n1. Merge to master\n2. CI builds the image\n3. deploy-hook webhook notifies Atlas\n");
write("memory/notes/ideas.md", "# Ideas\n\n- Voice notes → journal\n- Weekly cost report via email\n");
for (let d = 0; d < 7; d++) {
  if (d === 2) continue; // a gap in the journal
  const date = dateStr(NOW - d * DAY);
  write(
    `memory/journal/${date}.md`,
    `# ${date}\n\n## Morning\n- Sent daily digest (${Math.floor(between(4, 10))} items)\n- Triaged ${Math.floor(between(2, 9))} emails\n\n## Afternoon\n- ${pick(["Helped Max draft the contract reply", "Researched FTS options", "Moved the bank call", "Booked the restaurant"])}\n`,
  );
}
// Legacy location (memory/YYYY-MM-DD.md) still read by the old /journal page
write(`memory/${dateStr(NOW - 12 * DAY)}.md`, `# ${dateStr(NOW - 12 * DAY)}\n\nLegacy-location journal entry.\n`);

// Supervisor: signal + email installed; fake status for local dev
write("supervisor.d/signal.conf", "[program:signal-daemon]\ncommand=python3 /atlas/app/integrations/signal/signal-daemon-start.py\n\n[program:signal-listen]\ncommand=/atlas/app/bin/signal listen\n");
write("supervisor.d/email-poller.conf", "[program:email-poller]\ncommand=/atlas/app/bin/email poll\n");
write(
  ".dev/supervisorctl-status.txt",
  [
    "email-poller                     FATAL     Exited too quickly (process log may have details)",
    "init                             EXITED    Sep 21 07:00 AM",
    "metrics                          RUNNING   pid 41, uptime 2 days, 3:12:40",
    "nginx                            RUNNING   pid 40, uptime 2 days, 3:12:40",
    "signal-daemon                    RUNNING   pid 88, uptime 2 days, 3:12:30",
    "signal-listen                    RUNNING   pid 90, uptime 2 days, 3:12:30",
    "supercronic                      RUNNING   pid 77, uptime 2 days, 3:12:35",
    "web-ui                           RUNNING   pid 52, uptime 2 days, 3:12:38",
  ].join("\n") + "\n",
);

console.log(`Seeded ${HOME}
  ${TRIGGERS.length} triggers, ${seededRuns} runs (${plans.filter((p) => p.running).length} running, ${plans.filter((p) => p.error).length} failed), ${transcripts} transcripts
  messages, reminders, webhook_queue, memory, journal, config, secrets

Run:
  HOME=${HOME} ATLAS_SUPERVISORCTL_STATUS_FILE=${HOME}/.dev/supervisorctl-status.txt PORT=3100 bun server.ts`);
