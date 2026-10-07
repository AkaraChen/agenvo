import { DatabaseSync } from "node:sqlite";
import { type RecordStore } from "@agenvo/relay/core";

/** One process owns this database. Transactions never await external work. */
export class SqliteStore implements RecordStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(
        "PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  get<T>(key: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM records WHERE key=?")
      .get(key);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  put(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO records VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  remove(key: string) {
    this.db.prepare("DELETE FROM records WHERE key=?").run(key);
  }
  list<T>(prefix: string): T[] {
    return this.db
      .prepare("SELECT value FROM records WHERE key LIKE ? ORDER BY key")
      .all(prefix + "%")
      .map((row) => JSON.parse(String(row.value)));
  }
  expire(prefix: string, now: number) {
    this.db
      .prepare(
        "DELETE FROM records WHERE key LIKE ? AND json_extract(value, '$.expires')<=?",
      )
      .run(prefix + "%", now);
  }
  transaction<T>(action: () => T): T {
    if (this.db.isTransaction) return action();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
