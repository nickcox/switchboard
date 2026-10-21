// Stress test for concurrent opens of one SQLite database, after the trial's eight-process check failed once on
// Windows with SQLITE_IOERR_TRUNCATE (1546) while opening. Run from the repository root:
//   node investigations/sqlite-trial/stress.ts [iterations]
// Each iteration creates a fresh database, then starts eight processes at once that each open it and commit one row.
// The summary gives, for each way of opening, how many of those processes failed and with which error.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

const self = resolve(import.meta.filename);
const variants = {
  // As the trial and Database.open do: switch to WAL and run the schema statements on every open.
  "wal-every-open": { walOnOpen: true, schemaOnOpen: true, mmapOff: false, retryOpen: false, busyMs: 0, exitWithoutClose: false },
  // As the trial does: SQLite's own busy timeout, so SQLite waits and retries inside its locking code.
  "wal-every-open-busy-timeout": { walOnOpen: true, schemaOnOpen: true, mmapOff: false, retryOpen: false, busyMs: 5000, exitWithoutClose: false },
  // WAL and the schema are set once, when the database is created; later opens only set per-connection options.
  // As the trial's processes do: exit straight after committing, without closing the database, as a crash would.
  "wal-every-open-exit": { walOnOpen: true, schemaOnOpen: true, mmapOff: false, retryOpen: false, busyMs: 0, exitWithoutClose: true },
  "wal-every-open-busy-timeout-exit": { walOnOpen: true, schemaOnOpen: true, mmapOff: false, retryOpen: false, busyMs: 5000, exitWithoutClose: true },
  "wal-once-exit": { walOnOpen: false, schemaOnOpen: false, mmapOff: false, retryOpen: false, busyMs: 0, exitWithoutClose: true },
  "wal-every-open-retry-exit": { walOnOpen: true, schemaOnOpen: true, mmapOff: false, retryOpen: true, busyMs: 0, exitWithoutClose: true },
  "wal-once-retry-exit": { walOnOpen: false, schemaOnOpen: false, mmapOff: false, retryOpen: true, busyMs: 0, exitWithoutClose: true },
  "wal-once": { walOnOpen: false, schemaOnOpen: false, mmapOff: false, retryOpen: false, busyMs: 0, exitWithoutClose: false },
  "wal-once-mmap-off": { walOnOpen: false, schemaOnOpen: false, mmapOff: true, retryOpen: false, busyMs: 0, exitWithoutClose: false },
  // As every open, but an I/O error while opening is retried.
  "wal-every-open-retry": { walOnOpen: true, schemaOnOpen: true, mmapOff: false, retryOpen: true, busyMs: 0, exitWithoutClose: false },
} as const;
type Variant = keyof typeof variants;
const schema = "CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY, writer TEXT NOT NULL)";
const isBusy = (error: unknown) => /locked|busy/i.test(String(error));

async function child(variant: Variant, path: string): Promise<void> {
  const options = variants[variant];
  let stage = "open";
  const report = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const deadline = Date.now() + 15000;
  const retrying = async <T>(fn: () => T, retryIo: boolean): Promise<T> => {
    for (;;) {
      try { return fn(); }
      catch (error) {
        const io = (error as { errcode?: number }).errcode !== undefined && ((error as { errcode: number }).errcode & 0xff) === 10;
        if (!(isBusy(error) || (retryIo && io)) || Date.now() > deadline) throw error;
        await sleep(20);
      }
    }
  };
  try {
    const db = await retrying(() => {
      const opened = new DatabaseSync(path, { timeout: options.busyMs });
      try {
        if (options.mmapOff) opened.exec("PRAGMA mmap_size = 0");
        if (options.walOnOpen) opened.exec("PRAGMA journal_mode = WAL");
        opened.exec("PRAGMA synchronous = FULL; PRAGMA fullfsync = ON; PRAGMA foreign_keys = ON");
        if (options.schemaOnOpen) opened.exec(schema);
        return opened;
      } catch (error) { opened.close(); throw error; }
    }, options.retryOpen);
    stage = "write";
    await retrying(() => {
      db.exec("BEGIN IMMEDIATE");
      try { db.prepare("INSERT INTO rows (writer) VALUES (?)").run(String(process.pid)); db.exec("COMMIT"); }
      catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    }, false);
    if (options.exitWithoutClose) { report({ ok: true }); process.exit(0); }
    db.close();
    report({ ok: true });
  } catch (error) {
    report({ ok: false, stage, code: (error as { errcode?: number }).errcode ?? null, error: String(error).split("\n")[0] });
  }
}

async function main(iterations: number): Promise<void> {
  const root = resolve(".investigation/sqlite-stress");
  mkdirSync(root, { recursive: true });
  console.log(`platform ${process.platform}, Node.js ${process.version}, ${iterations} iterations of 8 processes per variant`);
  for (const variant of (Object.keys(variants) as Variant[]).filter(v => !only || only.includes(v))) {
    const failures: Record<string, number> = {};
    let processes = 0, failed = 0, lost = 0;
    const started = performance.now();
    for (let i = 0; i < iterations; i++) {
      const path = join(mkdtempSync(join(root, `${variant}-`)), "switchboard.db");
      const setup = new DatabaseSync(path);
      setup.exec("PRAGMA journal_mode = WAL");
      setup.exec(schema);
      setup.close();
      const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<{ ok: boolean; stage?: string; code?: number | null; error?: string }>(done => {
        execFile(process.execPath, [self, "child", variant, path], (error, stdout) => {
          try { done(JSON.parse(stdout)); }
          catch { done({ ok: false, stage: "process", code: null, error: String(error ?? stdout).split("\n")[0] }); }
        });
      })));
      processes += results.length;
      for (const result of results.filter(r => !r.ok)) {
        failed += 1;
        const key = `${result.stage} ${result.code ?? ""} ${result.error ?? ""}`.trim();
        failures[key] = (failures[key] ?? 0) + 1;
      }
      const check = new DatabaseSync(path);
      const rows = Number(check.prepare("SELECT count(*) AS n FROM rows").get()!.n);
      check.close();
      lost += results.filter(r => r.ok).length - rows;
    }
    console.log(`${variant}: ${failed} of ${processes} processes failed; ${lost} reported commits missing; ${((performance.now() - started) / 1000).toFixed(0)} s`);
    for (const [key, count] of Object.entries(failures)) console.log(`  ${count} x ${key}`);
  }
}

const [mode, variant, path] = process.argv.slice(2);
const only = process.env.STRESS_VARIANTS?.split(",");
if (mode === "child") await child(variant as Variant, path!);
else await main(Number(mode ?? "60"));
