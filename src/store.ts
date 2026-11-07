// Check history and alert state, in a SQLite file under DATA_DIR (node:sqlite, so no dependency).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

  prune(now: number) {
    this.db.prepare("DELETE FROM check_results WHERE at < ?").run(now - KEEP_DAYS * 86_400_000);
  }

  close() {
    this.db.close();
  }
}
