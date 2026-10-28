import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { LegacyAttempts } from "../fixtures/legacy-attempts.ts";
import { AttemptStore, SqliteTaskStore, importAttempts } from "../caller.ts";
import { Database } from "../../src/database.ts";
import { configSchema, databasePath } from "../../src/config.ts";
import { key } from "../../src/runtime/records.ts";
import { LegacyRuntimeFixture as RuntimeRecords } from "../fixtures/legacy-runtime.ts";
import { specificationFor } from "../helpers.ts";

async function fixture() {
  const root = resolve(".investigation/attempt-import-unit");
  await mkdir(root, { recursive: true });
  const directory = await realpath(await mkdtemp(join(root, "case-")));
  const config = configSchema.parse({ contextId: "context", runtimeRoot: join(directory, "runtime"), tasks: { repo: "fixture" },
    workspaces: { repository: join(directory, "repository"), poolRoot: join(directory, "pool") }, delivery: { baseRef: "main" },
    worker: { piEntrypoint: resolve("src/cli.ts"), provider: "fixture", model: "fixture" } });
  const tasks = await SqliteTaskStore.open({ path: databasePath(config) });
  for (const id of ["settled", "pruned", "orphan"]) await tasks.add({ id, title: id, body: "Original instructions" });
  tasks.close();
  const legacy = new LegacyAttempts(config.runtimeRoot, config.contextId);
  return { directory, config, legacy };
}

async function files(path: string): Promise<unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name.startsWith("switchboard.db")) continue;
    result[entry.name] = entry.isDirectory() ? await files(join(path, entry.name)) : await readFile(join(path, entry.name), "utf8");
  }
  return result;
}

test("imports entries, old confirmations, orphan reservations and pruned numbers into the existing task database", async () => {
  const f = await fixture();
  const ref = await f.legacy.create("settled", { requestId: "settled-request" }, 0);
  await f.legacy.reserveRequest("settled-request", "settled");
  await f.legacy.append(ref, "leased", { leaseId: "lease", workspace: f.directory, baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40) });
  await f.legacy.append(ref, "task_started", {});
  await f.legacy.append(ref, "task_recorded", { outcome: "hold", reason: "Switchboard attempt 1 review required" });
  await f.legacy.append(ref, "output_accepted", { commit: "b".repeat(40), acceptedBy: "operator" });
  await f.legacy.append(ref, "lease_return_started", { leaseId: "lease", by: "finish", noProcessesConfirmedBy: "operator" });
  await f.legacy.append(ref, "lease_returned", { leaseId: "lease", by: "finish", noProcessesConfirmedBy: "operator" });
  const archiveDirectory = join(f.config.runtimeRoot, "archive", key("context"), key("pruned"));
  await mkdir(archiveDirectory, { recursive: true });
  await mkdir(join(f.config.runtimeRoot, "attempts", key("context"), key("pruned"), ".1.pruned"), { recursive: true });
  const recordedAt = "2026-10-20T00:00:00.000Z";
  await writeFile(join(archiveDirectory, "1.json"), JSON.stringify({
    version: 1, contextId: "context", taskId: "pruned", attempt: 1, archivedAt: recordedAt, finishedAt: recordedAt,
    requestId: "pruned-request", summary: { taskId: "pruned", attempt: 1, requestId: "pruned-request", entryCount: 2, facts: {
      requested: { recordedAt, data: { requestId: "pruned-request" } },
      halted: { recordedAt, data: { stage: "acquire", reason: "rejected" } },
    } },
  }));
  await f.legacy.reserveRequest("orphan-request", "orphan");
  const before = await files(f.config.runtimeRoot);
  const result = await importAttempts(f.config);
  assert.deepEqual({ count: result.count, reservations: result.reservations, pruned: result.pruned }, { count: 1, reservations: 2, pruned: 1 });
  assert.deepEqual(await files(f.config.runtimeRoot), before, "Old files must not change");
  const tasks = await SqliteTaskStore.open({ path: databasePath(f.config) });
  try {
    const attempts = new AttemptStore(tasks.database, "context");
    const entries = attempts.read(ref).entries;
    assert.equal(entries.find(e => e.kind === "task_recorded")!.data.category, "review_required");
    assert.deepEqual(entries.find(e => e.kind === "output_accepted")!.data, { commit: "b".repeat(40) });
    const confirmations = attempts.confirmations(ref);
    assert.deepEqual(confirmations.map(c => c.fact), ["output_accepted", "no_processes"]);
    assert.equal(confirmations[0]!.confirmedAt, entries.find(e => e.kind === "output_accepted")!.recordedAt);
    assert.ok(confirmations.every(c => c.confirmedBy === "operator" && c.attempt === 1));
    const intent = entries.find(e => e.kind === "lease_return_started")!;
    assert.equal((confirmations[1]!.scope as { returnId: string }).returnId, intent.data.returnId);
    assert.equal(entries.find(e => e.kind === "lease_returned")!.data.returnId, intent.data.returnId);
    assert.equal((await attempts.findByRequest("pruned-request"))?.attempt, 1);
    await assert.rejects(attempts.reserveAttempt({ taskId: "pruned", requested: { requestId: "pruned-request" }, maximum: 1, specification: specificationFor }), { reason: "request_reserved" });
    assert.equal((await attempts.reserveAttempt({ taskId: "pruned", requested: { requestId: "new-request" }, maximum: 1, specification: specificationFor })).ref.attempt, 2);
    await assert.rejects(attempts.reserveAttempt({ taskId: "orphan", requested: { requestId: "orphan-request" }, maximum: 2, specification: specificationFor }), { reason: "request_reserved" });
    assert.equal((await tasks.read("settled"))!.body, "Original instructions");
    assert.equal(Number(tasks.database.get("SELECT count(*) AS n FROM archived_attempts")!.n), 1);
  } finally { tasks.close(); }
  await assert.rejects(importAttempts(f.config), /already has attempts/);
});

test("the attempt import CLI activates once and reports repeat and usage refusals", async () => {
  const f = await fixture();
  const ref = await f.legacy.create("settled", {}, 0);
  await f.legacy.append(ref, "halted", { stage: "acquire", reason: "rejected" });
  const config = join(f.directory, "switchboard.json");
  await writeFile(config, JSON.stringify(f.config));
  const run = (...args: string[]) => spawnSync(process.execPath, [resolve("src/cli.ts"), "import", ...args, "--json", "--config", config], { encoding: "utf8" });
  const result = run("--attempts");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).count, 1);
  const repeated = run("--attempts");
  assert.equal(repeated.status, 1, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).reason, "rejected");
  assert.equal(run("--attempts", "--tasks-axi", "unused.md").status, 2);
});

test("imports discard, worker-stop and lease-return confirmations with their exact scopes", async () => {
  const f = await fixture();
  const ref = await f.legacy.create("settled", {}, 0);
  const sessionId = randomUUID();
  await f.legacy.append(ref, "leased", { leaseId: "lease", workspace: f.directory, baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40) });
  await f.legacy.append(ref, "launched", { sessionId });
  await f.legacy.append(ref, "operator_resolved", { action: "worker_stopped" });
  await f.legacy.append(ref, "discarded", { note: "No longer wanted" });
  await f.legacy.append(ref, "operator_resolved", { action: "lease_returned" });
  await importAttempts(f.config);
  const tasks = await SqliteTaskStore.open({ path: databasePath(f.config) });
  try {
    const records = new AttemptStore(tasks.database, "context").confirmations(ref);
    assert.deepEqual(records.map(c => ({ fact: c.fact, scope: c.scope })), [
      { fact: "worker_stopped", scope: { leaseId: "lease", sessionId } },
      { fact: "discard", scope: { leaseId: "lease" } },
      { fact: "lease_returned", scope: { leaseId: "lease", outputBranch: "output" } },
    ]);
  } finally { tasks.close(); }
});

test("a failed import leaves the original database and files untouched and a retry starts afresh", async () => {
  const f = await fixture();
  const ref = await f.legacy.create("settled", {}, 0);
  await f.legacy.append(ref, "task_recorded", { outcome: "hold", reason: "Unknown old reason" });
  await assert.rejects(importAttempts(f.config), /recognisable category/);
  let tasks = await SqliteTaskStore.open({ path: databasePath(f.config) });
  assert.deepEqual(new AttemptStore(tasks.database, "context").list(), []);
  tasks.close();
  const entryPath = join(f.config.runtimeRoot, "attempts", key("context"), key("settled"), "1", "0001.json");
  const entry = JSON.parse(await readFile(entryPath, "utf8"));
  entry.data.reason = "Switchboard attempt 1 failed";
  await writeFile(entryPath, JSON.stringify(entry));
  assert.equal((await importAttempts(f.config)).ok, true);
  assert.deepEqual((await readdir(f.config.runtimeRoot)).filter(name => name.includes(".attempt-import-")), []);
  tasks = await SqliteTaskStore.open({ path: databasePath(f.config) });
  assert.equal(new AttemptStore(tasks.database, "context").list().length, 1);
  tasks.close();
});

test("a staging failure does not migrate the original schema, and the next run builds a fresh copy", async () => {
  const f = await fixture();
  const path = databasePath(f.config);
  const database = await Database.open(path);
  await database.transaction(() => {
    for (const table of ["answer_deliveries", "question_answers", "question_files", "worker_usage", "review_tasks", "request_records", "attempt_specifications", "control_requests", "worker_activity", "worker_observations", "launches", "worker_claims", "attempt_entries", "confirmations", "pending_attempt_deletions", "archived_attempts", "attempts", "attempt_numbers"]) database.run(`DROP TABLE ${table}`);
    database.run("ALTER TABLE tasks ADD COLUMN started_body TEXT");
    database.run("DROP TRIGGER task_definition_changed");
    database.run("ALTER TABLE tasks DROP COLUMN acceptance_criteria");
    database.run("ALTER TABLE tasks DROP COLUMN definition_revision");
    database.run("DROP INDEX tasks_by_objective");
    database.run("ALTER TABLE tasks DROP COLUMN objective_id");
    database.run("DROP TABLE task_changes");
    database.run("DROP TABLE objective_changes");
    database.run("DROP TABLE objectives");
    database.run("PRAGMA user_version = 1");
  });
  database.close();
  const ref = await f.legacy.create("settled", {}, 0);
  await f.legacy.append(ref, "halted", { stage: "acquire", reason: "rejected" });
  await f.legacy.reserveRequest("bad-request", "absent-task");
  const before = await files(f.config.runtimeRoot);
  await assert.rejects(importAttempts(f.config), /FOREIGN KEY/);
  assert.deepEqual(await files(f.config.runtimeRoot), before);
  const original = await Database.open(path, 5000, { migrate: false });
  try {
    assert.equal(original.get("PRAGMA user_version")!.user_version, 1);
    assert.equal(original.get("SELECT 1 FROM sqlite_master WHERE name = 'attempts'"), undefined);
    assert.equal(Number(original.get("SELECT count(*) AS n FROM tasks")!.n), 3);
  } finally { original.close(); }
  await rm(join(f.config.runtimeRoot, "request-ids", key("context"), `${key("bad-request")}.json`));
  assert.equal((await importAttempts(f.config)).count, 1);
});

test("import refuses open attempts, possibly running workers and fresh dispatcher heartbeats", async () => {
  const f = await fixture();
  const ref = await f.legacy.create("settled", {}, 0);
  await assert.rejects(importAttempts(f.config), /every attempt to be settled/);
  await f.legacy.append(ref, "halted", { stage: "launch", reason: "stopped" });
  const runtime = new RuntimeRecords(f.config.runtimeRoot);
  await mkdir(join(f.directory, "workspace"));
  const reserved = await runtime.reserve({ identity: { contextId: "context", taskId: "settled", leaseId: "lease", sessionId: randomUUID() },
    workspace: join(f.directory, "workspace"), instructions: "Fixture", acceptanceCriteria: [], delivery: { baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40), kind: "code", acceptance: "review_or_integration", requiredEvidence: [], requiredDeliverables: [] } });
  await assert.rejects(importAttempts(f.config), /may still be running/);
  await writeFile(join(reserved.directory, "heartbeat.json"), JSON.stringify({ version: 1, pid: process.pid, at: new Date().toISOString() }));
  await assert.rejects(importAttempts(f.config), /heartbeat is fresh/);
  await runtime.recordChildExit(reserved, { started: true, code: 0, signal: null });
  await writeFile(join(reserved.directory, "heartbeat.json"), JSON.stringify({ version: 1, pid: process.pid, at: new Date().toISOString() }));
  await assert.rejects(importAttempts(f.config), /heartbeat is fresh/);
});
