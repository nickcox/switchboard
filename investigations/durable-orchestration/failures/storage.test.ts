import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { ApplicationStore } from "../design-a/store.ts";

const root = fileURLToPath(new URL("../../../.investigation/durable-orchestration/", import.meta.url));
const report = process.env.MATRIX_REPORT ?? join(root, "matrix-results.jsonl");
const repeats = Number(process.env.MATRIX_REPEATS ?? 3);
function run(file: string, directory: string, mode: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => execFile(process.execPath, [fileURLToPath(new URL(file, import.meta.url)), directory, mode], { timeout: 12_000 }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") reject(error); else resolve({ code: error?.code as number ?? 0, stdout, stderr });
  }));
}
async function temporary() { await mkdir(root, { recursive: true }); return mkdtemp(join(root, "storage-matrix-")); }
async function record(value: object) { await appendFile(report, JSON.stringify(value) + "\n", { flush: true }); }

for (let repeat = 1; repeat <= repeats; repeat++) {
  test(`B unfinished SQLite 1.3.0 to 1.4.0 upgrade, missing definition and offline rollback repeat ${repeat}`, async t => {
    const directory = await temporary();
    t.after(() => rm(directory, { recursive: true, force: true }));
    const old = await run("./upgrade-old.ts", directory, "start");
    assert.equal(old.code, 75, old.stderr);
    const backup = join(directory, "offline-backup");
    await mkdir(backup);
    // All writers have exited. Preserve the complete SQLite file set, including committed WAL.
    for (const name of await readdir(directory)) if (name.startsWith("durable.db")) await cp(join(directory, name), join(backup, name));
    const missing = await run("./storage-child.ts", directory, "missing");
    assert.equal(missing.code, 0, missing.stderr);
    const blocked = JSON.parse(missing.stdout)[0];
    assert.deepEqual(blocked.state, { kind: "blocked", reason: "missing_task" });
    assert.equal(blocked.record.state.checkpoint.phase, "finish");
    const upgraded = await run("./storage-child.ts", directory, "resume");
    assert.equal(upgraded.code, 0, upgraded.stderr);
    assert.equal((await readFile(join(directory, "effects.jsonl"), "utf8")), "prepare\nfinish-new\n");
    const downgrade = await run("./upgrade-old.ts", directory, "inspect");
    assert.equal(downgrade.code, 2);
    assert.match(downgrade.stderr, /schema|version|newer/i);
    // Rollback is replacement from a stopped, pre-upgrade backup, not opening upgraded files
    // with an older engine. Do not resume it: external effects after backup would need reconciliation.
    for (const name of await readdir(directory)) if (name.startsWith("durable.db")) await rm(join(directory, name));
    for (const name of await readdir(backup)) await cp(join(backup, name), join(directory, name));
    const restored = await run("./upgrade-old.ts", directory, "inspect");
    assert.equal(restored.code, 0, restored.stderr);
    assert.equal(JSON.parse(restored.stdout)[0].record.state.checkpoint.phase, "finish");
    assert.equal(await readFile(join(directory, "effects.jsonl"), "utf8"), "prepare\nfinish-new\n");
    await record({ design: "B", repeat, case: "unfinished_upgrade_missing_definition_rollback", oldExit: old.code, blocked: blocked.state,
      checkpoint: blocked.record.state.checkpoint, upgradeExit: upgraded.code, downgradeError: downgrade.stderr.trim(), restoredWithoutResume: true });
  });

  for (const timing of ["before", "after"]) test(`B engine commit fails ${timing} publication repeat ${repeat}`, async t => {
    const directory = await temporary();
    t.after(() => rm(directory, { recursive: true, force: true }));
    const failed = await run("./storage-child.ts", directory, `fault-${timing}`);
    assert.equal(failed.code, 77, failed.stderr);
    assert.equal(await readFile(join(directory, "effects.jsonl"), "utf8"), "prepare\n");
    const reopened = await run("./storage-child.ts", directory, "inspect");
    assert.equal(reopened.code, 0, reopened.stderr);
    const task = JSON.parse(reopened.stdout)[0];
    assert.equal(task.record.state.checkpoint.phase, timing === "before" ? "prepare" : "finish");
    assert.equal(await readFile(join(directory, "effects.jsonl"), "utf8"), "prepare\n", "Inspection must never replay an effect");
    await record({ design: "B", repeat, case: `engine_commit_failure_${timing}`, failure: JSON.parse(failed.stdout),
      reopened: task.record.state, operatorMustInspectEffectBeforeResume: true });
  });
}

test("storage settings are measured on configured connections, separately from crash results", async t => {
  const directory = await temporary();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = await ApplicationStore.open(join(directory, "application"));
  const engine = await openNodeSqliteDatabase(join(directory, "engine.db"));
  try {
    const settings = ["journal_mode", "synchronous", "fullfsync", "checkpoint_fullfsync", "busy_timeout", "wal_autocheckpoint"];
    const application: Record<string, unknown> = {};
    const durable: Record<string, unknown> = {};
    for (const setting of settings) {
      application[setting] = app.tasks.database.get(`PRAGMA ${setting}`);
      durable[setting] = await engine.get(`PRAGMA ${setting}`);
    }
    assert.equal((application.synchronous as { synchronous: number }).synchronous, 2);
    assert.equal((durable.synchronous as { synchronous: number }).synchronous, 1);
    await record({ case: "storage_settings_not_power_loss_evidence", platform: process.platform, node: process.version, application, durable });
  } finally { app.close(); await engine.close(); }
});
