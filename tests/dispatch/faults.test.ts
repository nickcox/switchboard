import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchOnce, type Dependencies } from "../../src/dispatch/dispatch.ts";
import type { Reason } from "../../src/dispatch/result.ts";
import { TaskStoreError, type TaskStore } from "../../src/tasks/store.ts";
import { WorkspaceError } from "../../src/workspaces/provider.ts";
import { attemptsWith, fixture, task } from "./fixture.ts";

// Each case injects one fault at one boundary of the Phase 1 PRD failure compensation table, using the real
// adapters. Every case is checked against the same invariants; each also states its expected category.

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Case = { name: string; scenario?: string; inject: (f: Fixture) => Dependencies; reason: Reason; launches: number };

const unknown = () => new TaskStoreError("outcome_unknown", "lost acknowledgement");
const tasksWith = (f: Fixture, overrides: Partial<TaskStore>): Dependencies => {
  const real = f.deps.tasks;
  return { ...f.deps, tasks: {
    ready: () => real.ready(), inFlight: () => real.inFlight(), read: id => real.read(id),
    start: id => real.start(id), recordDone: (id, note) => real.recordDone(id, note), recordHold: (id, hold) => real.recordHold(id, hold),
    ...overrides,
  } };
};
const acquireWith = (f: Fixture, acquire: Dependencies["workspaces"]["acquire"]): Dependencies =>
  ({ ...f.deps, workspaces: { recyclableRoots: () => f.deps.workspaces.recyclableRoots(), returnLease: (lease, options) => f.deps.workspaces.returnLease(lease, options), acquire, leases: () => f.deps.workspaces.leases(), pool: () => f.deps.workspaces.pool() } });

const cases: Case[] = [
  { name: "task store unreadable", reason: "refused", launches: 0,
    inject: f => tasksWith(f, { ready: () => Promise.reject(new TaskStoreError("unreadable", "store offline")) }) },
  { name: "runtime records unreadable", reason: "refused", launches: 0,
    inject: f => ({ ...f.deps, runtime: { discover: () => Promise.reject(new Error("unreadable")) } as unknown as Dependencies["runtime"] }) },
  { name: "lease refused", reason: "stopped", launches: 0,
    inject: f => acquireWith(f, () => Promise.reject(new WorkspaceError("rejected", "refused"))) },
  { name: "lease created but its acknowledgement lost", reason: "stopped", launches: 0,
    inject: f => acquireWith(f, async request => { await f.deps.workspaces.acquire(request); throw new WorkspaceError("outcome_unknown", "lost"); }) },
  { name: "task stops being ready after leasing", reason: "stopped", launches: 0,
    inject: f => acquireWith(f, async request => {
      const allocation = await f.deps.workspaces.acquire(request);
      f.tasksCli(["hold", request.holder, "--reason", "Held elsewhere"]);
      return allocation;
    }) },
  { name: "in-flight update refused", reason: "stopped", launches: 0,
    inject: f => ({ ...f.deps, attempts: attemptsWith(f, { startReservedTask: () => Promise.reject(new TaskStoreError("rejected", "refused")) }) }) },
  { name: "start transaction committed before the caller stopped", scenario: "commit-result", reason: "stopped", launches: 0,
    inject: f => ({ ...f.deps, attempts: attemptsWith(f, { startReservedTask: async ref => { await f.deps.attempts.startReservedTask(ref); throw unknown(); } }) }) },
  { name: "in-flight update unknown and not applied", reason: "stopped", launches: 0,
    inject: f => ({ ...f.deps, attempts: attemptsWith(f, { startReservedTask: () => Promise.reject(unknown()) }) }) },
  { name: "launch fails before a worker exists", reason: "held", launches: 1,
    inject: f => ({ ...f.deps, launch: () => Promise.reject(new Error("executable missing")) }) },
  { name: "worker exit never observed", reason: "stopped", launches: 1,
    inject: f => ({ ...f.deps, launch: async input => ({
      ...await f.runtime.reserve(input), status: "unresolved", childExit: undefined, workerTermination: "unverified",
      reason: "termination_unknown", detail: undefined, stderrTail: "", result: undefined,
    }) }) },
  { name: "outcome transaction committed before the caller stopped", scenario: "commit-result", reason: "stopped", launches: 1,
    inject: f => ({ ...f.deps, attempts: attemptsWith(f, { recordOutcome: async (...args) => { await f.deps.attempts.recordOutcome(...args); throw unknown(); } }) }) },
  { name: "final update not applied", scenario: "commit-result", reason: "stopped", launches: 1,
    inject: f => ({ ...f.deps, attempts: attemptsWith(f, { recordOutcome: () => Promise.reject(unknown()) }) }) },
];

for (const c of cases) {
  test(`failure boundary: ${c.name}`, async () => {
    const f = await fixture({ tasks: [task("fault-a1")], ...(c.scenario ? { scenario: c.scenario } : {}) });
    const injected = c.inject(f);
    let launches = 0;
    let acquisitions = 0;
    const deps: Dependencies = {
      ...injected,
      launch: (input, signal) => { launches += 1; return injected.launch(input, signal); },
      workspaces: { recyclableRoots: () => injected.workspaces.recyclableRoots(), returnLease: (lease, options) => injected.workspaces.returnLease(lease, options), leases: () => injected.workspaces.leases(), pool: () => injected.workspaces.pool(), acquire: request => { acquisitions += 1; return injected.workspaces.acquire(request); } },
    };
    const outcome = await dispatchOnce(deps);
    const detail = JSON.stringify(outcome, null, 2);

    assert.equal(outcome.reason, c.reason, detail);
    assert.equal(launches, c.launches, detail);
    // Invariants for every boundary.
    assert.ok(acquisitions <= 1, "never acquires twice");
    const leases = (await f.deps.workspaces.leases()).filter(l => l.holder === "fault-a1");
    assert.ok(leases.length <= 1, "never holds two leases for a task");
    assert.equal(outcome.lease, leases.length > 0 ? "preserved" : "none", "reports the lease accurately and never returns it");
    assert.notEqual((await f.tasks.read("fault-a1"))?.state, "done", "never records done without a confirmed completion");
    if (c.name === "lease refused" || c.name === "lease created but its acknowledgement lost") {
      assert.equal((await f.tasks.read("fault-a1"))!.state, "queued", "lease failure never starts the task");
      assert.equal((await f.tasks.read("fault-a1"))!.held, false);
    }
    assert.equal(outcome.ok, false);
    assert.ok(outcome.detail, "every stop or hold says why");
    const attempt = (await f.deps.attempts.forTask("fault-a1"))[0];
    if (attempt) assert.ok(["halted", "worker_finished", "task_recorded"].includes(attempt.entries.at(-1)!.kind), "every attempt records how it ended");
    if (c.reason === "refused") assert.equal(attempt, undefined, "a refusal changes nothing");
  });
}

test("an attempt whose worker exit was never observed blocks the next dispatch", async () => {
  const f = await fixture({ tasks: [task("block-a1"), task("block-b1")] });
  await dispatchOnce(cases.find(c => c.name === "worker exit never observed")!.inject(f));
  const next = await dispatchOnce(f.deps);
  assert.equal(next.reason, "refused");
  assert.equal(next.nextAction.code, "stop_worker");
});

test("an operator interruption stops the worker and holds the task once its exit is observed", async () => {
  const f = await fixture({ tasks: [task("int-a1")], scenario: "ignore-stop" });
  const controller = new AbortController();
  // Interrupt soon after launch; the synthetic worker ignores polite stops and must be killed.
  const deps: Dependencies = { ...f.deps, launch: (input, signal) => {
    setTimeout(() => controller.abort(), 300);
    return f.deps.launch(input, signal);
  } };
  const outcome = await dispatchOnce(deps, { signal: controller.signal });
  assert.equal(outcome.reason, "held");
  assert.equal(outcome.lease, "preserved");
  assert.equal((await f.tasks.read("int-a1"))?.holdReason, "Switchboard attempt 1 interrupted");
});

test("two dispatches started at once never dispatch the same task", async () => {
  const f = await fixture({ tasks: [task("race-a1")], scenario: "commit-result" });
  const outcomes = await Promise.all([dispatchOnce(f.deps), dispatchOnce(f.deps)]);
  assert.equal((await f.deps.attempts.forTask("race-a1")).length, 1, JSON.stringify(outcomes.map(o => o.reason)));
  assert.equal((await f.deps.workspaces.leases()).filter(l => l.holder === "race-a1").length, 1);
  assert.equal(outcomes.filter(o => o.reason === "held").length, 1);
});
