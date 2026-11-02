/**
 * Routing ledger: topics (one worker session each), the issue/PR refs bound
 * to them, and every delivery seen (idempotency + audit trail).
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function defaultLedgerPath(home = process.env.HOME ?? "/home/agent"): string {
  return join(home, ".index", "github", "router.db");
}

export interface Topic {
  slug: string;
  title: string;
  notes: string | null;
  refs: string[];
  updated_at: string;
}

export interface EventRecord {
  ref?: string | null;
  slug?: string | null;
  type: string;
  action: string;
  path: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS topics (
    slug       TEXT PRIMARY KEY,
    title      TEXT NOT NULL DEFAULT '',
    notes      TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS mappings (
    ref        TEXT PRIMARY KEY,
    slug       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mappings_slug ON mappings(slug);
  CREATE TABLE IF NOT EXISTS event_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery   TEXT,
    ref        TEXT,
    slug       TEXT,
    event_type TEXT,
    action     TEXT,
    path       TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_event_delivery ON event_log(delivery) WHERE delivery IS NOT NULL AND delivery != '';
`;

export class Ledger {
  readonly db: Database;

  constructor(path = defaultLedgerPath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Claims a delivery before it is processed; false if it was seen before.
   * Claiming first keeps two concurrent redeliveries from both dispatching.
   */
  claim(delivery: string, type: string, action: string): boolean {
    if (!delivery) return true;
    const result = this.db
      .prepare("INSERT OR IGNORE INTO event_log(delivery, event_type, action, path) VALUES (?, ?, ?, 'pending')")
      .run(delivery, type, action);
    return result.changes > 0;
  }

  /** Releases a claim so a redelivery can retry after a failure. */
  release(delivery: string): void {
    if (delivery) this.db.prepare("DELETE FROM event_log WHERE delivery = ? AND path = 'pending'").run(delivery);
  }

  /** Records the outcome of a delivery (updates its claim, if any). */
  record(delivery: string, entry: EventRecord): void {
    const values = [entry.ref ?? null, entry.slug ?? null, entry.type, entry.action, entry.path];
    if (delivery) {
      const updated = this.db
        .prepare("UPDATE event_log SET ref = ?, slug = ?, event_type = ?, action = ?, path = ? WHERE delivery = ?")
        .run(...values, delivery);
      if (updated.changes > 0) return;
    }
    this.db
      .prepare("INSERT OR IGNORE INTO event_log(ref, slug, event_type, action, path, delivery) VALUES (?, ?, ?, ?, ?, ?)")
      .run(...values, delivery || null);
  }

  lookup(ref: string): string | null {
    const row = this.db.prepare("SELECT slug FROM mappings WHERE ref = ?").get(ref) as { slug: string } | null;
    return row?.slug ?? null;
  }

  hasTopic(slug: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM topics WHERE slug = ?").get(slug);
  }

  /**
   * Binds `ref` to `slug` unless it is already bound, and returns the slug in
   * force. Deliveries run as separate processes, so two events for a new ref
   * can resolve concurrently; the first mapping wins and the other adopts it,
   * keeping the ref in one session.
   */
  bind(ref: string, slug: string, title: string, notes: string | null = null): string {
    return this.db.transaction(() => {
      this.db.prepare("INSERT INTO mappings(ref, slug) VALUES (?, ?) ON CONFLICT(ref) DO NOTHING").run(ref, slug);
      const inForce = this.lookup(ref) ?? slug;
      this.upsertTopic(inForce, inForce === slug ? title : null, inForce === slug ? notes : null);
      return inForce;
    })();
  }

  /** Binds `ref` to `slug`, moving it away from any previous topic. */
  link(ref: string, slug: string, title: string | null = null): { previous: string | null } {
    return this.db.transaction(() => {
      const previous = this.lookup(ref);
      this.db.prepare("INSERT INTO mappings(ref, slug) VALUES (?, ?) ON CONFLICT(ref) DO UPDATE SET slug = excluded.slug").run(ref, slug);
      this.upsertTopic(slug, title, null);
      if (previous && previous !== slug) this.dropTopicIfEmpty(previous);
      return { previous };
    })();
  }

  /** Removes `ref`; drops its topic when no ref is left. */
  unlink(ref: string): { slug: string | null; topicDropped: boolean } {
    return this.db.transaction(() => {
      const slug = this.lookup(ref);
      if (!slug) return { slug: null, topicDropped: false };
      this.db.prepare("DELETE FROM mappings WHERE ref = ?").run(ref);
      return { slug, topicDropped: this.dropTopicIfEmpty(slug) };
    })();
  }

  touch(slug: string): void {
    this.db.prepare("UPDATE topics SET updated_at = datetime('now') WHERE slug = ?").run(slug);
  }

  /** Topics, most recently active first; `repo` keeps those with a ref in it. */
  topics(options: { repo?: string; limit?: number } = {}): Topic[] {
    const filter = options.repo ? "WHERE slug IN (SELECT slug FROM mappings WHERE substr(ref, 1, ?) = ?)" : "";
    const params: (string | number)[] = [];
    if (options.repo) {
      const prefix = `${options.repo.toLowerCase()}#`;
      params.push(prefix.length, prefix);
    }
    if (options.limit) params.push(options.limit);
    const rows = this.db
      .prepare(`SELECT slug, title, notes, updated_at FROM topics ${filter} ORDER BY updated_at DESC, slug ${options.limit ? "LIMIT ?" : ""}`)
      .all(...params) as Omit<Topic, "refs">[];
    const refsOf = this.db.prepare("SELECT ref FROM mappings WHERE slug = ? ORDER BY ref");
    return rows.map((row) => ({ ...row, refs: (refsOf.all(row.slug) as { ref: string }[]).map((r) => r.ref) }));
  }

  private upsertTopic(slug: string, title: string | null, notes: string | null): void {
    this.db
      .prepare(`INSERT INTO topics(slug, title, notes) VALUES (?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET updated_at = datetime('now'),
          title = CASE WHEN topics.title = '' THEN excluded.title ELSE topics.title END,
          notes = COALESCE(excluded.notes, topics.notes)`)
      .run(slug, title ?? "", notes);
  }

  private dropTopicIfEmpty(slug: string): boolean {
    const left = this.db.prepare("SELECT COUNT(*) AS n FROM mappings WHERE slug = ?").get(slug) as { n: number };
    if (left.n > 0) return false;
    this.db.prepare("DELETE FROM topics WHERE slug = ?").run(slug);
    return true;
  }
}
