import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStoreError } from "./tasks/store.ts";

const busy = (error: unknown) => /database is locked|database is busy/.test(String(error));
// SQLITE_IOERR_TRUNCATE. On Windows, opening can fail with it for a moment after another process exited without
// closing the database, while that process's shared-memory file is still mapped; a fresh attempt succeeds
// (investigations/sqlite-trial/README.md).
const truncateFailed = (error: unknown) => (error as { errcode?: unknown }).errcode === 1546;

/** All SQLite access lives here. Transaction callbacks are synchronous and contain no external effects. */
export class Database {
  private readonly db: DatabaseSync;
  private readonly retryMs: number;
  private constructor(db: DatabaseSync, retryMs: number) { this.db = db; this.retryMs = retryMs; }

  static async open(path: string, retryMs = 5000): Promise<Database> {
    if (!isAbsolute(path)) throw new Error("Database path must be absolute");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (await realpath(dirname(path)) !== dirname(path)) throw new Error("Database path must be canonical");
    const existing = await lstat(path).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Database must be a regular file, not a link");
    const probe = `${path}.probe-${randomUUID()}`;
    try {
      const handle = await open(probe, "wx", 0o600);
      await handle.close();
      try {
        const duplicate = await open(probe, "wx", 0o600);
        await duplicate.close();
        throw new Error("Filesystem does not support exclusive creation");
      } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    } finally { await unlink(probe).catch(() => {}); }
    // Opening is retried as a whole, with a fresh connection each time, while it fails because the database is busy or
    // because of the brief Windows condition above. Any other error, or either one persisting, is reported.
    const deadline = Date.now() + retryMs;
    let db: DatabaseSync;
    for (;;) {
      const attempt = new DatabaseSync(path, { timeout: 0 });
      try {
        attempt.exec("PRAGMA journal_mode = WAL");
        attempt.exec("PRAGMA synchronous = FULL; PRAGMA fullfsync = ON; PRAGMA checkpoint_fullfsync = ON; PRAGMA foreign_keys = ON");
        db = attempt;
        break;
      } catch (error) {
        attempt.close();
        if (!(busy(error) || truncateFailed(error))) throw error;
        if (Date.now() >= deadline) throw new TaskStoreError("busy", `The database could not be opened: ${String(error).split("\n")[0]}`);
        await sleep(20);
      }
    }
    const result = new Database(db, retryMs);
    try {
      const version = Number(result.get("PRAGMA user_version")!.user_version);
      if (version > 1) throw new Error(`Unsupported database schema version ${version}`);
      if (version === 0) await result.transaction(() => {
        // Another opener may have migrated while this connection waited for the write lock.
        if (Number(result.get("PRAGMA user_version")!.user_version) !== 0) return;
        db.exec(`
          CREATE TABLE tasks (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, repo TEXT, kind TEXT,
            state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','in_flight','done')),
            hold_reason TEXT, position INTEGER NOT NULL UNIQUE,
            hold_revision INTEGER NOT NULL DEFAULT 0, started_hold_revision INTEGER, started_body TEXT);
          CREATE TABLE dependencies (
            task TEXT NOT NULL REFERENCES tasks(id), blocker TEXT NOT NULL REFERENCES tasks(id),
            PRIMARY KEY(task, blocker), CHECK(task <> blocker));
          PRAGMA user_version = 1;
        `);
      });
      return result;
    } catch (error) { db.close(); throw error; }
  }

  all(sql: string, ...values: SQLInputValue[]) { return this.db.prepare(sql).all(...values); }
  get(sql: string, ...values: SQLInputValue[]) { return this.db.prepare(sql).get(...values); }
  run(sql: string, ...values: SQLInputValue[]) {
    if (!this.db.isTransaction) throw new Error("Database writes require a transaction");
    return this.db.prepare(sql).run(...values);
  }
  async transaction<T>(change: () => T): Promise<T> {
    return this.retry(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const value = change();
        if (value instanceof Promise) throw new Error("Database transaction callbacks must be synchronous");
        this.db.exec("COMMIT");
        return value;
      } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
    });
  }
  private async retry<T>(operation: () => T): Promise<T> {
    const deadline = Date.now() + this.retryMs;
    for (;;) {
      try { return operation(); }
      catch (error) {
        if (!busy(error)) throw error;
        if (Date.now() >= deadline) throw new TaskStoreError("busy", "Database remained busy; nothing changed");
        await sleep(20);
      }
    }
  }
  close() { if (this.db.isOpen) this.db.close(); }
  checkpoint() { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
}
