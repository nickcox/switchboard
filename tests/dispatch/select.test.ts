import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { leaseOfTask } from "../../src/dispatch/select.ts";
import { WorkspaceError } from "../../src/workspaces/provider.ts";
import { fixture, task } from "./fixture.ts";

// Selecting an attempt by task for the commands that act on its lease: finish, discard, watch, stop and steer.

test("a task's latest attempt, or a numbered one, is selected by its lease; one without a lease is refused", async () => {
  const f = await fixture({ tasks: [task("pick-a1")], scenario: "commit-result" });
  const workspaces = {
    ...f.deps.workspaces, leases: () => f.deps.workspaces.leases(), pool: () => f.deps.workspaces.pool(),
    recyclableRoots: () => f.deps.workspaces.recyclableRoots(), acquire: async () => { throw new WorkspaceError("rejected", "refused"); },
  };
  // The first attempt stops before a lease is acquired; the second gets one.
  await dispatchOnce({ ...f.deps, workspaces });
  const second = await dispatchOnce(f.deps, { taskId: "pick-a1" });
  assert.equal(second.attempt?.attempt, 2);
  assert.deepEqual(await leaseOfTask(f.deps, "pick-a1"), { leaseId: second.attempt!.leaseId });
  assert.deepEqual(await leaseOfTask(f.deps, "pick-a1", 2), { leaseId: second.attempt!.leaseId });
  const leaseless = await leaseOfTask(f.deps, "pick-a1", 1);
  assert.ok("refused" in leaseless);
  assert.match(leaseless.refused.detail ?? "", /has no lease/);
  assert.equal(leaseless.refused.attempt?.attempt, 1);
  for (const [taskId, attempt] of [["pick-a1", 3], ["unknown-z9", undefined]] as const) {
    const selected = await leaseOfTask(f.deps, taskId, attempt);
    assert.ok("refused" in selected);
    assert.equal(selected.refused.reason, "refused");
    assert.match(selected.refused.detail ?? "", /has no attempt/);
  }
});
