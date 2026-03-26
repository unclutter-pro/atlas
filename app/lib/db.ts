/**
 * Shared SQLite database helper.
 *
 * Every process that touches atlas.db should use `openDb()` so that
 * busy_timeout, WAL mode and foreign keys are configured consistently.
 * Without busy_timeout, concurrent cron triggers will immediately get
 * SQLITE_BUSY instead of retrying.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";

export const DB_PATH = `${process.env.HOME}/.index/atlas.db`;

/**
 * Open (or create) the atlas SQLite database with safe defaults:
 *   - journal_mode = WAL   (concurrent readers + single writer)
 *   - busy_timeout = 5000  (wait up to 5 s instead of failing immediately)
 *   - foreign_keys = ON
 *
 * @param options.readonly  Open in read-only mode (no create, no write lock)
 */
export function openDb(options?: { readonly?: boolean }): Database {
  mkdirSync(`${process.env.HOME}/.index`, { recursive: true });

  const db = new Database(DB_PATH, {
    create: !options?.readonly,
    readonly: options?.readonly ?? false,
  });

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  return db;
}
