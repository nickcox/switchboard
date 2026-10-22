import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { importAttempts, importRuntime } from "../../src/attempts/import.ts";
import { AttemptStore } from "../../src/attempts/store.ts";
import { configSchema, databasePath } from "../../src/config.ts";
import { RuntimeRecords, key, writeOnce } from "../../src/runtime/records.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";
import { LegacyAttempts } from "../fixtures/legacy-attempts.ts";
import { LegacyRuntimeFixture } from "../fixtures/legacy-runtime.ts";

async function fixture() {
  const root = resolve(".investigation/runtime-import-unit");
  await mkdir(root, { recursive: true });
  const directory = await realpath(await mkdtemp(join(root, "case-")));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const config = configSchema.parse({ contextId: "context", runtimeRoot: join(directory, "runtime"), tasks: { repo: "fixture" },
    workspaces: { repository: join(directory, "repository"), poolRoot: join(directory, "pool") }, delivery: { baseRef: "main" },
    worker: { piEntrypoint: resolve("src/cli.ts"), provider: "fixture", model: "fixture" } });
  const tasks = await SqliteTaskStore.open({ path: databasePath(config) });
  for (const id of ["observed", "confirmed"]) await tasks.add({ id, title: id });
  tasks.close();
  const attempts = new LegacyAttempts(config.runtimeRoot, config.contextId);
  const runtime = new LegacyRuntimeFixture(config.runtimeRoot);
  const record = async (id: string) => {
    const ref = await attempts.create(id, {}, 0);
    const sessionId = randomUUID();
    const leaseId = `lease-${id}`;
    await attempts.append(ref, "leased", { leaseId, workspace, baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40) });
    await attempts.append(ref, "launched", { sessionId });
    await attempts.append(ref, "task_recorded", { outcome: "hold", reason: "Switchboard attempt 1 failed" });
    const reserved = await runtime.reserve({ identity: { contextId: "context", taskId: id, leaseId, sessionId }, workspace,
      instructions: "Fixture", acceptanceCriteria: [], delivery: { baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40),
        kind: "code", acceptance: "review_or_integration", requiredEvidence: [], requiredDeliverables: [] } });
    return { ref, ...reserved };
  };
  return { directory, config, attempts, runtime, record };
}

async function files(path: string): Promise<unknown> {
  const entries: Record<string, unknown> = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name.startsWith("switchboard.db")) continue;
    entries[entry.name] = entry.isDirectory() ? await files(join(path, entry.name)) : await readFile(join(path, entry.name), "utf8");
  }
  return entries;
}

test("runtime import normalises old paths, preserves exits, stop confirmations and worker files, and validates before activation", async () => {
  const f = await fixture();
  const observed = await f.record("observed");
  const confirmed = await f.record("confirmed");
  const observedAt = "2026-10-20T00:00:00.000Z";
  await f.runtime.recordChildExit(observed, { started: true, code: 0, signal: null });
  await f.runtime.recordOperatorStop(confirmed, "Checked by the operator");
  await writeOnce(join(observed.directory, "session-start.json"), { version: 1, identity: observed.binding.input.identity, observedAt, thinkingLevel: "high" });
  // Older bindings did not name an artefact directory and could use paths relative to their runtime directory.
  const { artefactDirectory: _artefacts, ...binding } = observed.binding;
  await writeFile(join(observed.directory, "binding.json"), JSON.stringify({ ...binding, sessionDirectory: "sessions", resultPath: "result.json" }));
  for (const record of [observed, confirmed]) {
    await mkdir(record.binding.sessionDirectory);
    await mkdir(record.binding.artefactDirectory);
    await writeFile(record.binding.resultPath, "worker result");
    await writeFile(join(record.binding.sessionDirectory, "session.jsonl"), "Pi transcript");
    await writeFile(join(record.binding.artefactDirectory, "report.md"), "Worker report");
  }
  const before = await files(f.config.runtimeRoot);
  await importAttempts(f.config);
  assert.deepEqual(await files(f.config.runtimeRoot), before, "Import must leave every old file unchanged");
  const tasks = await SqliteTaskStore.open({ path: databasePath(f.config) });
  try {
    const runtime = new RuntimeRecords(f.config.runtimeRoot, tasks.database);
    const records = await runtime.discover("context");
    assert.equal(records.length, 2);
    const exit = records.find(r => r.binding.input.identity.taskId === "observed")!;
    const stop = records.find(r => r.binding.input.identity.taskId === "confirmed")!;
    assert.deepEqual(exit.binding, observed.binding);
    assert.deepEqual(exit.child, { status: "exited", exit: { started: true, code: 0, signal: null } });
    assert.equal(exit.thinkingLevel, "high");
    assert.equal(stop.child.status, "operator_confirmed_stopped");
    if (stop.child.status === "operator_confirmed_stopped") assert.equal(stop.child.note, "Checked by the operator");
    assert.equal(tasks.database.get("SELECT recorded_at FROM worker_observations WHERE kind = 'session_start'")!.recorded_at, observedAt);
    assert.equal(new AttemptStore(tasks.database, "context").confirmations(confirmed.ref)[0]!.fact, "worker_stopped");
    assert.ok((await exit.storage.heartbeat(exit.claimId))!.released_at);
    assert.equal(await runtime.fence("context", "lease-observed"), false);
    await assert.rejects(runtime.reserve(observed.binding.input), /launch row/);
    assert.equal(await readFile(exit.binding.resultPath, "utf8"), "worker result");
    assert.equal(await readFile(join(exit.binding.sessionDirectory, "session.jsonl"), "utf8"), "Pi transcript");
    assert.equal(await readFile(join(exit.binding.artefactDirectory, "report.md"), "utf8"), "Worker report");
  } finally { tasks.close(); }
});

for (const claimed of [false, true]) test(`import refuses a ${claimed ? "claimed but unanswered" : "pending"} control request`, async () => {
  const f = await fixture();
  const record = await f.record("observed");
  await f.runtime.recordChildExit(record, { started: true, code: 0, signal: null });
  const directory = join(record.directory, "requests");
  await mkdir(directory);
  const id = randomUUID();
  await writeOnce(join(directory, `${id}.request.json`), { version: 1, id, kind: "stop", sender: "operator", identity: record.binding.input.identity, createdAt: new Date().toISOString() });
  if (claimed) await writeOnce(join(directory, `${id}.claim.json`), { version: 1, by: "dispatcher", at: new Date().toISOString() });
  await assert.rejects(importAttempts(f.config), /unanswered control requests/);
  const tasks = await SqliteTaskStore.open({ path: databasePath(f.config) });
  try { assert.equal(tasks.database.get("SELECT count(*) AS n FROM launches")!.n, 0); }
  finally { tasks.close(); }
  await writeOnce(join(directory, `${id}.${claimed ? "result" : "claim"}.json`), claimed
    ? { version: 1, outcome: "stopping", at: new Date().toISOString() }
    : { version: 1, by: "withdrawn", at: new Date().toISOString() });
  await importAttempts(f.config);
});

test("import refuses a launch whose directory was reserved before its binding was written", async () => {
  const f = await fixture();
  const ref = await f.attempts.create("observed", {}, 0);
  await f.attempts.append(ref, "leased", { leaseId: "pending", workspace: f.directory, baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40) });
  await f.attempts.append(ref, "launched", { sessionId: randomUUID() });
  await f.attempts.append(ref, "halted", { stage: "launch", reason: "dispatcher stopped" });
  const directory = join(f.config.runtimeRoot, key("context"), key("pending"));
  await mkdir(directory, { recursive: true });
  await assert.rejects(importAttempts(f.config), /may still be running/);
});

test("import --runtime brings the runtime files into a database whose attempts were imported before runtime records moved into it", async () => {
  const f = await fixture();
  const observed = await f.record("observed");
  const confirmed = await f.record("confirmed");
  await f.runtime.recordChildExit(observed, { started: true, code: 0, signal: null });
  await f.runtime.recordOperatorStop(confirmed, "Checked by the operator");
  await assert.rejects(importRuntime(f.config), /no attempts; use import --attempts/);
  // As in real records, each attempt recorded its worker's finish.
  for (const record of [observed, confirmed]) await f.attempts.append(record.ref, "worker_finished", { status: "reported", runtimeDirectory: record.directory });
  // Recreate that state: import the attempts with the runtime files out of the way, then remove the launch rows the
  // current import writes for leased attempts, which the older import did not.
  const context = join(f.config.runtimeRoot, key("context"));
  await rename(context, `${context}.hidden`);
  await importAttempts(f.config);
  await rename(`${context}.hidden`, context);
  const tasks = await SqliteTaskStore.open({ path: databasePath(f.config) });
  try {
    const trigger = String(tasks.database.get("SELECT sql FROM sqlite_master WHERE name = 'launches_not_removed'")!.sql);
    await tasks.database.transaction(() => {
      tasks.database.run("DROP TRIGGER launches_not_removed");
      tasks.database.run("DELETE FROM launches");
      tasks.database.run("DELETE FROM worker_claims");
      tasks.database.run(trigger);
    });
  } finally { tasks.close(); }
  const before = await files(f.config.runtimeRoot);
  const result = await importRuntime(f.config);
  assert.deepEqual({ ok: result.ok, runtime: result.runtime, fences: result.fences }, { ok: true, runtime: 2, fences: 0 });
  assert.deepEqual(await files(f.config.runtimeRoot), before, "Import must leave every old file unchanged");
  const reopened = await SqliteTaskStore.open({ path: databasePath(f.config) });
  try {
    const records = await new RuntimeRecords(f.config.runtimeRoot, reopened.database).discover("context");
    assert.deepEqual(records.find(r => r.binding.input.identity.taskId === "observed")!.child, { status: "exited", exit: { started: true, code: 0, signal: null } });
    const stop = records.find(r => r.binding.input.identity.taskId === "confirmed")!;
    assert.equal(stop.child.status, "operator_confirmed_stopped");
    if (stop.child.status === "operator_confirmed_stopped") assert.equal(stop.child.note, "Checked by the operator");
    assert.equal(new AttemptStore(reopened.database, "context").confirmations(confirmed.ref).filter(c => c.fact === "worker_stopped").length, 1);
  } finally { reopened.close(); }
  await assert.rejects(importRuntime(f.config), /already has runtime records/);
});
