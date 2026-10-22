import assert from "node:assert/strict";
import { test } from "node:test";
import { assessAttempt, assessAttempts } from "../../src/dispatch/assess.ts";
import { observeAttempt, observeAttempts } from "../../src/dispatch/observe.ts";
import { checkCanDiscard } from "../../src/dispatch/safety.ts";
import { dispatchOnce, type Dependencies } from "../../src/dispatch/dispatch.ts";
import { discard, finish } from "../../src/dispatch/finish.ts";
import { prune } from "../../src/dispatch/prune.ts";
import { status } from "../../src/dispatch/status.ts";
import { attemptsWith, fixture, task } from "./fixture.ts";

async function recorded() {
  const f = await fixture({ tasks: [task("observe-a1"), task("observe-b1")] });
  for (const taskId of ["observe-a1", "observe-b1"]) {
    const ref = await f.deps.attempts.create(taskId, {}, 0);
    await f.deps.attempts.append(ref, "leased", { leaseId: `lease-${taskId}`, workspace: f.dir, baseRef: "main", outputBranch: `output-${taskId}`, startingCommit: "a".repeat(40) });
    await f.deps.attempts.append(ref, "halted", { stage: "start", reason: "stopped" });
  }
  return f;
}

test("one-attempt reads do not load other attempts, readiness or reporting additions", async () => {
  const f = await recorded();
  const read = f.deps.attempts.read.bind(f.deps.attempts);
  const attempts = attemptsWith(f, {
    list: () => { throw new Error("must not list attempts"); },
    read: ref => { assert.equal(ref.taskId, "observe-a1"); return read(ref); },
  });
  let runtimeReads = 0, taskReads = 0;
  const discover = f.runtime.discover.bind(f.runtime);
  f.runtime.discover = async (context, selector) => { runtimeReads += 1; assert.deepEqual(selector, { leaseId: "lease-observe-a1" }); return discover(context, selector); };
  const deps: Dependencies = { ...f.deps, attempts, tasks: {
    ready: async () => { throw new Error("must not read ready"); }, inFlight: async () => { throw new Error("must not read in-flight"); },
    read: async id => { taskReads += 1; assert.equal(id, "observe-a1"); return f.tasks.read(id); },
  } };
  const observation = await observeAttempt(deps, { leaseId: "lease-observe-a1" });
  assert.ok(observation);
  assert.equal(assessAttempt(observation).state, "finished");
  assert.equal(runtimeReads, 1);
  assert.equal(taskReads, 1);
});

test("one attempt and context-wide assessment agree, and assessing does no reading or mutation", async () => {
  const f = await recorded();
  let pools = 0, leases = 0, runtimes = 0, tasks = 0;
  const discover = f.runtime.discover.bind(f.runtime);
  f.runtime.discover = async (...args) => { runtimes += 1; return discover(...args); };
  const deps: Dependencies = { ...f.deps, workspaces: {
    acquire: request => f.deps.workspaces.acquire(request), returnLease: (lease, options) => f.deps.workspaces.returnLease(lease, options), recyclableRoots: () => f.deps.workspaces.recyclableRoots(),
    pool: async () => { pools += 1; return f.deps.workspaces.pool(); }, leases: async () => { leases += 1; return []; },
  }, tasks: { ready: () => f.tasks.ready(), inFlight: () => f.tasks.inFlight(), read: async id => { tasks += 1; return f.tasks.read(id); } } };
  const observations = await observeAttempts(deps);
  assert.deepEqual([pools, leases, runtimes, tasks], [1, 1, 1, 2]);
  const before = structuredClone(observations);
  const assessed = assessAttempts(observations);
  assert.deepEqual(observations, before);
  assert.deepEqual([pools, leases, runtimes, tasks], [1, 1, 1, 2]);
  const one = await observeAttempt(deps, { taskId: "observe-a1", attempt: 1 });
  assert.ok(one);
  assert.deepEqual(assessAttempt(one), assessed.find(a => a.attempt.taskId === "observe-a1"));
});

for (const owner of ["attempt", "runtime", "leases", "pool", "task"] as const) test(`an unreadable ${owner} owner remains unknown with its reason`, async () => {
  const f = await recorded();
  const unavailable = async (): Promise<never> => { throw new Error(`${owner} offline`); };
  if (owner === "runtime") f.runtime.discover = unavailable;
  const deps: Dependencies = { ...f.deps,
    ...(owner === "attempt" ? { attempts: attemptsWith(f, { findByLease: unavailable }) } : {}),
    tasks: { ready: () => f.tasks.ready(), inFlight: () => f.tasks.inFlight(), read: owner === "task" ? unavailable : id => f.tasks.read(id) },
    workspaces: {
      acquire: request => f.deps.workspaces.acquire(request), returnLease: (lease, options) => f.deps.workspaces.returnLease(lease, options), recyclableRoots: () => f.deps.workspaces.recyclableRoots(),
      pool: owner === "pool" ? unavailable : () => f.deps.workspaces.pool(), leases: owner === "leases" ? unavailable : async () => [],
    },
  };
  const observation = await observeAttempt(deps, { leaseId: "lease-observe-a1" });
  assert.ok(observation);
  const assessment = assessAttempt(observation);
  assert.equal(assessment.state, "unknown");
  assert.ok(assessment.facts.unknown.some(reason => reason.includes(`${owner} offline`)));
  const permission = checkCanDiscard(assessment.facts, true);
  assert.equal(permission.allowed, false);
  if (!permission.allowed) assert.match(permission.detail, /offline/);
});

test("a missing attempt is absence, not an unreadable owner", async () => {
  const f = await recorded();
  assert.equal(await observeAttempt(f.deps, { leaseId: "no-such-lease" }), undefined);
  assert.equal(await observeAttempt(f.deps, { taskId: "no-such-task" }), undefined);
  assert.equal(await observeAttempt(f.deps, { taskId: "observe-a1", attempt: 99 }), undefined);
});

test("historical open attempts are not mistaken for their task's latest unfinished attempt", async () => {
  const f = await recorded();
  const ref = await f.deps.attempts.create("observe-a1", {}, 1);
  const current = await observeAttempt(f.deps, { taskId: "observe-a1" });
  assert.equal(current?.attempt.attempt, ref.attempt);
  assert.equal(current && assessAttempt(current).facts.unfinished, true);
  const previous = await observeAttempt(f.deps, { taskId: "observe-a1", attempt: 1 });
  assert.equal(previous?.latest, false);
});

test("heartbeat read failures are unknown, not stale or missing heartbeats", async () => {
  const f = await fixture({ tasks: [task("observe-a1")], scenario: "commit-result" });
  const leaseId = (await dispatchOnce(f.deps)).attempt!.leaseId!;
  f.runtime.storage.heartbeat = async () => { throw new Error("claim offline"); };
  const observation = await observeAttempt(f.deps, { leaseId });
  assert.ok(observation);
  assert.deepEqual(observation.heartbeat, { known: false, reason: "The dispatcher heartbeat could not be read: claim offline" });
  assert.equal(assessAttempt(observation).state, "unknown");
});

test("finish, discard and prune do not depend on status-only reads or diagnostics", async () => {
  for (const command of ["finish", "discard", "prune"] as const) {
    const f = await fixture({ tasks: [task("observe-a1")], scenario: "commit-result" });
    const leaseId = (await dispatchOnce(f.deps)).attempt!.leaseId!;
    f.runtime.storage.activity = async () => { throw new Error("reporting unavailable"); };
    const deps: Dependencies = { ...f.deps, tasks: {
      ready: async () => { throw new Error("reporting unavailable"); }, inFlight: async () => { throw new Error("reporting unavailable"); }, read: id => f.tasks.read(id),
    } };
    if (command === "prune") {
      assert.equal((await finish(deps, { leaseId, noProcesses: true })).reason, "finished");
      assert.equal((await prune(deps, { olderThan: 0.000000001 })).reason, "pruned");
      assert.deepEqual(f.deps.attempts.list(), []);
    } else {
      const outcome = command === "finish" ? await finish(deps, { leaseId, noProcesses: true }) : await discard(deps, { leaseId, noProcesses: true, confirm: true });
      assert.equal(outcome.reason, command === "finish" ? "finished" : "discarded", outcome.detail ?? "");
    }
  }
});

test("status can omit activity summaries and transcript lookup", async () => {
  const f = await fixture({ tasks: [task("observe-a1")], scenario: "commit-result" });
  await dispatchOnce(f.deps);
  f.runtime.storage.activity = async () => { throw new Error("activity must not be read"); };
  const view = await status(f.deps, { activity: false, transcript: false });
  assert.equal(view.attempts[0]?.state, "awaiting_review");
  assert.ok(view.attempts[0]?.worker);
  assert.equal(view.attempts[0]?.activity, undefined);
  assert.equal(view.attempts[0]?.transcript, undefined);
});
