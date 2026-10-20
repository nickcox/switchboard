import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchOnce, type Dependencies } from "../../src/dispatch/dispatch.ts";
import { WorkspaceError } from "../../src/workspaces/provider.ts";
import { resolveLeaseReturned } from "../../src/dispatch/resolve.ts";
import { describeStatus, status } from "../../src/dispatch/status.ts";
import { fixture, task } from "./fixture.ts";

// Treehouse names a repository's pool after its origin remote, so adding one hides every lease acquired before.
test("a lease in a workspace pool that is no longer listed is unknown and blocks its task until the operator confirms it was returned", async () => {
  const f = await fixture({ tasks: [task("pool-a1")], scenario: "commit-result" });
  const first = await dispatchOnce(f.deps);
  assert.equal(first.reason, "held");
  const leaseId = first.attempt!.leaseId!;

  f.run(["remote", "add", "origin", "https://example.invalid/fixture.git"]);
  assert.deepEqual(await f.deps.workspaces.leases(), []);
  const view = await status(f.deps);
  assert.equal(view.reason, "attention");
  assert.equal(view.attempts[0]?.leaseHeld, false);
  assert.ok(view.attempts[0]?.leaseInOtherPool);
  assert.equal(view.attempts[0]?.nextAction.code, "confirm_lease_returned");

  // Even once the task is ready again, it is not dispatched while its earlier lease may still be held.
  f.tasksCli(["unhold", "pool-a1"]);
  assert.deepEqual(await f.deps.tasks.ready(), ["pool-a1"]);
  assert.equal((await dispatchOnce(f.deps)).reason, "no_ready_work");
  const named = await dispatchOnce(f.deps, { taskId: "pool-a1" });
  assert.equal(named.reason, "refused");
  assert.equal(named.nextAction.code, "confirm_lease_returned");

  const resolved = await resolveLeaseReturned(f.deps, { leaseId, note: "Returned by path" });
  assert.equal(resolved.reason, "resolved");
  assert.equal((await resolveLeaseReturned(f.deps, { leaseId })).reason, "refused");
  const second = await dispatchOnce(f.deps);
  assert.equal(second.attempt?.taskId, "pool-a1");
  assert.equal(second.attempt?.attempt, 2);
});

test("a lost acquisition reply still records the pool and blocks redispatch after the origin changes", async () => {
  const f = await fixture({ tasks: [task("pool-c1")], scenario: "commit-result" });
  const pool = await f.deps.workspaces.pool();
  let acquisitions = 0;
  const deps: Dependencies = { ...f.deps, workspaces: {
    pool: () => f.deps.workspaces.pool(), leases: () => f.deps.workspaces.leases(),
    recyclableRoots: () => f.deps.workspaces.recyclableRoots(), returnLease: (lease, options) => f.deps.workspaces.returnLease(lease, options),
    acquire: async request => {
      acquisitions += 1;
      const attempt = (await f.deps.attempts.forTask(request.holder))[0]!;
      assert.equal(attempt.entries[0]?.data.pool, pool, "the pool is recorded before acquisition");
      await f.deps.workspaces.acquire(request);
      throw new WorkspaceError("outcome_unknown", "lost acknowledgement");
    },
  } };
  const first = await dispatchOnce(deps);
  assert.equal(first.reason, "stopped");
  assert.equal(first.lease, "preserved");
  const leaseId = first.attempt!.leaseId!;
  const attempt = (await f.deps.attempts.forTask("pool-c1"))[0]!;
  assert.deepEqual(attempt.entries.map(e => e.kind), ["requested", "halted"]);
  assert.equal(attempt.entries[1]?.data.reason, "outcome_unknown");

  f.run(["remote", "add", "origin", "https://example.invalid/fixture.git"]);
  assert.deepEqual(await f.deps.workspaces.leases(), []);
  const view = await status(f.deps);
  assert.equal(view.reason, "attention");
  assert.equal(view.attempts[0]?.leaseInOtherPool, pool);
  assert.equal(view.attempts[0]?.attempt.leaseId, leaseId);
  assert.equal(view.attempts[0]?.attempt.workspace, first.attempt?.workspace);
  assert.equal(view.attempts[0]?.nextAction.code, "confirm_lease_returned");
  assert.equal((await dispatchOnce(deps)).reason, "no_ready_work");
  assert.equal((await dispatchOnce(deps, { taskId: "pool-c1" })).nextAction.code, "confirm_lease_returned");
  assert.equal(acquisitions, 1);
  assert.equal((await resolveLeaseReturned(f.deps, { leaseId, note: "Returned by path" })).reason, "resolved");
  const second = await dispatchOnce(f.deps);
  assert.equal(second.attempt?.taskId, "pool-c1");
  assert.equal(second.attempt?.attempt, 2);
});

for (const rejected of [false, true]) {
  test(`a pool change after ${rejected ? "refused acquisition does not imply an unknown lease" : "unreadable acquisition inspection still reports an unknown lease"}`, async () => {
    const f = await fixture({ tasks: [task("pool-d1")] });
    const pool = await f.deps.workspaces.pool();
    let acquiring = false;
    await dispatchOnce({ ...f.deps, workspaces: {
      pool: () => f.deps.workspaces.pool(),
      recyclableRoots: () => f.deps.workspaces.recyclableRoots(), returnLease: (lease, options) => f.deps.workspaces.returnLease(lease, options),
      leases: () => acquiring ? Promise.reject(new Error("unreadable")) : f.deps.workspaces.leases(),
      acquire: async request => {
        acquiring = true;
        if (!rejected) await f.deps.workspaces.acquire(request);
        throw new WorkspaceError(rejected ? "rejected" : "outcome_unknown", "injected fault");
      },
    } });
    f.run(["remote", "add", "origin", "https://example.invalid/fixture.git"]);
    const view = await status(f.deps);
    assert.equal(view.attempts[0]?.leaseInOtherPool, rejected ? undefined : pool);
    if (!rejected) {
      assert.match(describeStatus(view), /UNKNOWN: its workspace pool is no longer listed/);
      assert.equal(view.attempts[0]?.attempt.leaseId, undefined);
      assert.match(view.attempts[0]!.nextAction.description, /resolve --task <task-id> --lease-returned/);
      assert.equal((await dispatchOnce(f.deps)).reason, "no_ready_work");
      const resolved = await resolveLeaseReturned(f.deps, { taskId: "pool-d1", note: "Returned through Treehouse" });
      assert.equal(resolved.reason, "resolved");
      const attempt = (await f.deps.attempts.forTask("pool-d1"))[0]!;
      assert.deepEqual(attempt.entries.at(-1)?.data, { action: "lease_returned", note: "Returned through Treehouse" });
      assert.equal((await resolveLeaseReturned(f.deps, { taskId: "pool-d1" })).reason, "refused");
      const second = await dispatchOnce(f.deps);
      assert.equal(second.attempt?.taskId, "pool-d1");
      assert.equal(second.attempt?.attempt, 2);
      assert.equal((await resolveLeaseReturned(f.deps, { taskId: "pool-d1" })).lease, "preserved");
      assert.match((await resolveLeaseReturned(f.deps, { taskId: "pool-d1", attempt: 1 })).detail!, /already confirmed/);
    }
  });
}

test("a lease in the listed pool needs no confirmation that it was returned", async () => {
  const f = await fixture({ tasks: [task("pool-b1")], scenario: "commit-result" });
  const first = await dispatchOnce(f.deps);
  const refused = await resolveLeaseReturned(f.deps, { leaseId: first.attempt!.leaseId! });
  assert.equal(refused.reason, "refused");
  assert.equal(refused.lease, "preserved");
  assert.equal((await resolveLeaseReturned(f.deps, { leaseId: "no-such-lease" })).reason, "refused");
  assert.equal((await resolveLeaseReturned(f.deps, { taskId: "pool-b1" })).lease, "preserved");
  assert.equal((await resolveLeaseReturned(f.deps, { taskId: "pool-b1", attempt: 99 })).reason, "refused");
  assert.equal((await resolveLeaseReturned(f.deps, { taskId: "no-such-task" })).reason, "refused");
});
