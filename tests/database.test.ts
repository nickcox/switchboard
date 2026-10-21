import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Database } from "../src/database.ts";

const run = promisify(execFile);
const opener = resolve(import.meta.dirname, "fixtures/database-open.ts");
const evidence = resolve(import.meta.dirname, "../.investigation/database-unit");
mkdirSync(evidence, { recursive: true });

// On Windows, opening fails now and then with SQLITE_IOERR_TRUNCATE just after another process exited without closing
// the database (investigations/sqlite-trial/README.md). Opening retries it, so none of these processes may fail.
test("processes opening the database at once, each exiting without closing it, all open and commit", { timeout: 120_000 }, async () => {
  for (let round = 0; round < 20; round++) {
    const path = join(mkdtempSync(join(evidence, "case-")), "switchboard.db");
    (await Database.open(path)).close();
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => run(process.execPath, [opener, path, `task-${i}`])));
    const failed = results.flatMap(r => (r.status === "rejected" ? [String((r.reason as { stderr?: string }).stderr ?? r.reason).split("\n").find(l => /Error/.test(l))] : []));
    assert.deepEqual(failed, [], `round ${round}`);
    const db = await Database.open(path);
    try { assert.equal(Number(db.get("SELECT count(*) AS n FROM tasks")!.n), 8); }
    finally { db.close(); }
  }
});
