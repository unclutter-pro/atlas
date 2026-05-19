import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { openDb } from "./db.ts";

const DB_PATH = process.env.HOME + "/.index/atlas.db";

let db: Database | null = null;

function createTables(database: Database): void {
  // Messages: inbox log for external events (signal, email, web)
  database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      sender TEXT,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel, created_at);

    CREATE TABLE IF NOT EXISTS trigger_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_name TEXT NOT NULL,
      session_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(trigger_name, session_key)
    );

    -- Generic attachments associated with messages (audio voice notes today;
    -- images, PDFs, etc. later without further migration). Files live on
    -- disk under HOME/.attachments/<id>.<ext>; this table stores metadata.
    CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,           -- uuid (filename without extension)
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,            -- 'audio' | 'image' | 'video' | 'document' | 'other'
      mime_type TEXT NOT NULL,       -- e.g. 'audio/webm', 'image/png'
      file_name TEXT NOT NULL,       -- original client filename, sanitised
      file_size INTEGER NOT NULL,
      transcription TEXT,            -- audio only: STT result text
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_message_attachments_msg ON message_attachments(message_id);
  `);

  // Triggers: plugin system for cron, webhook, manual triggers
  database.exec(`
    CREATE TABLE IF NOT EXISTS triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('cron','webhook','manual')),
      description TEXT DEFAULT '',
      channel TEXT DEFAULT 'internal',
      schedule TEXT,
      webhook_secret TEXT,
      webhook_channel TEXT,
      prompt TEXT DEFAULT '',
      session_mode TEXT DEFAULT 'ephemeral' CHECK(session_mode IN ('ephemeral','persistent')),
      enabled INTEGER DEFAULT 1,
      last_run TEXT,
      run_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Drop path_locks table if it exists (feature removed)
  database.exec(`DROP TABLE IF EXISTS path_locks`);

  // Reminders: one-time scheduled events that fire a Claude session
  database.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      fire_at TEXT NOT NULL,
      channel TEXT DEFAULT 'internal',
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','fired','cancelled')),
      created_at TEXT DEFAULT (datetime('now')),
      fired_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_status_fire ON reminders(status, fire_at);
  `);

  // Session metrics: per-invocation cost and token tracking
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_type TEXT NOT NULL,
      session_id TEXT,
      trigger_name TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_ms INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      num_turns INTEGER DEFAULT 0,
      is_error INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_session_metrics_created ON session_metrics(created_at);
  `);

  // Trigger runs: tracks active trigger invocations for crash recovery
  database.exec(`
    CREATE TABLE IF NOT EXISTS trigger_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_name TEXT NOT NULL,
      session_key TEXT NOT NULL DEFAULT '_default',
      session_mode TEXT NOT NULL DEFAULT 'ephemeral',
      session_id TEXT,
      payload TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trigger_runs_active
      ON trigger_runs(completed_at) WHERE completed_at IS NULL;
  `);

  // System state: key-value store for control plane (kill switch, etc.)
  database.exec(`
    CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Web-chat streaming: incremental text deltas produced by the SDK while an
  // assistant turn is in flight. Web-UI tails this table and forwards chunks
  // as SSE events so the user sees text appear as it's generated. Rows are
  // disposable — keyed by session_id + message_uuid (message_uuid is the
  // SDKAssistantMessage uuid, so the client can stitch chunks to the final
  // assistant message that lands in the JSONL).
  database.exec(`
    CREATE TABLE IF NOT EXISTS web_chat_stream_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      message_uuid TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content_delta TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_web_chat_stream_chunks_session
      ON web_chat_stream_chunks(session_id, id);
  `);

  // Prune orphaned stream chunks on startup — rows whose session_id no
  // longer maps to a live trigger_session. Without this, every retired
  // web-chat session leaves its chunks behind forever and the table grows
  // unbounded on long-lived customer containers. Bounded by the size of
  // the chunks table at boot, so cheap even after a long uptime.
  database.exec(`
    DELETE FROM web_chat_stream_chunks
    WHERE session_id NOT IN (SELECT session_id FROM trigger_sessions)
  `);

  // Webhook queue: failed usage webhooks for retry on next trigger run
  database.exec(`
    CREATE TABLE IF NOT EXISTS webhook_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      payload TEXT NOT NULL,
      secret TEXT,
      attempts INTEGER DEFAULT 1,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      next_retry_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_queue_retry
      ON webhook_queue(next_retry_at) WHERE attempts <= 5;
  `);

  // Migration: drop pending_trigger_messages if it exists (replaced by socket-based injection)
  database.exec(`DROP TABLE IF EXISTS pending_trigger_messages`);
  database.exec(`DROP INDEX IF EXISTS idx_pending_trigger_messages`);

  // Task management: goals, tasks, dependency graph, and validation audit log
  database.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      done_condition TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'done', 'abandoned', 'validation_exhausted')),
      validation_required INTEGER NOT NULL DEFAULT 0,
      validation_count INTEGER NOT NULL DEFAULT 0,
      trigger_name TEXT NOT NULL,
      session_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      close_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_goals_session_status
      ON goals(trigger_name, session_key, status);

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open', 'in_progress', 'done', 'cancelled')),
      priority INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 0 AND 4),
      goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE,
      trigger_name TEXT NOT NULL,
      session_key TEXT NOT NULL,
      claimed_by TEXT,
      claimed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      close_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_session_status
      ON tasks(trigger_name, session_key, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id);

    CREATE TABLE IF NOT EXISTS task_deps (
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on),
      CHECK (task_id != depends_on)
    );

    CREATE TABLE IF NOT EXISTS goal_validations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      verdict TEXT NOT NULL CHECK(verdict IN ('pass', 'fail', 'exhausted')),
      feedback TEXT,
      duration_ms INTEGER,
      started_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function migrateSchema(database: Database): void {
  // Migrate old messages table (had CHECK constraint on channel)
  let msgInfo = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'"
  ).get() as { sql: string } | undefined;

  if (msgInfo?.sql?.includes("CHECK(channel IN")) {
    database.exec("BEGIN");
    try {
      database.exec(`
        ALTER TABLE messages RENAME TO _messages_old;
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel TEXT NOT NULL,
          sender TEXT,
          content TEXT NOT NULL,
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','done','cancelled')),
          response_summary TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          processed_at TEXT
        );
        INSERT INTO messages (id, channel, sender, content, status, response_summary, created_at, processed_at)
          SELECT id, channel, sender, content, status, response_summary, created_at, processed_at FROM _messages_old;
        DROP TABLE _messages_old;
      `);
      database.exec("COMMIT");
    } catch (e) {
      database.exec("ROLLBACK");
      throw e;
    }
  }

  // Re-query after potential channel migration
  msgInfo = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'"
  ).get() as { sql: string } | undefined;

  // Migrate: add 'cancelled' to messages status constraint (only if status column still exists)
  if (msgInfo?.sql && msgInfo.sql.includes("status") && !msgInfo.sql.includes("'cancelled'")) {
    database.exec("BEGIN");
    try {
      database.exec(`
        ALTER TABLE messages RENAME TO _messages_status_mig;
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel TEXT NOT NULL,
          sender TEXT,
          content TEXT NOT NULL,
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','done','cancelled')),
          response_summary TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          processed_at TEXT
        );
        INSERT INTO messages (id, channel, sender, content, status, response_summary, created_at, processed_at)
          SELECT id, channel, sender, content, status, response_summary, created_at, processed_at FROM _messages_status_mig;
        DROP TABLE _messages_status_mig;
      `);
      database.exec("COMMIT");
    } catch (e) {
      database.exec("ROLLBACK");
      throw e;
    }
  }

  // Migrate old triggers table (lacked name/schedule/prompt columns)
  const trigInfo = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='triggers'"
  ).get() as { sql: string } | undefined;

  if (trigInfo && !trigInfo.sql.includes("name TEXT")) {
    database.exec(`DROP TABLE triggers`);
    database.exec(`
      CREATE TABLE triggers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('cron','webhook','manual')),
        description TEXT DEFAULT '',
        channel TEXT DEFAULT 'internal',
        schedule TEXT,
        webhook_secret TEXT,
        webhook_channel TEXT,
        prompt TEXT DEFAULT '',
        session_mode TEXT DEFAULT 'ephemeral' CHECK(session_mode IN ('ephemeral','persistent')),
        enabled INTEGER DEFAULT 1,
        last_run TEXT,
        run_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  // Add session_mode column if missing (upgrade from pre-session triggers)
  if (trigInfo && trigInfo.sql.includes("name TEXT") && !trigInfo.sql.includes("session_mode")) {
    database.exec(`ALTER TABLE triggers ADD COLUMN session_mode TEXT DEFAULT 'ephemeral'`);
  }

  // Add webhook_channel column if missing (upgrade from pre-webhook-relay triggers)
  const trigInfoForWebhook = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='triggers'"
  ).get() as { sql: string } | undefined;
  if (trigInfoForWebhook?.sql?.includes("name TEXT") && !trigInfoForWebhook.sql.includes("webhook_channel")) {
    database.exec(`ALTER TABLE triggers ADD COLUMN webhook_channel TEXT`);
  }

  // Drop session_id from triggers if present (moved to trigger_sessions table)
  if (trigInfo?.sql?.includes("session_id")) {
    // SQLite doesn't support DROP COLUMN before 3.35.0, so recreate the table
    database.exec("BEGIN");
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS _triggers_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL CHECK(type IN ('cron','webhook','manual')),
          description TEXT DEFAULT '',
          channel TEXT DEFAULT 'internal',
          schedule TEXT,
          webhook_secret TEXT,
          webhook_channel TEXT,
          prompt TEXT DEFAULT '',
          session_mode TEXT DEFAULT 'ephemeral' CHECK(session_mode IN ('ephemeral','persistent')),
          enabled INTEGER DEFAULT 1,
          last_run TEXT,
          run_count INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO _triggers_new (id, name, type, description, channel, schedule, webhook_secret, webhook_channel, prompt, session_mode, enabled, last_run, run_count, created_at)
          SELECT id, name, type, description, channel, schedule, webhook_secret, NULL, prompt, COALESCE(session_mode, 'ephemeral'), enabled, last_run, run_count, created_at FROM triggers;
        DROP TABLE triggers;
        ALTER TABLE _triggers_new RENAME TO triggers;
      `);
      database.exec("COMMIT");
    } catch (e) {
      database.exec("ROLLBACK");
      throw e;
    }
  }

  // Migrate old signal_sessions to trigger_sessions (if signal_sessions exists)
  const signalInfo = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='signal_sessions'"
  ).get();
  if (signalInfo) {
    database.exec(`DROP TABLE signal_sessions`);
  }

  // Remove reply_to column if present (no longer needed — use env vars + content instead)
  const latestMsgInfo = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'"
  ).get() as { sql: string } | undefined;

  if (latestMsgInfo?.sql?.includes("reply_to")) {
    database.exec(`ALTER TABLE messages DROP COLUMN reply_to`);
  }

  // Remove status column from messages (messages are a fire-and-forget log)
  const msgForStatus = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'"
  ).get() as { sql: string } | undefined;

  if (msgForStatus?.sql?.includes("status")) {
    database.exec("BEGIN");
    try {
      database.exec(`
        ALTER TABLE messages RENAME TO _messages_rm_status;
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel TEXT NOT NULL,
          sender TEXT,
          content TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO messages (id, channel, sender, content, created_at)
          SELECT id, channel, sender, content, created_at FROM _messages_rm_status;
        DROP TABLE _messages_rm_status;
      `);
      database.exec("COMMIT");
    } catch (e) {
      database.exec("ROLLBACK");
      throw e;
    }
  }

  // --- v3 migration: Drop task_awaits table (no longer needed — triggers orchestrate directly) ---
  const taskAwaitsInfo = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='task_awaits'"
  ).get();
  if (taskAwaitsInfo) {
    database.exec("DROP TABLE task_awaits");
  }

  // --- v3 migration: Drop tasks table (no longer used — triggers orchestrate via Agent tool) ---
  // Note: v4 (task-management) re-creates a tasks table with a richer schema — the old
  // ephemeral tasks table had no goal_id, no deps, and no priority column. If a DB was
  // created after v3 and already has the new tasks table, we leave it alone; the
  // CREATE TABLE IF NOT EXISTS in createTables() is the guard for new DBs.
  const tasksV3Exists = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
  ).get() as { sql: string } | undefined;
  if (tasksV3Exists && !tasksV3Exists.sql.includes("goal_id")) {
    // Old ephemeral tasks table without goal_id — drop so the new schema can be created
    database.exec("DROP TABLE tasks");
  }

  // --- v4 migration: ensure task-management tables exist ---
  // Goals, tasks, task_deps, goal_validations are created by createTables() via
  // CREATE TABLE IF NOT EXISTS. No destructive migration needed on new columns.

}

export function initDb(): Database {
  const database = openDb();
  migrateSchema(database);
  createTables(database);
  return database;
}

export function getDb(): Database {
  if (!db) {
    db = initDb();
  }
  return db;
}
