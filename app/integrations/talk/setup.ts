import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TalkConfig } from "./config.ts";

const MARKER = "# managed by Atlas (Nextcloud Talk)";

/** Called at container startup and by `talk setup`; credentials stay in their file. */
export function provisionTalk(config: TalkConfig | null, home: string, db: Database, appRoot = "/atlas/app"): void {
  const path = join(home, "supervisor.d/talk.conf");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (!config) {
    if (existing?.startsWith(MARKER)) unlinkSync(path);
    return;
  }
  const trigger = config.workerTrigger;
  if (!/^[a-zA-Z0-9_-]+$/.test(trigger)) throw new Error("Invalid talk.worker_trigger");
  const row = db.query("SELECT channel, session_mode FROM triggers WHERE name = ?").get(trigger) as { channel: string; session_mode: string } | null;
  if (row && (row.channel !== "talk" || row.session_mode !== "persistent")) {
    throw new Error(`Trigger ${trigger} already exists with incompatible channel or session mode`);
  }
  db.query("INSERT OR IGNORE INTO triggers (name,type,description,channel,prompt,session_mode) VALUES (?, 'manual', 'Nextcloud Talk conversations', 'talk', '{{payload}}', 'persistent')").run(trigger);
  mkdirSync(join(home, "triggers", trigger), { recursive: true });
  mkdirSync(join(home, "supervisor.d"), { recursive: true });
  mkdirSync(join(home, ".index/talk"), { recursive: true, mode: 0o700 });
  if (existing && !existing.startsWith(MARKER)) throw new Error("supervisor.d/talk.conf is user-managed; configure its talk-listener program manually");
  if (/[\r\n"%]/.test(home + appRoot)) throw new Error("Unsupported supervisor path");
  const text = `${MARKER}
[program:talk-listener]
command=${appRoot}/bin/talk listen
directory=${home}
environment=HOME="${home}"
autostart=true
autorestart=unexpected
exitcodes=0,78
startsecs=0
startretries=3
stopasgroup=true
killasgroup=true
stdout_logfile=/atlas/logs/talk-listener.log
stderr_logfile=/atlas/logs/talk-listener-error.log
`;
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
