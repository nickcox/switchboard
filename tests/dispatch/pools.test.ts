import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { resolveLeaseReturned } from "../../src/dispatch/resolve.ts";
import { status } from "../../src/dispatch/status.ts";
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

test("a lease in the listed pool needs no confirmation that it was returned", async () => {
  const f = await fixture({ tasks: [task("pool-b1")], scenario: "commit-result" });
  const first = await dispatchOnce(f.deps);
  const refused = await resolveLeaseReturned(f.deps, { leaseId: first.attempt!.leaseId! });
  assert.equal(refused.reason, "refused");
  assert.equal(refused.lease, "preserved");
  assert.equal((await resolveLeaseReturned(f.deps, { leaseId: "no-such-lease" })).reason, "refused");
});
