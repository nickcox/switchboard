import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { AttemptStore } from "../../src/attempts/store.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";
import { specificationFor } from "../helpers.ts";

const run = promisify(execFile);
const childScript = resolve(import.meta.dirname, "../fixtures/database-attempt.ts");
const root = resolve(import.meta.dirname, "../../.investigation/attempt-store-unit");
mkdirSync(root, { recursive: true });

async function fixture(retryMs?: number) {
  const directory = mkdtempSync(join(root, "case-"));
  const path = join(directory, "switchboard.db");
  const tasks = await SqliteTaskStore.open({ path, ...(retryMs === undefined ? {} : { retryMs }) });
  await tasks.add({ id: "task", title: "Task", body: "instructions" });
  const attempts = new AttemptStore(tasks.database, "context");
  return { directory, path, tasks, attempts };
}
const lease = { leaseId: "lease", workspace: "/fixture", baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40) };
const held = { outcome: "hold" as const, reason: "Switchboard attempt 1 review required", category: "review_required" as const };
const reserve = (attempts: AttemptStore, requestId = "request") => attempts.reserveAttempt({ taskId: "task", requested: { requestId }, maximum: 2, specification: specificationFor });

async function lockedChild(path: string, mode: "hold" | "crash") {
  const child = spawn(process.execPath, [childScript, path, mode], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    await Promise.race([
      once(child.stdout, "data").then(([chunk]) => assert.match(String(chunk), /locked/)),
      exited.then(() => { throw new Error(`Child exited before taking the lock: ${stderr}`); }),
      sleep(10_000, undefined, { ref: false }).then(() => { throw new Error("Child did not take the lock"); }),
    ]);
  } catch (error) { child.kill("SIGKILL"); await exited; throw error; }
  return async () => { child.kill("SIGKILL"); await exited; };
}

test("reservation leaves a task queued, deduplicates requests and rechecks readiness when starting", async () => {
  const { tasks, attempts } = await fixture();
  try {
    const { ref } = await reserve(attempts);
    assert.equal((await tasks.read("task"))!.state, "queued");
    assert.deepEqual(attempts.read(ref).entries.map(e => e.kind), ["requested"]);
    assert.deepEqual(await reserve(attempts), { created: false, ref });
    await attempts.append(ref, "leased", lease);
    await tasks.hold("task", "operator decision");
    await assert.rejects(attempts.startReservedTask(ref), { reason: "not_ready" });
    assert.equal(attempts.read(ref).entries.length, 2);
    assert.equal((await tasks.read("task"))!.state, "queued");
    await tasks.release("task");
    assert.equal((await attempts.startReservedTask(ref)).state, "in_flight");
    assert.deepEqual(attempts.read(ref).entries.map(e => e.kind), ["requested", "leased", "task_started"]);
  } finally { tasks.close(); }
});

test("capacity and task exclusion are checked inside the reservation transaction", async () => {
  const { tasks, attempts } = await fixture();
  try {
    await tasks.add({ id: "second", title: "Second" });
    await tasks.add({ id: "blocker", title: "Blocker" });
    await tasks.block("second", "blocker");
    await assert.rejects(attempts.reserveAttempt({ taskId: "second", requested: {}, maximum: 1, specification: specificationFor }), { reason: "not_ready" });
    await reserve(attempts);
    await assert.rejects(attempts.reserveAttempt({ taskId: "second", requested: {}, maximum: 1, specification: specificationFor }), { reason: "capacity" });
    const otherContext = new AttemptStore(tasks.database, "other");
    await assert.rejects(reserve(otherContext), { reason: "not_ready" });
    assert.equal(attempts.list().length, 1);
    assert.equal(otherContext.list().length, 0);
  } finally { tasks.close(); }
});

test("the same request ID can be reserved independently in two contexts", async () => {
  const { tasks, attempts } = await fixture();
  try {
    await tasks.add({ id: "second", title: "Second" });
    await reserve(attempts);
    const other = new AttemptStore(tasks.database, "other");
    const reservation = await other.reserveAttempt({ taskId: "second", requested: { requestId: "request" }, maximum: 1, specification: specificationFor });
    assert.equal(reservation.created, true);
    assert.equal(reservation.ref.contextId, "other");
  } finally { tasks.close(); }
});

test("a version 1 database gains the attempt tables without changing its tasks", async () => {
  const { path, tasks } = await fixture();
  await tasks.add({ id: "blocker", title: "Blocker" });
  await tasks.block("task", "blocker");
  await tasks.hold("task", "operator decision");
  const before = await tasks.list();
  try {
    await tasks.database.transaction(() => {
      for (const table of ["attempt_specifications", "control_requests", "worker_activity", "worker_observations", "launches", "worker_claims", "attempt_entries", "confirmations", "pending_attempt_deletions", "archived_attempts", "attempts", "attempt_numbers"]) {
        tasks.database.run(`DROP TABLE ${table}`);
      }
      tasks.database.run("DROP TRIGGER task_definition_changed");
      tasks.database.run("ALTER TABLE tasks DROP COLUMN definition_revision");
      tasks.database.run("ALTER TABLE tasks ADD COLUMN started_body TEXT");
      tasks.database.run("PRAGMA user_version = 1");
    });
  } finally { tasks.close(); }
  const reopened = await SqliteTaskStore.open({ path });
  try {
    assert.deepEqual(await reopened.list(), before);
    assert.equal(reopened.database.get("PRAGMA user_version")!.user_version, 5);
    assert.deepEqual(new AttemptStore(reopened.database, "context").list(), []);
  } finally { reopened.close(); }
});

test("invalid first entry rolls back the number, attempt and reservation", async () => {
  const { tasks, attempts } = await fixture();
  try {
    await assert.rejects(attempts.reserveAttempt({ taskId: "task", requested: { requestId: "request", pool: "" }, maximum: 2, specification: specificationFor }));
    assert.equal(attempts.list().length, 0);
    assert.equal(Number(tasks.database.get("SELECT count(*) AS n FROM attempt_numbers")!.n), 0);
    assert.equal((await reserve(attempts)).ref.attempt, 1);
  } finally { tasks.close(); }
});

test("recording an outcome changes the task and closes the attempt together without changing its body", async () => {
  const { tasks, attempts } = await fixture();
  try {
    const { ref } = await reserve(attempts);
    await attempts.append(ref, "leased", lease);
    await attempts.startReservedTask(ref);
    await tasks.update("task", { body: "operator's newer instructions" });
    const outcome = await attempts.recordOutcome(ref, held);
    assert.equal(outcome.applied, true);
    assert.equal(outcome.task.state, "queued");
    assert.equal(outcome.task.holdReason, held.reason);
    assert.equal(outcome.task.body, "operator's newer instructions");
    assert.equal(attempts.read(ref).entries.at(-1)!.kind, "task_recorded");
    await assert.rejects(attempts.recordOutcome(ref, held), { reason: "attempt_closed" });
    assert.equal(Number(tasks.database.get("SELECT closed FROM attempts")!.closed), 1);
  } finally { tasks.close(); }
});

for (const operatorChange of ["hold", "released hold", "done", "reopen"] as const) test(`outcome preserves the operator's ${operatorChange} decision`, async () => {
  const { tasks, attempts } = await fixture();
  try {
    const { ref } = await reserve(attempts);
    await attempts.append(ref, "leased", lease);
    await attempts.startReservedTask(ref);
    if (operatorChange === "hold" || operatorChange === "released hold") {
      await tasks.hold("task", "operator decision");
      if (operatorChange === "released hold") await tasks.release("task");
    } else if (operatorChange === "done") await tasks.done("task");
    else await tasks.reopen("task");
    const before = await tasks.read("task");
    const outcome = await attempts.recordOutcome(ref, held);
    assert.equal(outcome.applied, false);
    assert.deepEqual(await tasks.read("task"), before);
    assert.equal(attempts.read(ref).entries.at(-1)!.data.applied, false);
  } finally { tasks.close(); }
});

test("a failing outcome entry rolls back the task update and attempt closure", async () => {
  const { tasks, attempts } = await fixture();
  try {
    const { ref } = await reserve(attempts);
    await attempts.append(ref, "leased", lease);
    await attempts.startReservedTask(ref);
    const before = attempts.read(ref);
    await assert.rejects(attempts.recordOutcome(ref, { ...held, category: undefined! }));
    assert.deepEqual(attempts.read(ref), before);
    assert.equal((await tasks.read("task"))!.state, "in_flight");
    assert.equal(Number(tasks.database.get("SELECT closed FROM attempts")!.closed), 0);
  } finally { tasks.close(); }
});

test("finish and discard refuse a changed task without inserting their entries or confirmations", async () => {
  const { tasks, attempts } = await fixture();
  try {
    const { ref } = await reserve(attempts);
    const expected = (await tasks.read("task"))!;
    await tasks.hold("task", "new decision");
    await assert.rejects(attempts.finishAttempt(ref, expected), { reason: "task_changed" });
    await assert.rejects(attempts.discardAttempt(ref, expected, "operator", "lease"), { reason: "task_changed" });
    assert.deepEqual(attempts.read(ref).entries.map(e => e.kind), ["requested"]);
    assert.deepEqual(attempts.confirmations(ref), []);
    const now = (await tasks.read("task"))!;
    await attempts.discardAttempt(ref, now, "operator", "lease", "discarded work");
    assert.equal((await tasks.read("task"))!.holdReason, "Switchboard attempt 1 discarded");
    assert.equal(attempts.confirmations(ref)[0]!.fact, "discard");
    await attempts.finishAttempt(ref, (await tasks.read("task"))!);
    assert.equal((await tasks.read("task"))!.state, "done");
    assert.equal((await tasks.read("task"))!.body, "instructions");
  } finally { tasks.close(); }
});

test("confirmation records name their attempt, person, time and exact scope", async () => {
  const { tasks, attempts } = await fixture();
  try {
    const { ref } = await reserve(attempts);
    const confirmation = { fact: "no_processes" as const, scope: { leaseId: "lease", returnId: "3c33c74e-3214-440e-af1a-d2ab26d336f7" } };
    await attempts.recordConfirmation(ref, confirmation, "operator:nick");
    const [record] = attempts.confirmations(ref);
    assert.deepEqual(record, { ...ref, ...confirmation, confirmedBy: "operator:nick", confirmedAt: record!.confirmedAt });
    assert.ok(Number.isFinite(Date.parse(record!.confirmedAt)));
    await assert.rejects(attempts.recordConfirmation(ref, { fact: "output_accepted", scope: { commit: "bad" } }, "operator"));
    assert.equal(attempts.confirmations(ref).length, 1);
  } finally { tasks.close(); }
});

test("confirmations authorise only the exact operation and lease return they name", async () => {
  const { tasks, attempts } = await fixture();
  try {
    const { ref } = await reserve(attempts);
    const returnId = "3c33c74e-3214-440e-af1a-d2ab26d336f7";
    const otherReturn = "b861179a-8303-47af-adb8-d3cac4e08b10";
    await assert.rejects(attempts.appendConfirmed(ref, "output_accepted", { commit: "a".repeat(40) },
      { fact: "output_accepted", scope: { commit: "b".repeat(40) } }, "operator"));
    assert.deepEqual(attempts.confirmations(ref), []);
    await attempts.appendConfirmed(ref, "lease_return_started", { leaseId: "lease", by: "finish", returnId },
      { fact: "no_processes", scope: { leaseId: "lease", returnId } }, "operator");
    await assert.rejects(attempts.append(ref, "lease_returned", { leaseId: "lease", by: "finish", returnId: otherReturn }));
    await assert.rejects(attempts.append(ref, "lease_returned", { leaseId: "another-lease", by: "finish", returnId }));
    await assert.rejects(attempts.appendConfirmed(ref, "lease_return_started", { leaseId: "lease", by: "finish", returnId },
      { fact: "no_processes", scope: { leaseId: "lease", returnId } }, "operator"));
    assert.equal(attempts.confirmations(ref).length, 1);
    await attempts.append(ref, "lease_returned", { leaseId: "lease", by: "finish", returnId });
  } finally { tasks.close(); }
});

test("database constraints enforce request, attempt and entry uniqueness and entries cannot be changed", async () => {
  const { tasks, attempts } = await fixture();
  const db = tasks.database;
  try {
    await reserve(attempts);
    for (const statement of [
      "INSERT INTO attempt_numbers VALUES('context','task',1)",
      "INSERT INTO attempts(context,task,number,request_id,reserved_at) VALUES('context','task',NULL,'request','now')",
      "INSERT INTO attempt_entries SELECT * FROM attempt_entries",
      "UPDATE attempt_entries SET entry = '{}'",
      "INSERT INTO attempt_entries VALUES('context','task',99,0,'{}')",
    ]) await assert.rejects(db.transaction(() => db.run(statement)));
    // A reservation without an attempt is representable, and has the same request-ID uniqueness constraint.
    await db.transaction(() => db.run("INSERT INTO attempts(context,task,request_id,reserved_at) VALUES('context','task','orphan','now')"));
    await assert.rejects(reserve(attempts, "orphan"), { reason: "request_reserved" });
    assert.equal(attempts.list().length, 1);
  } finally { tasks.close(); }
});

test("archive removes the attempt and reservation atomically, retains its number and resumes pending deletion", async () => {
  const { directory, path, tasks, attempts } = await fixture();
  try {
    const { ref } = await reserve(attempts);
    await attempts.append(ref, "halted", { stage: "acquire", reason: "rejected" });
    const before = attempts.read(ref);
    await attempts.append(ref, "retention_checked", { retained: true, findings: [], notes: [] });
    await assert.rejects(attempts.archiveAttempt(before, {}, [directory]), { reason: "attempt_changed" });
    await attempts.archiveAttempt(attempts.read(ref), { outcome: "halted" }, [join(directory, "runtime")]);
    assert.deepEqual(attempts.list(), []);
    assert.equal(Number(tasks.database.get("SELECT count(*) AS n FROM attempt_entries")!.n), 0);
    assert.equal(Number(tasks.database.get("SELECT count(*) AS n FROM attempts")!.n), 0);
    assert.equal(Number(tasks.database.get("SELECT count(*) AS n FROM archived_attempts")!.n), 1);
    const reopened = await SqliteTaskStore.open({ path });
    try {
      const store = new AttemptStore(reopened.database, "context");
      assert.deepEqual(store.pendingDeletions(), [{ ...ref, directory: join(directory, "runtime") }]);
      await store.completeDeletion(store.pendingDeletions()[0]!);
      assert.deepEqual(store.pendingDeletions(), []);
      assert.equal((await reserve(store)).ref.attempt, 2);
    } finally { reopened.close(); }
  } finally { tasks.close(); }
});

test("two processes reserving and starting the same request create and start just one attempt", { timeout: 30_000 }, async () => {
  const { path, tasks, attempts } = await fixture();
  try {
    const results = await Promise.all(Array.from({ length: 2 }, () => run(process.execPath, [childScript, path, "reserve"])));
    const reservations = results.map(r => JSON.parse(r.stdout));
    assert.equal(reservations.filter(r => r.created).length, 1);
    assert.deepEqual(reservations[0].ref, reservations[1].ref);
    const records = attempts.list();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.entries.filter(e => e.kind === "task_started").length, 1);
    assert.equal((await tasks.read("task"))!.state, "in_flight");
  } finally { tasks.close(); }
});

test("killing a process during a reservation transaction leaves no records and releases the write lock", { timeout: 30_000 }, async () => {
  const { path, tasks, attempts } = await fixture();
  try {
    const stop = await lockedChild(path, "crash");
    await stop();
    assert.deepEqual(attempts.list(), []);
    assert.equal(Number(tasks.database.get("SELECT count(*) AS n FROM attempt_numbers")!.n), 0);
    assert.equal(Number(tasks.database.get("SELECT count(*) AS n FROM attempt_entries")!.n), 0);
    assert.equal((await reserve(attempts)).ref.attempt, 1);
  } finally { tasks.close(); }
});

test("a busy database refuses while heartbeats and stop handling continue, without leaving a reservation", { timeout: 30_000 }, async () => {
  const { path, tasks, attempts } = await fixture(150);
  const stop = await lockedChild(path, "hold");
  let beats = 0;
  let waiting = true;
  let handledWhileWaiting = false;
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => { handledWhileWaiting = waiting; }, { once: true });
  const timer = setInterval(() => { beats++; }, 5);
  const stopTimer = setTimeout(() => controller.abort(), 30);
  try {
    await assert.rejects(reserve(attempts), { reason: "busy" });
    waiting = false;
    assert.ok(beats >= 5, `Only ${beats} heartbeats ran`);
    assert.equal(handledWhileWaiting, true, "Stop handling must run before the busy refusal");
    assert.deepEqual(attempts.list(), []);
    assert.equal((await tasks.read("task"))!.state, "queued");
    assert.equal(Number(tasks.database.get("SELECT count(*) AS n FROM attempt_numbers")!.n), 0);
  } finally { clearInterval(timer); clearTimeout(stopTimer); await stop(); tasks.close(); }
});
