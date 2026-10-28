import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { resolveStopped } from "../../src/dispatch/resolve.ts";
import { createReview } from "../../src/dispatch/review.ts";
import { describeStatus, status } from "../../src/dispatch/status.ts";
import { attemptsWith, fixture, task } from "./fixture.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const run = promisify(execFile);
const delivery = { baseRef: "main", startingCommit: "a".repeat(40), outputBranch: "o", kind: "code" as const, acceptance: "review_or_integration" as const, requiredEvidence: [], requiredDeliverables: [] };

/** Runs a CLI command in a separate process, including refusals which exit with code 1. */
async function commandProcess(f: Fixture, args: string[]) {
  try { return JSON.parse((await run(process.execPath, [resolve("src/cli.ts"), ...args, "--json", "--config", f.config])).stdout); }
  catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    assert.equal(result.code, 1, result.stderr);
    return JSON.parse(result.stdout);
  }
}
const dispatchProcess = (f: Fixture, args: string[] = []) => commandProcess(f, ["dispatch", "--once", ...args]);

/** Waits until this many synthetic workers have received their prompt. */
async function workersRunning(f: Fixture, count: number) {
  const log = join(f.dir, "requests.jsonl");
  for (let i = 0; i < 400; i += 1) {
    if (existsSync(log) && readFileSync(log, "utf8").split("\n").filter(line => line.includes('"type":"prompt"')).length >= count) return;
    await sleep(25);
  }
  throw new Error(`${count} workers never started`);
}

test("with a maximum of 2, two dispatch processes start different tasks and a third refuses at capacity", async () => {
  const f = await fixture({ tasks: [task("par-a1"), task("par-b1"), task("par-c1")], scenario: "await-release", maxAttempts: 2, runMs: 25_000 });
  const first = dispatchProcess(f);
  const second = dispatchProcess(f);
  try {
    await workersRunning(f, 2);
    const view = await commandProcess(f, ["status"]);
    assert.deepEqual(view.capacity, { maximum: 2, active: 2 });
    assert.deepEqual(view.blockingDispatch, []);
    const third = await dispatchProcess(f);
    assert.equal(third.reason, "refused", JSON.stringify(third));
    assert.equal(third.observed.reason, "capacity");
    assert.deepEqual(await f.deps.attempts.forTask("par-c1"), []);
  } finally {
    writeFileSync(join(f.dir, "release"), "");
    await Promise.all([first, second]);
  }
  const outcomes = await Promise.all([first, second]);
  assert.deepEqual(outcomes.map(o => o.reason), ["held", "held"], JSON.stringify(outcomes));
  assert.deepEqual(outcomes.map(o => o.attempt.taskId).sort(), ["par-a1", "par-b1"]);
  assert.equal(new Set(outcomes.map(o => o.attempt.leaseId)).size, 2);
  assert.equal(f.deps.attempts.activeCount(), 0, "attempts awaiting review no longer count");
  const next = await dispatchOnce(f.deps);
  assert.equal(next.attempt?.taskId, "par-c1", JSON.stringify(next));
  assert.equal(f.deps.attempts.list().length, 3);
});

test("the default maximum still allows only one active worker", async () => {
  const f = await fixture({ tasks: [task("first"), task("next")], scenario: "await-release", runMs: 25_000 });
  const first = dispatchProcess(f);
  try {
    await workersRunning(f, 1);
    assert.deepEqual((await status(f.deps)).capacity, { maximum: 1, active: 1 });
    const refused = await dispatchProcess(f);
    assert.equal(refused.observed.reason, "capacity", JSON.stringify(refused));
    assert.deepEqual(await f.deps.attempts.forTask("next"), []);
  } finally {
    writeFileSync(join(f.dir, "release"), "");
    await first;
  }
});

for (const named of [false, true]) {
  test(`two dispatch processes racing for one ${named ? "named" : "automatically selected"} task start exactly one attempt`, async () => {
    const f = await fixture({ tasks: [task("only-a1")], scenario: "commit-result", maxAttempts: 2 });
    const outcomes = await Promise.all([dispatchProcess(f, named ? ["--task", "only-a1"] : []), dispatchProcess(f, named ? ["--task", "only-a1"] : [])]);
    assert.deepEqual(outcomes.map(o => o.reason).sort(), ["held", named ? "refused" : "no_ready_work"], JSON.stringify(outcomes));
    const attempts = f.deps.attempts.list();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.entries.filter(e => e.kind === "launched").length, 1);
    assert.equal((await f.runtime.discover(f.deps.contextId)).length, 1);
    assert.equal((await f.deps.workspaces.leases()).length, 1);
  });
}

test("automatic selection skips a task reserved after inspection, while a named dispatch refuses", async () => {
  for (const named of [false, true]) {
    const f = await fixture({ tasks: [task("race-a1"), task("race-b1")], scenario: "commit-result", maxAttempts: 2 });
    let raced = false;
    const attempts = attemptsWith(f, {
      reserveAttempt: async options => {
        if (!raced) { raced = true; await f.deps.attempts.reserveAttempt({ ...options, requested: {} }); }
        return f.deps.attempts.reserveAttempt(options);
      },
    });
    const options = { requestId: "racing-request", ...(named ? { taskId: "race-a1" } : {}) };
    const outcome = await dispatchOnce({ ...f.deps, attempts }, options);
    assert.equal((await f.deps.attempts.forTask("race-a1")).length, 1);
    if (named) {
      assert.equal(outcome.reason, "refused");
      assert.equal(outcome.observed.reason, "not_ready");
      assert.deepEqual(await f.deps.attempts.forTask("race-b1"), []);
    } else {
      assert.equal(outcome.attempt?.taskId, "race-b1", JSON.stringify(outcome));
      const replay = await dispatchOnce(f.deps, options);
      assert.equal(replay.reason, "existing_request");
      assert.equal(replay.attempt?.taskId, "race-b1");
      assert.equal(f.deps.attempts.list().length, 2);
    }
  }
});

/** Records a possibly running worker, without starting any process. */
async function earlierWorker(f: Fixture, taskId: string, launchRow = true) {
  const workspace = join(f.dir, `${taskId}-workspace`);
  mkdirSync(workspace);
  const sessionId = randomUUID();
  const leaseId = `lease-${taskId}`;
  const ref = await f.deps.attempts.create(taskId, {}, 0);
  await f.deps.attempts.append(ref, "leased", { leaseId, workspace, baseRef: "main", outputBranch: "o", startingCommit: "a".repeat(40) });
  await f.deps.attempts.startReservedTask(ref);
  await f.deps.attempts.append(ref, "launched", { sessionId });
  if (!launchRow) return undefined;
  return f.runtime.reserve({ identity: { contextId: "fixture-context", taskId, leaseId, sessionId }, workspace, instructions: "Earlier", acceptanceCriteria: [], delivery });
}

const setHeartbeat = (f: Fixture, claimId: string, offsetMs: number) =>
  f.tasks.database.transaction(() => f.tasks.database.run("UPDATE worker_claims SET heartbeat_at = ? WHERE id = ?", new Date(Date.now() + offsetMs).toISOString(), claimId));

for (const launchRow of [false, true]) {
  test(`a ${launchRow ? "fresh dispatcher heartbeat" : "launch logged without a launch row"} blocks only its own task`, async () => {
    const f = await fixture({ tasks: [task("busy-a1"), task("next-b1")], scenario: "commit-result", maxAttempts: 2 });
    await earlierWorker(f, "busy-a1", launchRow);
    const view = await status(f.deps);
    assert.deepEqual(view.capacity, { maximum: 2, active: 1 });
    assert.deepEqual(view.blockingDispatch, []);
    assert.match(describeStatus(view), /Active attempts: 1 of at most 2/);
    const own = await dispatchOnce(f.deps, { taskId: "busy-a1" });
    assert.equal(own.reason, "refused");
    assert.equal(own.stage, "select");
    const next = await dispatchOnce(f.deps);
    assert.equal(next.attempt?.taskId, "next-b1", JSON.stringify(next));
    assert.equal(next.reason, "held");
  });
}

const blocking: { name: string; apply: (f: Fixture, reserved: NonNullable<Awaited<ReturnType<typeof earlierWorker>>>) => Promise<unknown> }[] = [
  { name: "missing", apply: async f => { f.runtime.storage.heartbeat = async () => undefined; } },
  { name: "released", apply: (_f, reserved) => reserved.storage.releaseClaim(reserved.claimId) },
  { name: "unreadable", apply: async f => { f.runtime.storage.heartbeat = async () => { throw new Error("database busy"); }; } },
  { name: "stale", apply: (f, reserved) => setHeartbeat(f, reserved.claimId, -60_000) },
  { name: "dated in the future", apply: (f, reserved) => setHeartbeat(f, reserved.claimId, 60_000) },
  { name: "invalid", apply: (f, reserved) => f.tasks.database.transaction(() => f.tasks.database.run("UPDATE worker_claims SET heartbeat_at = 'invalid' WHERE id = ?", reserved.claimId)) },
];

for (const c of blocking) {
  test(`a heartbeat that is ${c.name} blocks all dispatch and never permits a reservation`, async () => {
    const f = await fixture({ tasks: [task("orphan-a1"), task("next-b1")], scenario: "commit-result", maxAttempts: 2 });
    const reserved = (await earlierWorker(f, "orphan-a1"))!;
    const heartbeat = f.runtime.storage.heartbeat.bind(f.runtime.storage);
    await c.apply(f, reserved);
    const view = await status(f.deps);
    assert.deepEqual(view.blockingDispatch.map(a => a.taskId), ["orphan-a1"]);
    assert.match(describeStatus(view), /blocked for the whole context by: orphan-a1 attempt 1/);
    for (const dryRun of [false, true]) {
      const outcome = await dispatchOnce(f.deps, { dryRun });
      assert.equal(outcome.reason, c.name === "unreadable" ? "owner_read_retryable" : "refused", JSON.stringify(outcome));
      if (c.name !== "unreadable") {
        assert.equal(outcome.nextAction.code, "stop_worker");
        assert.deepEqual((outcome.observed.possiblyRunning as { taskId: string }[]).map(p => p.taskId), ["orphan-a1"]);
      }
      assert.deepEqual(await f.deps.attempts.forTask("next-b1"), []);
    }
    // Repair an unreadable observation before the operator confirms the worker stopped.
    f.runtime.storage.heartbeat = heartbeat;
    await setHeartbeat(f, reserved.claimId, -60_000);
    const resolved = await resolveStopped(f.deps, { leaseId: "lease-orphan-a1", confirmed: true });
    assert.equal(resolved.reason, "resolved", JSON.stringify(resolved));
    assert.equal((await dispatchOnce(f.deps)).attempt?.taskId, "next-b1");
  });
}

test("status reports an unreadable active count as unknown, never as spare capacity", async () => {
  const f = await fixture({ maxAttempts: 2 });
  const view = await status({ ...f.deps, attempts: attemptsWith(f, { activeCount: () => { throw new Error("count unavailable"); } }) });
  assert.equal(view.reason, "refused");
  assert.deepEqual(view.capacity, { maximum: 2, active: null });
  assert.match(describeStatus(view), /Active attempts: unknown of at most 2/);
  assert.match(view.detail!, /Active attempts could not be counted: count unavailable/);
});

test("one stale worker blocks the context even with another fresh dispatcher, in status text and JSON", async () => {
  const f = await fixture({ tasks: [task("fresh-a1"), task("stale-b1"), task("next-c1")], scenario: "commit-result", maxAttempts: 3 });
  await earlierWorker(f, "fresh-a1");
  const stale = (await earlierWorker(f, "stale-b1"))!;
  await setHeartbeat(f, stale.claimId, -60_000);
  const view = await commandProcess(f, ["status"]);
  assert.deepEqual(view.capacity, { maximum: 3, active: 2 });
  assert.deepEqual(view.blockingDispatch.map((a: { taskId: string }) => a.taskId), ["stale-b1"]);
  assert.match(describeStatus(view), /blocked for the whole context by: stale-b1 attempt 1/);
  const outcome = await dispatchOnce(f.deps);
  assert.equal(outcome.nextAction.code, "stop_worker");
  assert.deepEqual((outcome.observed.possiblyRunning as { taskId: string }[]).map(p => p.taskId), ["stale-b1"]);
  assert.deepEqual(await f.deps.attempts.forTask("next-c1"), []);
});

for (const relation of ["source", "same task", "unrelated task"] as const) {
  for (const fresh of [true, false]) {
    test(`continuation and review keep task-scoped stopped-worker checks for a ${fresh ? "fresh" : "stale"} worker on the ${relation}`, async () => {
      const review = { kind: "artefact" as const, acceptance: "independent_deliverable" as const, requiredEvidence: [], requiredDeliverables: ["report"] };
      const f = await fixture({ tasks: [task("source"), task("busy")], scenario: "commit-result", maxAttempts: 3, byTaskKind: { review } });
      try {
        const first = await dispatchOnce(f.deps, { taskId: "source" });
        assert.equal(first.reason, "held");
        await f.tasks.release("source");
        if (relation === "source") {
          const runtime = (await f.runtime.discover(f.deps.contextId))[0]!;
          await f.tasks.database.transaction(() => {
            f.tasks.database.run("DELETE FROM worker_observations WHERE directory = ? AND kind = 'exit'", runtime.directory);
            f.tasks.database.run("UPDATE worker_claims SET released_at = NULL WHERE id = ?", runtime.claimId);
          });
          await setHeartbeat(f, runtime.claimId, fresh ? 0 : -60_000);
        } else {
          const runtime = (await earlierWorker(f, relation === "same task" ? "source" : "busy"))!;
          await setHeartbeat(f, runtime.claimId, fresh ? 0 : -60_000);
        }
        const count = f.deps.attempts.list().length;
        const reviewed = await createReview(f.deps, { taskId: "source", attempt: 1 });
        assert.equal(reviewed.reason, relation === "unrelated task" ? "review_created" : "refused", JSON.stringify(reviewed));
        if (relation !== "unrelated task") assert.equal(reviewed.observed.reason, "possibly_running");
        const continued = await dispatchOnce(f.deps, { taskId: "source", startingPoint: { taskId: "source", attempt: 1 }, dryRun: true });
        assert.equal(continued.reason, relation === "unrelated task" && fresh ? "dry_run" : "refused", JSON.stringify(continued));
        if (continued.reason === "refused") assert.equal(continued.observed.reason, "possibly_running");
        assert.equal(f.deps.attempts.list().length, count, "neither operation reserves or launches a worker");
      } finally { f.tasks.close(); }
    });
  }
}

