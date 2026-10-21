// Trial for ADR-0007: Switchboard's tasks and attempt records in one SQLite database, through node:sqlite.
// Run from the repository root: node investigations/sqlite-trial/trial.ts
// Each check prints PASS or FAIL, and the exit status is 1 if any failed; the timings are printed last. Nothing outside .investigation/sqlite-trial/ is touched.
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const self = resolve(import.meta.filename);
const run = promisify(execFile);

function open(path: string, busyMs = 5000): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: busyMs });
  db.exec(`
    PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON; PRAGMA checkpoint_fullfsync = ON; PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, repo TEXT, position INTEGER NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('queued', 'in_flight', 'done')) DEFAULT 'queued', hold_reason TEXT);
    CREATE TABLE IF NOT EXISTS deps (
      task TEXT NOT NULL REFERENCES tasks(id), blocked_by TEXT NOT NULL REFERENCES tasks(id),
      PRIMARY KEY (task, blocked_by), CHECK (task <> blocked_by));
    CREATE TABLE IF NOT EXISTS attempts (
      context TEXT NOT NULL, task TEXT NOT NULL REFERENCES tasks(id), attempt INTEGER NOT NULL,
      request_id TEXT, open INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (context, task, attempt), UNIQUE (context, request_id));
    CREATE TABLE IF NOT EXISTS entries (
      context TEXT NOT NULL, task TEXT NOT NULL, attempt INTEGER NOT NULL, sequence INTEGER NOT NULL,
      kind TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (context, task, attempt, sequence),
      FOREIGN KEY (context, task, attempt) REFERENCES attempts(context, task, attempt));
    -- One row per attempt, created either by the dispatcher (permission to launch) or by finish, discard or resolve
    -- (a fence): whichever is created first wins, and nothing removes it.
    CREATE TABLE IF NOT EXISTS launches (
      context TEXT NOT NULL, task TEXT NOT NULL, attempt INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('launch', 'fence')),
      PRIMARY KEY (context, task, attempt));`);
  return db;
}

const readySql = `
  SELECT t.id FROM tasks t WHERE t.state = 'queued' AND t.hold_reason IS NULL AND (?1 IS NULL OR t.repo = ?1)
    AND NOT EXISTS (SELECT 1 FROM deps d JOIN tasks b ON b.id = d.blocked_by WHERE d.task = t.id AND b.state <> 'done')
  ORDER BY t.position`;

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const value = fn(); db.exec("COMMIT"); return value; }
  catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
}

const entry = (db: DatabaseSync, context: string, task: string, attempt: number, kind: string, data: object) => {
  const sequence = (db.prepare("SELECT max(sequence) AS s FROM entries WHERE context = ? AND task = ? AND attempt = ?").get(context, task, attempt)?.s as number | null ?? -1) + 1;
  db.prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?)").run(context, task, attempt, sequence, kind, JSON.stringify(data));
};

// Step 1 of dispatch: check capacity and eligibility, then create the attempt (which reserves the task) and its
// reservation. The task is not started until the lease is acquired.
function createAttempt(db: DatabaseSync, context: string, max: number, requestId?: string): { task: string; attempt: number } | { refused: string } {
  return transaction(db, () => {
    if (requestId !== undefined && db.prepare("SELECT 1 FROM attempts WHERE context = ? AND request_id = ?").get(context, requestId)) return { refused: "request ID already used" };
    const active = db.prepare("SELECT count(*) AS n FROM attempts WHERE context = ? AND open = 1").get(context)!.n as number;
    if (active >= max) return { refused: "at maximum" };
    const busy = new Set(db.prepare("SELECT task FROM attempts WHERE context = ? AND open = 1").all(context).map(r => r.task as string));
    const task = db.prepare(readySql).all(null).map(r => r.id as string).find(id => !busy.has(id));
    if (task === undefined) return { refused: "no ready work" };
    const attempt = (db.prepare("SELECT max(attempt) AS m FROM attempts WHERE context = ? AND task = ?").get(context, task)?.m as number | null ?? 0) + 1;
    db.prepare("INSERT INTO attempts (context, task, attempt, request_id) VALUES (?, ?, ?, ?)").run(context, task, attempt, requestId ?? null);
    entry(db, context, task, attempt, "requested", {});
    return { task, attempt };
  });
}

// Step 3 of dispatch, after the lease is acquired: check readiness again, start the task and record it, together.
function startTask(db: DatabaseSync, context: string, task: string, attempt: number): boolean {
  return transaction(db, () => {
    if (!db.prepare(readySql).all(null).some(r => r.id === task)) return false;
    db.prepare("UPDATE tasks SET state = 'in_flight' WHERE id = ?").run(task);
    entry(db, context, task, attempt, "task_started", {});
    return true;
  });
}

// Recording an outcome: the entry, the task's hold and closing the attempt, together. The task is changed only if it is
// still in flight, so a newer operator decision is never overwritten.
function recordHold(db: DatabaseSync, context: string, task: string, attempt: number, reason: string): "recorded" | "task_changed" {
  return transaction(db, () => {
    const changed = db.prepare("UPDATE tasks SET state = 'queued', hold_reason = ? WHERE id = ? AND state = 'in_flight'").run(reason, task).changes;
    entry(db, context, task, attempt, "task_recorded", { outcome: "hold", reason, applied: changed === 1 });
    db.prepare("UPDATE attempts SET open = 0 WHERE context = ? AND task = ? AND attempt = ?").run(context, task, attempt);
    return changed === 1 ? "recorded" : "task_changed";
  });
}

function claimLaunch(db: DatabaseSync, context: string, task: string, attempt: number, kind: "launch" | "fence"): boolean {
  try { db.prepare("INSERT INTO launches VALUES (?, ?, ?, ?)").run(context, task, attempt, kind); return true; }
  catch (error) { if (String(error).includes("UNIQUE")) return false; throw error; }
}

// Child-process modes, started by the checks below.
const [mode, path, arg] = process.argv.slice(2);
if (mode === "create") {
  // These processes exit without closing the database. On Windows that can make another process's open fail for a
  // moment with SQLITE_IOERR_TRUNCATE (1546), so opening retries it, as Switchboard's Database.open does.
  let db: DatabaseSync | undefined;
  for (const deadline = Date.now() + 5000; !db;) {
    try { db = open(path!); }
    catch (error) {
      if ((error as { errcode?: number }).errcode !== 1546 || Date.now() > deadline) throw error;
      await sleep(20);
    }
  }
  process.stdout.write(`${JSON.stringify(createAttempt(db, "ctx", Number(arg)))}\n`);
  process.exit(0);
}
if (mode === "hold-lock") {
  const db = open(path!);
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO attempts (context, task, attempt) VALUES ('ctx', 't0', 99)").run();
  process.stdout.write("holding\n");
  setInterval(() => {}, 1000); // killed by the parent while the transaction is open
} else if (mode === undefined) {
  await checks();
}

async function checks() {
  const root = resolve(".investigation/sqlite-trial");
  mkdirSync(root, { recursive: true });
  const check = (label: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
    if (!ok) process.exitCode = 1;
  };
  const fresh = () => { const file = join(mkdtempSync(join(root, "case-")), "switchboard.db"); return { file, db: open(file) }; };
  const add = (db: DatabaseSync, id: string, repo = "fx", hold: string | null = null) =>
    db.prepare("INSERT INTO tasks (id, title, repo, position, hold_reason) VALUES (?, ?, ?, (SELECT coalesce(max(position), 0) + 1 FROM tasks), ?)").run(id, `Task ${id}`, repo, hold);

  // Readiness as one query.
  {
    const { db } = fresh();
    add(db, "a1"); add(db, "b1"); add(db, "c1", "other"); add(db, "d1", "fx", "Waiting"); add(db, "e1");
    db.prepare("INSERT INTO deps VALUES ('b1', 'a1')").run();
    const ready = () => db.prepare(readySql).all("fx").map(r => r.id).join(",");
    check("ready excludes blocked, held and other-repository tasks, in order", ready() === "a1,e1", ready());
    db.prepare("UPDATE tasks SET state = 'done' WHERE id = 'a1'").run();
    check("a blocked task becomes ready once its blocker is done", ready() === "b1,e1", ready());
    let refused = false;
    try { db.prepare("INSERT INTO deps VALUES ('e1', 'e1')").run(); } catch { refused = true; }
    check("a self-dependency is refused", refused);
  }

  // Dispatch in the agreed order: the attempt reserves the task, and the task starts only after the lease.
  {
    const { db } = fresh(); add(db, "a1");
    const created = createAttempt(db, "ctx", 2);
    const state = () => db.prepare("SELECT state FROM tasks WHERE id = 'a1'").get()!.state;
    check("creating the attempt leaves the task queued", "task" in created && state() === "queued");
    check("a second dispatch does not take the reserved task", "refused" in createAttempt(db, "ctx", 2));
    check("starting after the lease marks the task in flight and records it together", startTask(db, "ctx", "a1", 1) && state() === "in_flight");
    db.prepare("UPDATE tasks SET state = 'done' WHERE id = 'a1'").run(); // the operator decides while the worker runs
    check("recording an outcome does not overwrite a newer operator decision", recordHold(db, "ctx", "a1", 1, "Switchboard attempt 1 failed") === "task_changed" && state() === "done");
    add(db, "z1");
    let failed = false;
    try { transaction(db, () => { db.prepare("UPDATE tasks SET state = 'in_flight' WHERE id = 'z1'").run(); entry(db, "ctx", "missing", 1, "requested", {}); }); }
    catch { failed = true; }
    check("a failure partway through a transaction leaves no partial change", failed && db.prepare("SELECT state FROM tasks WHERE id = 'z1'").get()!.state === "queued");
  }

  // The attempt maximum across processes.
  {
    const { file, db } = fresh(); for (let i = 0; i < 10; i++) add(db, `t${i}`); db.close();
    const results = await Promise.all(Array.from({ length: 8 }, () => run(process.execPath, [self, "create", file, "3"]).then(r => JSON.parse(r.stdout))));
    const started = results.filter(r => r.task);
    check("8 processes creating attempts at once with a maximum of 3 create exactly 3, for different tasks",
      started.length === 3 && new Set(started.map(r => r.task)).size === 3, JSON.stringify(results.map(r => r.task ?? r.refused)));
  }

  // A request ID used twice.
  {
    const { db } = fresh(); add(db, "a1"); add(db, "b1");
    createAttempt(db, "ctx", 5, "req-1");
    check("a request ID creates at most one attempt in a context", "refused" in createAttempt(db, "ctx", 5, "req-1"));
  }

  // Launch exclusion: the dispatcher's launch and a fence from finish, discard or resolve contend for one row.
  {
    const { db } = fresh(); add(db, "a1"); createAttempt(db, "ctx", 1);
    check("a fence written first stops the launch", claimLaunch(db, "ctx", "a1", 1, "fence") && !claimLaunch(db, "ctx", "a1", 1, "launch"));
    add(db, "b1"); db.prepare("UPDATE attempts SET open = 0").run(); createAttempt(db, "ctx", 1);
    check("a launch claimed first refuses the fence", claimLaunch(db, "ctx", "b1", 1, "launch") && !claimLaunch(db, "ctx", "b1", 1, "fence"));
  }

  // A process killed while holding the write lock.
  {
    const { file, db } = fresh(); add(db, "t0"); db.close();
    const child = spawn(process.execPath, [self, "hold-lock", file]);
    await new Promise(done => child.stdout.once("data", done));
    const blocked = open(file, 0);
    let refused = "";
    try { blocked.exec("BEGIN IMMEDIATE"); } catch (error) { refused = String(error); }
    check("another process cannot write while the lock is held", /locked|busy/i.test(refused), refused.split("\n")[0]);
    child.kill("SIGKILL"); await new Promise(done => child.on("exit", done));
    const next = open(file);
    check("after the holder is killed, its change is gone and the next writer proceeds",
      "task" in createAttempt(next, "ctx", 1) && next.prepare("SELECT count(*) AS n FROM attempts WHERE attempt = 99").get()!.n === 0);
  }

  // Waiting for the lock without blocking the event loop: a zero busy timeout, retried asynchronously.
  {
    const { file, db } = fresh(); add(db, "t0"); db.close();
    const child = spawn(process.execPath, [self, "hold-lock", file]);
    await new Promise(done => child.stdout.once("data", done));
    const writer = open(file, 0);
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    setTimeout(() => child.kill("SIGKILL"), 300);
    for (;;) {
      try { writer.exec("BEGIN IMMEDIATE"); writer.exec("COMMIT"); break; }
      catch (error) { if (!/locked|busy/i.test(String(error))) throw error; await sleep(20); }
    }
    clearInterval(timer);
    check("a writer retrying asynchronously keeps the event loop running while it waits", ticks >= 10, `${ticks} timer ticks while waiting`);
  }

  // Timings with synchronous = FULL and fullfsync, which on macOS forces the drive's cache to storage (F_FULLFSYNC).
  {
    const { db } = fresh(); add(db, "big");
    db.prepare("INSERT INTO attempts (context, task, attempt) VALUES ('ctx', 'big', 1)").run();
    const insert = db.prepare("INSERT INTO entries VALUES ('ctx', 'big', 1, ?, 'operator_request', ?)");
    let started = performance.now();
    transaction(db, () => { for (let i = 0; i < 10000; i++) insert.run(i, JSON.stringify({ i })); });
    const write = performance.now() - started;
    started = performance.now();
    const rows = db.prepare("SELECT * FROM entries WHERE context = 'ctx' AND task = 'big' AND attempt = 1 ORDER BY sequence").all();
    const read = performance.now() - started;
    started = performance.now();
    for (let i = 0; i < 200; i++) transaction(db, () => insert.run(10000 + i, "{}"));
    const each = (performance.now() - started) / 200;
    console.log(`timing: 10,000 entries written in one transaction in ${write.toFixed(0)} ms, read in ${read.toFixed(1)} ms (${rows.length} rows); one entry per transaction ${each.toFixed(2)} ms`);
  }
}
