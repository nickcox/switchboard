import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { importAttempts } from "../../src/attempts/import.ts";
import { AttemptLog } from "../../src/attempts/log.ts";
import { AttemptPruner } from "../../src/attempts/prune.ts";
import { AttemptStore } from "../../src/attempts/store.ts";
import { configSchema, databasePath } from "../../src/config.ts";
import { key, RuntimeRecords } from "../../src/runtime/records.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";

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
  const legacy = new AttemptLog(config.runtimeRoot, config.contextId);
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
  const pruned = await f.legacy.create("pruned", { requestId: "pruned-request" }, 0);
  await f.legacy.reserveRequest("pruned-request", "pruned");
  await f.legacy.append(pruned, "halted", { stage: "acquire", reason: "rejected" });
  const pruner = new AttemptPruner(f.legacy);
  await pruner.remove(await pruner.archive(await f.legacy.read(pruned)));
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
    assert.equal((await attempts.reserveAttempt({ taskId: "pruned", requested: { requestId: "pruned-request" }, maximum: 1 })).ref.attempt, 2);
    await assert.rejects(attempts.reserveAttempt({ taskId: "orphan", requested: { requestId: "orphan-request" }, maximum: 2 }), { reason: "request_reserved" });
    assert.equal((await tasks.read("settled"))!.body, "Original instructions");
    assert.equal(Number(tasks.database.get("SELECT count(*) AS n FROM archived_attempts")!.n), 1);
  } finally { tasks.close(); }
  await assert.rejects(importAttempts(f.config), /already has attempts/);
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
  await runtime.recordChildExit(reserved, { started: true, code: 0, signal: null });
  await writeFile(join(reserved.directory, "heartbeat.json"), JSON.stringify({ version: 1, pid: process.pid, at: new Date().toISOString() }));
  await assert.rejects(importAttempts(f.config), /heartbeat is fresh/);
});
