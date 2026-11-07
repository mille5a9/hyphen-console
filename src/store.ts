// Check history and alert state, in a SQLite file under DATA_DIR (node:sqlite, so no dependency).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Review } from "./stores/review.ts";

export interface CheckResult {
  key: string;
  at: number;
  ok: boolean;
  status: number | null;
  ms: number;
  error: string | null;
}

export interface CheckState {
  key: string;
  /** Whether the check is up as far as alerts go (it flips only after enough failures in a row). */
  up: boolean;
  /** When `up` last changed. */
  since: number;
  /** Failures in a row, reset by any success. */
  fails: number;
  /** A "down" email went out for the current outage. */
  alerted: boolean;
}

const KEEP_DAYS = 90;

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS check_results (
        key TEXT NOT NULL, at INTEGER NOT NULL, ok INTEGER NOT NULL, status INTEGER, ms INTEGER NOT NULL, error TEXT
      );
      CREATE INDEX IF NOT EXISTS check_results_key_at ON check_results (key, at);
      CREATE TABLE IF NOT EXISTS check_state (
        key TEXT PRIMARY KEY, up INTEGER NOT NULL, since INTEGER NOT NULL, fails INTEGER NOT NULL, alerted INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews (
        store TEXT NOT NULL, id TEXT NOT NULL, app_id TEXT NOT NULL, rating INTEGER NOT NULL, title TEXT NOT NULL,
        body TEXT NOT NULL, author TEXT NOT NULL, locale TEXT NOT NULL, app_version TEXT NOT NULL, device TEXT NOT NULL,
        updated_at INTEGER NOT NULL, reply_text TEXT, reply_at INTEGER, first_seen INTEGER NOT NULL,
        PRIMARY KEY (store, id)
      );
      CREATE INDEX IF NOT EXISTS reviews_app_updated ON reviews (app_id, updated_at);
      CREATE TABLE IF NOT EXISTS metrics (
        app_id TEXT NOT NULL, store TEXT NOT NULL, metric TEXT NOT NULL, date TEXT NOT NULL, value REAL NOT NULL,
        PRIMARY KEY (app_id, store, metric, date)
      );
      CREATE TABLE IF NOT EXISTS report_instances (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, metric TEXT NOT NULL, processed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (at INTEGER NOT NULL, app_id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_at ON events (at);
      CREATE TABLE IF NOT EXISTS review_sync (
        app_id TEXT NOT NULL, store TEXT NOT NULL, last_attempt INTEGER, last_ok INTEGER, last_error TEXT,
        PRIMARY KEY (app_id, store)
      );
    `);
  }

  addResult(r: CheckResult) {
    this.db
      .prepare("INSERT INTO check_results (key, at, ok, status, ms, error) VALUES (?, ?, ?, ?, ?, ?)")
      .run(r.key, r.at, r.ok ? 1 : 0, r.status, r.ms, r.error);
  }

  lastResult(key: string): CheckResult | undefined {
    const row = this.db.prepare("SELECT * FROM check_results WHERE key = ? ORDER BY at DESC LIMIT 1").get(key) as
      | { key: string; at: number; ok: number; status: number | null; ms: number; error: string | null }
      | undefined;
    return row && { ...row, ok: row.ok === 1 };
  }

  /** Share of successful checks since `from`, or null with no checks in that window. */
  uptime(key: string, from: number): number | null {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n, SUM(ok) AS good FROM check_results WHERE key = ? AND at >= ?")
      .get(key, from) as { n: number; good: number | null };
    return row.n ? (row.good ?? 0) / row.n : null;
  }

  getState(key: string): CheckState | undefined {
    const row = this.db.prepare("SELECT * FROM check_state WHERE key = ?").get(key) as
      | { key: string; up: number; since: number; fails: number; alerted: number }
      | undefined;
    return row && { key: row.key, up: row.up === 1, since: row.since, fails: row.fails, alerted: row.alerted === 1 };
  }

  setState(s: CheckState) {
    this.db
      .prepare(
        `INSERT INTO check_state (key, up, since, fails, alerted) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET up = excluded.up, since = excluded.since, fails = excluded.fails, alerted = excluded.alerted`,
      )
      .run(s.key, s.up ? 1 : 0, s.since, s.fails, s.alerted ? 1 : 0);
  }

  /** Saves a review. Says whether it's new, or an edit of one already saved (newer text or rating). */
  saveReview(r: Review, now: number): "new" | "edited" | "same" {
    const old = this.db.prepare("SELECT updated_at, rating, body FROM reviews WHERE store = ? AND id = ?").get(r.store, r.id) as
      | { updated_at: number; rating: number; body: string }
      | undefined;
    this.db
      .prepare(
        `INSERT INTO reviews (store, id, app_id, rating, title, body, author, locale, app_version, device, updated_at, reply_text, reply_at, first_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (store, id) DO UPDATE SET rating = excluded.rating, title = excluded.title, body = excluded.body,
           author = excluded.author, locale = excluded.locale, app_version = excluded.app_version, device = excluded.device,
           updated_at = excluded.updated_at, reply_text = excluded.reply_text, reply_at = excluded.reply_at`,
      )
      .run(r.store, r.id, r.appId, r.rating, r.title, r.body, r.author, r.locale, r.appVersion, r.device, r.updatedAt, r.reply?.text ?? null, r.reply?.at ?? null, now);
    if (!old) return "new";
    return r.updatedAt > old.updated_at && (r.rating !== old.rating || r.body !== old.body) ? "edited" : "same";
  }

  reviews(appId: string, limit = 50): (Review & { firstSeen: number })[] {
    const rows = this.db.prepare("SELECT * FROM reviews WHERE app_id = ? ORDER BY updated_at DESC LIMIT ?").all(appId, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      store: row.store as Review["store"],
      appId: row.app_id as string,
      id: row.id as string,
      rating: row.rating as number,
      title: row.title as string,
      body: row.body as string,
      author: row.author as string,
      locale: row.locale as string,
      appVersion: row.app_version as string,
      device: row.device as string,
      updatedAt: row.updated_at as number,
      reply: row.reply_text ? { text: row.reply_text as string, at: (row.reply_at as number) ?? 0 } : null,
      firstSeen: row.first_seen as number,
    }));
  }

  /** Review count and average rating per store, plus how many arrived since `since`. */
  reviewSummary(appId: string, since: number) {
    return this.db
      .prepare(
        `SELECT store, COUNT(*) AS count, AVG(rating) AS average, SUM(CASE WHEN first_seen >= ? THEN 1 ELSE 0 END) AS recent
         FROM reviews WHERE app_id = ? GROUP BY store ORDER BY store`,
      )
      .all(since, appId) as { store: string; count: number; average: number; recent: number }[];
  }

  getSync(appId: string, store: string) {
    return this.db.prepare("SELECT last_attempt AS lastAttempt, last_ok AS lastOk, last_error AS lastError FROM review_sync WHERE app_id = ? AND store = ?").get(appId, store) as
      | { lastAttempt: number | null; lastOk: number | null; lastError: string | null }
      | undefined;
  }

  setSync(appId: string, store: string, at: number, error: string | null) {
    this.db
      .prepare(
        `INSERT INTO review_sync (app_id, store, last_attempt, last_ok, last_error) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (app_id, store) DO UPDATE SET last_attempt = excluded.last_attempt,
           last_ok = COALESCE(excluded.last_ok, review_sync.last_ok), last_error = excluded.last_error`,
      )
      .run(appId, store, at, error ? null : at, error);
  }

  /** Sets a day's value (Google: each fetch returns the whole recent timeline). */
  setMetric(appId: string, store: string, metric: string, date: string, value: number) {
    this.db
      .prepare("INSERT INTO metrics (app_id, store, metric, date, value) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET value = excluded.value")
      .run(appId, store, metric, date, value);
  }

  /** Values per date for some metrics since `fromDate` (YYYY-MM-DD), oldest first. */
  metricSeries(appId: string, store: string, metrics: string[], fromDate: string): { date: string; values: Record<string, number> }[] {
    const rows = this.db
      .prepare(`SELECT metric, date, value FROM metrics WHERE app_id = ? AND store = ? AND date >= ? AND metric IN (${metrics.map(() => "?").join(",")}) ORDER BY date`)
      .all(appId, store, fromDate, ...metrics) as { metric: string; date: string; value: number }[];
    const byDate = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const v = byDate.get(r.date) ?? {};
      v[r.metric] = r.value;
      byDate.set(r.date, v);
    }
    return [...byDate].map(([date, values]) => ({ date, values }));
  }

  instanceDone(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM report_instances WHERE id = ?").get(id);
  }

  /** Adds an Apple report instance's totals to each day and marks it done, all or nothing, so nothing counts twice. */
  addInstance(id: string, appId: string, metric: string, totals: Map<string, number>, now: number) {
    this.db.exec("BEGIN");
    try {
      const add = this.db.prepare(
        "INSERT INTO metrics (app_id, store, metric, date, value) VALUES (?, 'apple', ?, ?, ?) ON CONFLICT DO UPDATE SET value = value + excluded.value",
      );
      for (const [date, n] of totals) add.run(appId, metric, date, n);
      this.db.prepare("INSERT INTO report_instances (id, app_id, metric, processed_at) VALUES (?, ?, ?, ?)").run(id, appId, metric, now);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Things worth a line in the weekly digest: outages, recoveries, vitals crossing Play's limits. */
  addEvent(e: { at: number; appId: string; kind: string; subject: string; detail: string }) {
    this.db.prepare("INSERT INTO events (at, app_id, kind, subject, detail) VALUES (?, ?, ?, ?, ?)").run(e.at, e.appId, e.kind, e.subject, e.detail);
  }

  events(appId: string, from: number, to: number): { at: number; kind: string; subject: string; detail: string }[] {
    return this.db.prepare("SELECT at, kind, subject, detail FROM events WHERE app_id = ? AND at >= ? AND at < ? ORDER BY at").all(appId, from, to) as {
      at: number; kind: string; subject: string; detail: string;
    }[];
  }

  /** Reviews first seen in [from, to). */
  newReviews(appId: string, from: number, to: number): (Review & { firstSeen: number })[] {
    return this.reviews(appId, 10_000).filter((r) => r.firstSeen >= from && r.firstSeen < to);
  }

  getMeta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT DO UPDATE SET value = excluded.value").run(key, value);
  }

  prune(now: number) {
    this.db.prepare("DELETE FROM check_results WHERE at < ?").run(now - KEEP_DAYS * 86_400_000);
  }

  close() {
    this.db.close();
  }
}
