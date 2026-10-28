import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStoreError } from "./tasks/store.ts";
import { specificationFromBinding } from "./attempts/specification.ts";
import { workerInputSchema } from "./runtime/contracts.ts";
import { migrateRequestRecords } from "./attempts/requests.ts";

const busy = (error: unknown) => /database is locked|database is busy/.test(String(error));
// SQLITE_IOERR_TRUNCATE. On Windows, opening can fail with it for a moment after another process exited without
// closing the database, while that process's shared-memory file is still mapped; a fresh attempt succeeds
// (investigations/sqlite-trial/README.md).
const truncateFailed = (error: unknown) => (error as { errcode?: unknown }).errcode === 1546;

/** All SQLite access lives here. Transaction callbacks are synchronous and contain no external effects. */
export class Database {
  private readonly db: DatabaseSync;
  private readonly retryMs: number;
  readonly path: string;
  private constructor(db: DatabaseSync, retryMs: number, path: string) { this.db = db; this.retryMs = retryMs; this.path = path; }

  static async open(path: string, retryMs = 5000, options: { migrate?: boolean } = {}): Promise<Database> {
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
      let attempt: DatabaseSync | undefined;
      try {
        attempt = new DatabaseSync(path, { timeout: 0 });
        attempt.exec("PRAGMA journal_mode = WAL");
        attempt.exec("PRAGMA synchronous = FULL; PRAGMA fullfsync = ON; PRAGMA checkpoint_fullfsync = ON; PRAGMA foreign_keys = ON");
        db = attempt;
        break;
      } catch (error) {
        attempt?.close();
        if (!(busy(error) || truncateFailed(error))) throw error;
        if (Date.now() >= deadline) throw new TaskStoreError("busy", `The database could not be opened: ${String(error).split("\n")[0]}`);
        await sleep(20);
      }
    }
    const result = new Database(db, retryMs, path);
    try {
      const version = Number(result.get("PRAGMA user_version")!.user_version);
      if (version > 12) throw new Error(`Unsupported database schema version ${version}`);
      if (options.migrate === false) return result;
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
      if (Number(result.get("PRAGMA user_version")!.user_version) < 2) await result.transaction(() => {
        if (Number(result.get("PRAGMA user_version")!.user_version) >= 2) return;
        db.exec(`
          CREATE TABLE attempt_numbers (
            context TEXT NOT NULL, task TEXT NOT NULL REFERENCES tasks(id), number INTEGER NOT NULL CHECK(number > 0),
            PRIMARY KEY(context, task, number));
          CREATE TABLE attempts (
            context TEXT NOT NULL, task TEXT NOT NULL REFERENCES tasks(id), number INTEGER,
            request_id TEXT, reserved_at TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1)),
            UNIQUE(context, task, number), UNIQUE(context, request_id),
            FOREIGN KEY(context, task, number) REFERENCES attempt_numbers(context, task, number),
            CHECK(number IS NOT NULL OR request_id IS NOT NULL), CHECK(number IS NULL OR number > 0));
          CREATE UNIQUE INDEX open_attempt_per_task ON attempts(task) WHERE number IS NOT NULL AND closed = 0;
          CREATE TABLE attempt_entries (
            context TEXT NOT NULL, task TEXT NOT NULL, attempt INTEGER NOT NULL,
            sequence INTEGER NOT NULL CHECK(sequence >= 0), entry TEXT NOT NULL CHECK(json_valid(entry)),
            PRIMARY KEY(context, task, attempt, sequence),
            FOREIGN KEY(context, task, attempt) REFERENCES attempts(context, task, number) ON DELETE CASCADE);
          CREATE TRIGGER attempt_entries_immutable BEFORE UPDATE ON attempt_entries BEGIN
            SELECT RAISE(ABORT, 'Attempt entries cannot be changed');
          END;
          CREATE TABLE confirmations (
            id INTEGER PRIMARY KEY, context TEXT NOT NULL, task TEXT NOT NULL, attempt INTEGER NOT NULL,
            fact TEXT NOT NULL, confirmed_by TEXT NOT NULL, confirmed_at TEXT NOT NULL,
            scope TEXT NOT NULL CHECK(json_valid(scope)),
            FOREIGN KEY(context, task, attempt) REFERENCES attempts(context, task, number) ON DELETE CASCADE);
          CREATE TABLE archived_attempts (
            context TEXT NOT NULL, task TEXT NOT NULL, attempt INTEGER NOT NULL,
            summary TEXT NOT NULL CHECK(json_valid(summary)), PRIMARY KEY(context, task, attempt),
            FOREIGN KEY(context, task, attempt) REFERENCES attempt_numbers(context, task, number));
          CREATE TABLE pending_attempt_deletions (
            context TEXT NOT NULL, task TEXT NOT NULL, attempt INTEGER NOT NULL, directory TEXT NOT NULL UNIQUE,
            PRIMARY KEY(context, task, attempt, directory),
            FOREIGN KEY(context, task, attempt) REFERENCES archived_attempts(context, task, attempt));
          PRAGMA user_version = 2;
        `);
      });
      if (Number(result.get("PRAGMA user_version")!.user_version) < 3) await result.transaction(() => {
        if (Number(result.get("PRAGMA user_version")!.user_version) >= 3) return;
        db.exec("ALTER TABLE tasks DROP COLUMN started_body; PRAGMA user_version = 3");
      });
      if (Number(result.get("PRAGMA user_version")!.user_version) < 4) await result.transaction(() => {
        if (Number(result.get("PRAGMA user_version")!.user_version) >= 4) return;
        db.exec(`
          ALTER TABLE confirmations ADD COLUMN note TEXT;
          CREATE UNIQUE INDEX worker_stop_per_attempt ON confirmations(context, task, attempt) WHERE fact = 'worker_stopped';
          CREATE TABLE worker_claims (
            id TEXT PRIMARY KEY, context TEXT NOT NULL, task TEXT NOT NULL, attempt INTEGER NOT NULL,
            owner_pid INTEGER NOT NULL, owner_started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, released_at TEXT,
            UNIQUE(context, task, attempt),
            FOREIGN KEY(context, task, attempt) REFERENCES attempts(context, task, number) ON DELETE CASCADE);
          CREATE TABLE launches (
            context TEXT NOT NULL, task TEXT NOT NULL, attempt INTEGER NOT NULL, lease_id TEXT NOT NULL,
            created_at TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('launch','fence')),
            directory TEXT NOT NULL UNIQUE, binding TEXT CHECK(binding IS NULL OR json_valid(binding)),
            claim_id TEXT UNIQUE REFERENCES worker_claims(id),
            PRIMARY KEY(context, task, attempt), UNIQUE(context, lease_id),
            CHECK((kind = 'launch' AND binding IS NOT NULL AND claim_id IS NOT NULL) OR
                  (kind = 'fence' AND binding IS NULL AND claim_id IS NULL)),
            FOREIGN KEY(context, task, attempt) REFERENCES attempts(context, task, number) ON DELETE CASCADE);
          CREATE TRIGGER launches_immutable BEFORE UPDATE ON launches BEGIN
            SELECT RAISE(ABORT, 'Launch rows cannot be changed');
          END;
          CREATE TRIGGER launches_not_removed BEFORE DELETE ON launches
            WHEN EXISTS(SELECT 1 FROM attempts WHERE context = OLD.context AND task = OLD.task AND number = OLD.attempt)
            BEGIN SELECT RAISE(ABORT, 'Launch rows cannot be removed while the attempt exists'); END;
          CREATE TABLE worker_observations (
            directory TEXT NOT NULL REFERENCES launches(directory) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK(kind IN ('exit','session_start')), recorded_at TEXT NOT NULL,
            value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(directory, kind));
          CREATE TRIGGER worker_observations_immutable BEFORE UPDATE ON worker_observations BEGIN
            SELECT RAISE(ABORT, 'Worker observations cannot be changed');
          END;
          CREATE TABLE worker_activity (
            directory TEXT NOT NULL REFERENCES launches(directory) ON DELETE CASCADE, sequence INTEGER NOT NULL,
            entry TEXT NOT NULL CHECK(json_valid(entry)), PRIMARY KEY(directory, sequence));
          CREATE TABLE control_requests (
            id TEXT PRIMARY KEY, claim_id TEXT NOT NULL REFERENCES worker_claims(id) ON DELETE CASCADE,
            request TEXT NOT NULL CHECK(json_valid(request)), created_at TEXT NOT NULL,
            sender_pid INTEGER NOT NULL, sender_started_at TEXT NOT NULL,
            claimed_by TEXT CHECK(claimed_by IN ('dispatcher','withdrawn')), claimed_at TEXT,
            result TEXT CHECK(result IS NULL OR json_valid(result)),
            CHECK((claimed_by IS NULL) = (claimed_at IS NULL)),
            CHECK(result IS NULL OR claimed_by = 'dispatcher'));
          CREATE TRIGGER request_claim_immutable BEFORE UPDATE OF claimed_by, claimed_at ON control_requests
            WHEN OLD.claimed_by IS NOT NULL BEGIN SELECT RAISE(ABORT, 'Request claims cannot be changed'); END;
          CREATE TRIGGER request_result_immutable BEFORE UPDATE OF result ON control_requests
            WHEN OLD.result IS NOT NULL BEGIN SELECT RAISE(ABORT, 'Request results cannot be changed'); END;
          PRAGMA user_version = 4;
        `);
      });
      if (Number(result.get("PRAGMA user_version")!.user_version) < 5) await result.transaction(() => {
        if (Number(result.get("PRAGMA user_version")!.user_version) >= 5) return;
        db.exec(`
          ALTER TABLE tasks ADD COLUMN definition_revision INTEGER NOT NULL DEFAULT 1 CHECK(definition_revision > 0);
          CREATE TRIGGER task_definition_changed AFTER UPDATE OF title, body, repo, kind ON tasks
            WHEN NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body OR NEW.repo IS NOT OLD.repo OR NEW.kind IS NOT OLD.kind
            BEGIN UPDATE tasks SET definition_revision = OLD.definition_revision + 1 WHERE id = NEW.id; END;
          CREATE TABLE attempt_specifications (
            context TEXT NOT NULL, task TEXT NOT NULL, attempt INTEGER NOT NULL,
            specification TEXT NOT NULL CHECK(json_valid(specification)), PRIMARY KEY(context, task, attempt),
            FOREIGN KEY(context, task, attempt) REFERENCES attempts(context, task, number) ON DELETE CASCADE);
          CREATE TRIGGER attempt_specifications_immutable BEFORE UPDATE ON attempt_specifications BEGIN
            SELECT RAISE(ABORT, 'Attempt specifications cannot be changed');
          END;
          CREATE TRIGGER attempt_specifications_not_removed BEFORE DELETE ON attempt_specifications
            WHEN EXISTS(SELECT 1 FROM attempts WHERE context = OLD.context AND task = OLD.task AND number = OLD.attempt)
            BEGIN SELECT RAISE(ABORT, 'Attempt specifications cannot be removed while the attempt exists'); END;
        `);
        for (const row of result.all("SELECT context, task, attempt, binding FROM launches WHERE kind = 'launch'")) {
          const input = workerInputSchema.parse(JSON.parse(String(row.binding)).input);
          result.run("INSERT INTO attempt_specifications VALUES(?,?,?,?)", row.context!, row.task!, row.attempt!, JSON.stringify(specificationFromBinding(input)));
        }
        db.exec("PRAGMA user_version = 5");
      });
      if (Number(result.get("PRAGMA user_version")!.user_version) < 6) await result.transaction(() => {
        if (Number(result.get("PRAGMA user_version")!.user_version) >= 6) return;
        db.exec(`
          CREATE TABLE request_records (
            context TEXT NOT NULL, request_id TEXT NOT NULL, task TEXT NOT NULL REFERENCES tasks(id), attempt INTEGER,
            reserved_at TEXT NOT NULL, encoding_version INTEGER NOT NULL CHECK(encoding_version IN (0,1)), fingerprint TEXT,
            archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), PRIMARY KEY(context, request_id),
            FOREIGN KEY(context, task, attempt) REFERENCES attempt_numbers(context, task, number),
            CHECK((encoding_version = 0 AND fingerprint IS NULL) OR (encoding_version = 1 AND fingerprint IS NOT NULL)),
            CHECK(archived = 0 OR attempt IS NOT NULL));
        `);
        migrateRequestRecords(result);
        db.exec("PRAGMA user_version = 6");
      });
      if (Number(result.get("PRAGMA user_version")!.user_version) < 7) await result.transaction(() => {
        if (Number(result.get("PRAGMA user_version")!.user_version) >= 7) return;
        db.exec(`
          DROP TRIGGER worker_observations_immutable;
          ALTER TABLE worker_observations RENAME TO previous_worker_observations;
          CREATE TABLE worker_observations (
            directory TEXT NOT NULL REFERENCES launches(directory) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK(kind IN ('exit','session_start','validated_result')), recorded_at TEXT NOT NULL,
            value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(directory, kind));
          INSERT INTO worker_observations SELECT * FROM previous_worker_observations;
          DROP TABLE previous_worker_observations;
          CREATE TRIGGER worker_observations_immutable BEFORE UPDATE ON worker_observations BEGIN
            SELECT RAISE(ABORT, 'Worker observations cannot be changed');
          END;
          PRAGMA user_version = 7;
        `);
      });
      if (Number(result.get("PRAGMA user_version")!.user_version) < 8) await result.transaction(() => {
        if (Number(result.get("PRAGMA user_version")!.user_version) >= 8) return;
        db.exec(`
          ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(acceptance_criteria) AND json_type(acceptance_criteria) = 'array');
          DROP TRIGGER task_definition_changed;
          CREATE TRIGGER task_definition_changed AFTER UPDATE OF title, body, repo, kind, acceptance_criteria ON tasks
            WHEN NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body OR NEW.repo IS NOT OLD.repo OR NEW.kind IS NOT OLD.kind
              OR NEW.acceptance_criteria IS NOT OLD.acceptance_criteria
            BEGIN UPDATE tasks SET definition_revision = OLD.definition_revision + 1 WHERE id = NEW.id; END;
          PRAGMA user_version = 8;
        `);
      });
      if (Number(result.get("PRAGMA user_version")!.user_version) < 9) await result.transaction(() => {
        if (Number(result.get("PRAGMA user_version")!.user_version) >= 9) return;
        db.exec(`
          CREATE TABLE review_tasks (
            task TEXT PRIMARY KEY REFERENCES tasks(id), context TEXT NOT NULL,
            reviewed_task TEXT NOT NULL, reviewed_attempt INTEGER NOT NULL,
            target TEXT NOT NULL CHECK(json_valid(target)), acceptance_criteria TEXT NOT NULL CHECK(json_valid(acceptance_criteria)),
            backing_repository TEXT NOT NULL,
            FOREIGN KEY(context, reviewed_task, reviewed_attempt) REFERENCES attempt_numbers(context, task, number));
          CREATE TRIGGER review_tasks_immutable BEFORE UPDATE ON review_tasks BEGIN
            SELECT RAISE(ABORT, 'Review targets cannot be changed');
          END;
          CREATE TRIGGER review_tasks_not_removed BEFORE DELETE ON review_tasks BEGIN
            SELECT RAISE(ABORT, 'Review targets cannot be removed');
          END;
          PRAGMA user_version = 9;
        `);
      });
      if (Number(result.get("PRAGMA user_version")!.user_version) < 10) await result.transaction(() => {
        if (Number(result.get("PRAGMA user_version")!.user_version) >= 10) return;
        db.exec(`
          CREATE TABLE objectives (
            id TEXT PRIMARY KEY, request TEXT NOT NULL,
            acceptance_criteria TEXT NOT NULL CHECK(json_valid(acceptance_criteria) AND json_type(acceptance_criteria) = 'array'),
            scope TEXT NOT NULL, constraints TEXT NOT NULL,
            permissions TEXT NOT NULL CHECK(json_valid(permissions)), budget TEXT NOT NULL CHECK(json_valid(budget)), deadline TEXT,
            created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT,
            state TEXT NOT NULL CHECK(state IN ('open','completed','abandoned')),
            completion_statements TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(completion_statements)));
          CREATE TABLE objective_changes (
            objective TEXT NOT NULL REFERENCES objectives(id), sequence INTEGER NOT NULL,
            action TEXT NOT NULL, changed_by TEXT NOT NULL, changed_at TEXT NOT NULL,
            changes TEXT NOT NULL CHECK(json_valid(changes)), PRIMARY KEY(objective, sequence));
          CREATE TRIGGER objective_changes_immutable BEFORE UPDATE ON objective_changes BEGIN
            SELECT RAISE(ABORT, 'Objective changes cannot be changed'); END;
          CREATE TRIGGER objective_changes_not_removed BEFORE DELETE ON objective_changes BEGIN
            SELECT RAISE(ABORT, 'Objective changes cannot be removed'); END;
          ALTER TABLE tasks ADD COLUMN objective_id TEXT REFERENCES objectives(id);
          CREATE INDEX tasks_by_objective ON tasks(objective_id);
          DROP TRIGGER task_definition_changed;
          CREATE TRIGGER task_definition_changed AFTER UPDATE OF title, body, repo, kind, acceptance_criteria, objective_id ON tasks
            WHEN NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body OR NEW.repo IS NOT OLD.repo OR NEW.kind IS NOT OLD.kind
              OR NEW.acceptance_criteria IS NOT OLD.acceptance_criteria OR NEW.objective_id IS NOT OLD.objective_id
            BEGIN UPDATE tasks SET definition_revision = OLD.definition_revision + 1 WHERE id = NEW.id; END;
          PRAGMA user_version = 10;
        `);
      });
      if (Number(result.get("PRAGMA user_version")!.user_version) < 11) await result.transaction(() => {
        if (Number(result.get("PRAGMA user_version")!.user_version) >= 11) return;
        db.exec(`
          CREATE TABLE task_changes (
            sequence INTEGER PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id), action TEXT NOT NULL,
            changed_by TEXT NOT NULL, changed_at TEXT NOT NULL,
            changes TEXT NOT NULL CHECK(json_valid(changes)));
          CREATE TRIGGER task_changes_immutable BEFORE UPDATE ON task_changes BEGIN
            SELECT RAISE(ABORT, 'Task changes cannot be changed'); END;
          CREATE TRIGGER task_changes_not_removed BEFORE DELETE ON task_changes BEGIN
            SELECT RAISE(ABORT, 'Task changes cannot be removed'); END;
          PRAGMA user_version = 11;
        `);
      });
      if (Number(result.get("PRAGMA user_version")!.user_version) < 12) await result.transaction(() => {
        if (Number(result.get("PRAGMA user_version")!.user_version) >= 12) return;
        db.exec(`
          CREATE TABLE worker_usage (
            directory TEXT PRIMARY KEY REFERENCES launches(directory) ON DELETE CASCADE,
            observed_at TEXT NOT NULL, cost REAL NOT NULL CHECK(cost >= 0), tokens REAL NOT NULL CHECK(tokens >= 0));
          PRAGMA user_version = 12;
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
  async vacuumInto(path: string): Promise<void> {
    if (!isAbsolute(path)) throw new Error("Staging path must be absolute");
    await this.retry(() => this.db.prepare("VACUUM INTO ?").run(path));
  }
}
