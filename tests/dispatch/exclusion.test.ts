import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchOnce, type Dependencies } from "../../src/dispatch/dispatch.ts";
import { resolveLeaseReturned, resolveStopped } from "../../src/dispatch/resolve.ts";
import { status } from "../../src/dispatch/status.ts";
import { fixture, task } from "./fixture.ts";

// Phase 1 review findings 1–4 (docs/phases/01-basic-dispatch/review-2026-10-20.md). Each race is forced with a gate
// that holds one invocation at a chosen point, so the schedule does not depend on timing.

function gate() {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  const arrived = new Promise<void>(resolve => { reached = resolve; });
  return { open, arrived, wait: async () => { reached(); await opened; } };
}

test("finding 1: a dispatch started while another is acquiring a lease for the task does not dispatch it again", async () => {
  const f = await fixture({ tasks: [task("stagger-a1")], scenario: "commit-result" });
  const held = gate();
  let acquisitions = 0;
  let launches = 0;
  const counted = (pauseFirst: boolean): Dependencies => ({
    ...f.deps,
    workspaces: {
      leases: () => f.deps.workspaces.leases(), pool: () => f.deps.workspaces.pool(),
      recyclableRoots: () => f.deps.workspaces.recyclableRoots(),
      acquire: async request => {
        acquisitions += 1;
        if (pauseFirst && acquisitions === 1) await held.wait();
        return f.deps.workspaces.acquire(request);
      },
    },
    launch: (...args) => { launches += 1; return f.deps.launch(...args); },
  });
  // A has created attempt 1 and is paused before its lease exists; B inspects in that window.
  const first = dispatchOnce(counted(true));
  await held.arrived;
  const second = await dispatchOnce(counted(false));
  assert.notEqual(second.reason, "held");
  assert.equal(second.attempt, undefined);
  held.open();
  assert.equal((await first).reason, "held");
  assert.equal(acquisitions, 1);
  assert.equal(launches, 1);
  assert.deepEqual((await f.deps.attempts.forTask("stagger-a1")).map(a => a.attempt), [1]);
});

test("finding 2: one request ID starts at most one attempt, even when two calls look it up at the same time", async () => {
  const f = await fixture({ tasks: [task("req-a1"), task("req-b1")], scenario: "commit-result" });
  let lookups = 0;
  let bothLooked!: () => void;
  const together = new Promise<void>(resolve => { bothLooked = resolve; });
  const synchronised: Dependencies = {
    ...f.deps,
    attempts: Object.assign(Object.create(Object.getPrototypeOf(f.deps.attempts)), f.deps.attempts, {
      findByRequest: async (requestId: string) => {
        const found = await f.deps.attempts.findByRequest(requestId);
        lookups += 1;
        if (lookups === 2) bothLooked();
        await together;
        return found;
      },
    }),
  };
  const outcomes = await Promise.all([
    dispatchOnce(synchronised, { requestId: "same", taskId: "req-a1" }),
    dispatchOnce(synchronised, { requestId: "same", taskId: "req-b1" }),
  ]);
  const withRequest = (await f.deps.attempts.list()).filter(a => a.entries[0]?.data.requestId === "same");
  assert.equal(withRequest.length, 1);
  assert.equal(outcomes.filter(o => o.reason === "held").length, 1);
});

test("finding 3: an attempt logged only as requested is unknown after the pool changes, and is cleared by task", async () => {
  const f = await fixture({ tasks: [task("crashed-a1")], scenario: "commit-result" });
  // As left by a dispatcher killed after Treehouse created the lease but before it was logged.
  const pool = await f.deps.workspaces.pool();
  await f.deps.attempts.create("crashed-a1", { pool }, 0);
  await f.deps.workspaces.acquire({ holder: "crashed-a1", baseRef: "main", branch: "switchboard/crashed-a1/attempt-1" });
  f.run(["remote", "add", "origin", "https://example.invalid/fixture.git"]);

  const view = await status(f.deps);
  assert.equal(view.attempts[0]?.leaseInOtherPool, pool);
  assert.equal(view.attempts[0]?.nextAction.code, "confirm_lease_returned");
  assert.equal((await dispatchOnce(f.deps, { dryRun: true })).reason, "no_ready_work");
  assert.equal((await dispatchOnce(f.deps, { taskId: "crashed-a1", dryRun: true })).reason, "refused");

  assert.equal((await resolveLeaseReturned(f.deps, { taskId: "crashed-a1" })).reason, "resolved");
  assert.equal((await dispatchOnce(f.deps)).attempt?.attempt, 2);
});

test("finding 1 and 3: an unfinished attempt in the listed pool blocks its task until the operator confirms by task", async () => {
  const f = await fixture({ tasks: [task("open-a1")], scenario: "commit-result" });
  // As left by a dispatcher killed after creating its attempt and before any lease existed.
  await f.deps.attempts.create("open-a1", { pool: await f.deps.workspaces.pool() }, 0);
  const view = await status(f.deps);
  assert.equal(view.reason, "attention");
  assert.equal(view.attempts[0]?.nextAction.code, "confirm_attempt_stopped");
  assert.equal((await dispatchOnce(f.deps)).reason, "no_ready_work");
  const named = await dispatchOnce(f.deps, { taskId: "open-a1" });
  assert.equal(named.reason, "refused");
  assert.equal(named.nextAction.code, "confirm_attempt_stopped");

  assert.equal((await resolveLeaseReturned(f.deps, { taskId: "open-a1", note: "No dispatcher running" })).reason, "resolved");
  assert.equal((await dispatchOnce(f.deps)).attempt?.attempt, 2);
});

test("finding 4: a stop confirmation made before the worker starts prevents the dispatcher from starting it", async () => {
  const f = await fixture({ tasks: [task("fence-a1")], scenario: "commit-result" });
  const held = gate();
  const paused: Dependencies = { ...f.deps, launch: async (...args) => { await held.wait(); return f.deps.launch(...args); } };
  // The dispatcher has logged the launch but not yet reserved its runtime records.
  const dispatching = dispatchOnce(paused).catch(error => error as Error);
  await held.arrived;
  const leaseId = (await f.deps.attempts.forTask("fence-a1"))[0]!.entries.find(e => e.kind === "leased")!.data.leaseId as string;
  const resolved = await resolveStopped(f.deps, { leaseId, confirmed: true });
  held.open();
  const outcome = await dispatching;
  const runtime = await f.runtime.discover("fixture-context");
  // The dispatcher had not reserved its runtime records, so the confirmation succeeds and fences the launch.
  assert.equal(resolved.reason, "resolved");
  assert.equal(runtime.length, 0, "no worker may start after its stop was confirmed");
  assert.ok(!(outcome instanceof Error), String(outcome));
  assert.equal(outcome.worker?.status, "not_started");
});

test("finding 4: a stop confirmation is refused while the dispatcher is claiming the worker's runtime records", async () => {
  const f = await fixture({ tasks: [task("claiming-a1")], scenario: "commit-result" });
  const held = gate();
  const paused: Dependencies = { ...f.deps, launch: async (...args) => { await held.wait(); return f.deps.launch(...args); } };
  const dispatching = dispatchOnce(paused);
  await held.arrived;
  const leaseId = (await f.deps.attempts.forTask("claiming-a1"))[0]!.entries.find(e => e.kind === "leased")!.data.leaseId as string;
  // As if the dispatcher had created the runtime directory and not yet written its binding.
  assert.equal(await f.runtime.fence("fixture-context", leaseId), true);
  const refused = await resolveStopped(f.deps, { leaseId, confirmed: true });
  assert.equal(refused.reason, "refused");
  assert.equal(refused.nextAction.code, "watch_attempt");
  assert.ok(!(await f.deps.attempts.forTask("claiming-a1"))[0]!.entries.some(e => e.kind === "operator_resolved"));
  held.open();
  await dispatching;
});

test("finding 1: a dispatcher whose attempt was resolved while it waited does not acquire a lease", async () => {
  const f = await fixture({ tasks: [task("resolved-a1")], scenario: "commit-result" });
  const held = gate();
  let acquisitions = 0;
  let reads = 0;
  const paused: Dependencies = {
    ...f.deps,
    attempts: Object.assign(Object.create(Object.getPrototypeOf(f.deps.attempts)), f.deps.attempts, {
      read: async (ref: Parameters<Dependencies["attempts"]["read"]>[0]) => {
        reads += 1;
        if (reads === 1) await held.wait();
        return f.deps.attempts.read(ref);
      },
    }),
    workspaces: {
      leases: () => f.deps.workspaces.leases(), pool: () => f.deps.workspaces.pool(),
      recyclableRoots: () => f.deps.workspaces.recyclableRoots(),
      acquire: async request => { acquisitions += 1; return f.deps.workspaces.acquire(request); },
    },
  };
  const dispatching = dispatchOnce(paused);
  await held.arrived;
  assert.equal((await resolveLeaseReturned(f.deps, { taskId: "resolved-a1" })).reason, "resolved");
  held.open();
  const outcome = await dispatching;
  assert.equal(outcome.reason, "stopped");
  assert.equal(acquisitions, 0);
  assert.deepEqual(await f.deps.workspaces.leases(), []);
});
