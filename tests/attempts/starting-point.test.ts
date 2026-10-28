import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { AttemptStore } from "../../src/attempts/store.ts";
import { requestFingerprint } from "../../src/attempts/requests.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";
import { specificationFor } from "../helpers.ts";
import { RuntimeStore } from "../../src/runtime/store.ts";
import { workerInput } from "../../src/attempts/specification.ts";

const root = resolve(import.meta.dirname, "../../.investigation/starting-point-unit");
mkdirSync(root, { recursive: true });
const output = "b".repeat(40);
const point = { taskId: "task", attempt: 1 };
const childScript = resolve(import.meta.dirname, "../fixtures/reserve-from-attempt.ts");
const run = promisify(execFile);

async function fixture(stopped = true, accepted = true) {
  const path = join(mkdtempSync(join(root, "case-")), "switchboard.db");
  const tasks = await SqliteTaskStore.open({ path });
  await tasks.add({ id: "task", title: "Task" });
  const attempts = new AttemptStore(tasks.database, "context");
  const { ref } = await attempts.reserveAttempt({ taskId: "task", requested: { requestId: "original" }, maximum: 2, specification: specificationFor });
  await attempts.append(ref, "leased", { leaseId: "old-lease", workspace: "/fixture", backingRepository: "/fixture", baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40) });
  await attempts.append(ref, "launched", { sessionId: "00000000-0000-4000-8000-000000000001" });
  await attempts.append(ref, "halted", { stage: "launch", reason: "interrupted" });
  if (stopped) await attempts.recordConfirmation(ref, { fact: "worker_stopped", scope: { leaseId: "old-lease", sessionId: "00000000-0000-4000-8000-000000000001" } }, "operator");
  if (accepted) await attempts.appendConfirmed(ref, "output_accepted", { commit: output }, { fact: "output_accepted", scope: { commit: output } }, "operator");
  const options = () => ({
    taskId: "task", requested: { requestId: "continue" }, maximum: 2, startingPoint: point,
    startingPointEvidence: { records: attempts.list(), unknown: [] as string[], retainedCommit: output },
    specification: (task: Parameters<typeof specificationFor>[0], ref: Parameters<typeof specificationFor>[1]) => specificationFor(task, ref, { outputBranch: `output-${ref.attempt}` }),
  });
  return { path, tasks, attempts, options, ref };
}

function snapshot(attempts: AttemptStore) {
  return ["attempt_numbers", "attempts", "attempt_entries", "request_records", "attempt_specifications", "confirmations"].map(table => attempts.database.all(`SELECT * FROM ${table}`));
}

test("starting-point fingerprints include task and attempt, without changing ordinary request fingerprints", () => {
  assert.equal(requestFingerprint({ taskId: "task" }), createHash("sha256").update('{"taskId":"task"}').digest("hex"));
  assert.notEqual(requestFingerprint({ taskId: "task" }), requestFingerprint({ taskId: "task", startingPoint: point }));
  assert.notEqual(requestFingerprint({ startingPoint: point }), requestFingerprint({ startingPoint: { ...point, attempt: 2 } }));
  assert.notEqual(requestFingerprint({ startingPoint: point }), requestFingerprint({ startingPoint: { ...point, taskId: "other" } }));
  assert.equal(requestFingerprint({ startingPoint: point }), requestFingerprint({ startingPoint: { attempt: 1, taskId: "task" } }));
});

test("the shared reservation stores the exact accepted commit and fresh identities, and replays only the same inputs", async () => {
  const f = await fixture();
  try {
    const before = f.attempts.read(f.ref);
    const reservation = await f.attempts.reserveAttempt(f.options());
    assert.equal(reservation.ref.attempt, 2);
    const record = f.attempts.read(reservation.ref);
    assert.deepEqual(record.specification?.startingPoint, { ...point, commit: output });
    assert.equal(record.specification?.outputBranch, "output-2");
    assert.deepEqual(record.entries.map(e => e.kind), ["requested"]);
    assert.equal(record.entries[0]!.data.requestId, "continue");
    assert.equal(record.allocation, undefined);
    assert.deepEqual(f.attempts.read(f.ref), before);
    assert.deepEqual(await f.attempts.reserveAttempt(f.options()), { ...reservation, created: false });
    await assert.rejects(f.attempts.reserveAttempt({ ...f.options(), startingPoint: { ...point, attempt: 2 } }), { reason: "request_input_mismatch" });
    const { startingPoint: _, ...ordinary } = f.options();
    await assert.rejects(f.attempts.reserveAttempt(ordinary), { reason: "request_input_mismatch" });
  } finally { f.tasks.close(); }
});

for (const kind of ["not stopped", "no commit", "not retained", "unknown", "other task", "missing attempt", "stale evidence", "same branch", "no evidence"] as const) {
  test(`shared reservation refuses ${kind} without any effect`, async () => {
    const f = await fixture(kind !== "not stopped", kind !== "no commit");
    try {
      const options = f.options();
      let reason: string | undefined;
      if (kind === "not stopped") reason = "possibly_running";
      if (kind === "no commit") reason = "output_not_recorded";
      if (kind === "not retained") { options.startingPointEvidence.retainedCommit = "c".repeat(40); reason = "not_retained"; }
      if (kind === "unknown") { options.startingPointEvidence.unknown = ["Git unavailable"]; reason = "starting_point_unknown"; }
      if (kind === "other task") { options.startingPoint = { taskId: "other", attempt: 1 }; reason = "starting_point_wrong_task"; }
      if (kind === "missing attempt") { options.startingPoint = { ...point, attempt: 99 }; reason = "starting_point_unknown"; }
      if (kind === "stale evidence") {
        await f.attempts.append(f.ref, "retention_checked", { retained: true, findings: [], notes: [] });
        reason = "attempt_changed";
      }
      if (kind === "same branch") options.specification = (task, ref) => specificationFor(task, ref);
      const before = snapshot(f.attempts);
      const { startingPointEvidence: _, ...withoutEvidence } = options;
      const request = kind === "no evidence" ? withoutEvidence : options;
      await assert.rejects(f.attempts.reserveAttempt(request), reason ? { reason } : kind === "no evidence" ? { reason: "starting_point_unknown" } : /own output branch/);
      assert.deepEqual(snapshot(f.attempts), before);
      assert.equal(await f.attempts.findByRequest("continue"), undefined);
    } finally { f.tasks.close(); }
  });
}

for (const context of ["context", "other-context"]) test(`a worker in ${context} blocks continuation even if it recorded a finish entry`, async () => {
  const f = await fixture();
  try {
    const store = new AttemptStore(f.tasks.database, context);
    const second = await store.reserveAttempt({ taskId: "task", requested: {}, maximum: 2, specification: specificationFor });
    await store.append(second.ref, "leased", { leaseId: "other-lease", workspace: "/fixture-2", baseRef: "main", outputBranch: "other", startingCommit: output });
    await store.append(second.ref, "launched", { sessionId: "00000000-0000-4000-8000-000000000002" });
    await store.append(second.ref, "worker_finished", { status: "failed", runtimeDirectory: "/runtime" });
    await store.append(second.ref, "halted", { stage: "launch", reason: "failed" });
    const before = snapshot(f.attempts);
    await assert.rejects(f.attempts.reserveAttempt(f.options()), { reason: "possibly_running", nextAction: "stop_worker" });
    assert.deepEqual(snapshot(f.attempts), before);
  } finally { f.tasks.close(); }
});

test("the per-task limit is serialised across concurrent reservation processes", async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(["one", "two", "three", "four"].map(id => run(process.execPath, [childScript, f.path, "reserve", id])));
    const records = results.map(r => JSON.parse(r.stdout));
    assert.equal(records.filter(r => r.created).length, 1);
    assert.equal(records.filter(r => r.reason === "attempt_limit").length, 3);
    assert.equal(f.attempts.taskAttemptCount("task"), 2);
    const replay = await run(process.execPath, [childScript, f.path, "reserve", records.find(r => r.created).requestId]);
    assert.equal(JSON.parse(replay.stdout).created, false);
  } finally { f.tasks.close(); }
});

test("concurrent replays of a starting-point request create one reservation", async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, [childScript, f.path, "reserve", "same"])));
    const reservations = results.map(r => JSON.parse(r.stdout));
    assert.equal(reservations.filter(r => r.created).length, 1);
    assert.ok(reservations.every(r => r.ref.attempt === 2));
    assert.equal(f.attempts.taskAttemptCount("task"), 2);
  } finally { f.tasks.close(); }
});

test("a reserved continuation closes fresh source launch permission, including after archiving", async () => {
  const f = await fixture();
  try {
    const source = f.attempts.read(f.ref);
    const input = workerInput(source.specification as ReturnType<typeof specificationFor>, source.allocation!, "00000000-0000-4000-8000-000000000001");
    const storage = new RuntimeStore(f.tasks.database);
    const launch = { context: "context", task: "task", attempt: 1, leaseId: "old-lease", directory: "/runtime/source", createdAt: new Date().toISOString() };
    const binding = { version: 1 as const, createdAt: launch.createdAt, input, sessionDirectory: "/runtime/source/sessions", artefactDirectory: "/runtime/source/artefacts", resultPath: "/runtime/source/result.json" };
    const reservation = await f.attempts.reserveAttempt(f.options());
    await assert.rejects(storage.claimLaunch(launch, binding), /launch permission is closed/);
    await f.attempts.append(reservation.ref, "halted", { stage: "acquire", reason: "stopped" });
    await f.attempts.archiveAttempt(f.attempts.read(reservation.ref), {}, []);
    await assert.rejects(storage.claimLaunch(launch, binding), /launch permission is closed/);
    assert.equal(f.tasks.database.all("SELECT * FROM launches").length, 0);
  } finally { f.tasks.close(); }
});

test("the task limit counts archived attempts and reservations in other contexts", async () => {
  const f = await fixture();
  try {
    await f.attempts.archiveAttempt(f.attempts.read(f.ref), {}, []);
    const other = new AttemptStore(f.tasks.database, "other-context");
    const second = await other.reserveAttempt({ taskId: "task", requested: {}, maximum: 1, maximumPerTask: 2, specification: specificationFor });
    await other.append(second.ref, "halted", { stage: "acquire", reason: "stopped" });
    await other.archiveAttempt(other.read(second.ref), {}, []);
    const before = snapshot(f.attempts);
    await assert.rejects(f.attempts.reserveAttempt({ taskId: "task", requested: { requestId: "over-limit" }, maximum: 1, maximumPerTask: 2, specification: specificationFor }), { reason: "attempt_limit" });
    assert.deepEqual(snapshot(f.attempts), before);
    assert.equal(f.attempts.taskAttemptCount("task"), 2);
  } finally { f.tasks.close(); }
});

for (const boundary of ["before", "during", "after"] as const) test(`crash ${boundary} the reservation transaction leaves no partial reservation`, async () => {
  const f = await fixture();
  const child = spawn(process.execPath, [childScript, f.path, boundary, "crash-request"], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  try {
    await Promise.race([
      once(child.stdout, "data").then(([data]) => assert.match(String(data), /boundary/)),
      exited.then(() => { throw new Error(`Child exited before boundary: ${stderr}`); }),
      sleep(10_000, undefined, { ref: false }).then(() => { throw new Error("Child did not reach boundary"); }),
    ]);
  } finally { child.kill("SIGKILL"); await exited; }
  try {
    assert.equal(f.attempts.taskAttemptCount("task"), boundary === "after" ? 2 : 1);
    assert.equal(f.attempts.list().length, boundary === "after" ? 2 : 1);
    assert.equal(!!await f.attempts.findByRequest("crash-request"), boundary === "after");
    const retried = JSON.parse((await run(process.execPath, [childScript, f.path, "reserve", "crash-request"])).stdout);
    assert.equal(retried.created, boundary !== "after");
    assert.equal(retried.ref.attempt, 2);
    assert.equal(f.attempts.taskAttemptCount("task"), 2);
    assert.equal(f.attempts.list().length, 2);
  } finally { f.tasks.close(); }
});
