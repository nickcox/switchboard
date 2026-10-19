import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchOnce, type ContractSpec } from "../../src/dispatch/dispatch.ts";
import { describe } from "../../src/dispatch/result.ts";
import { fixture, task } from "./fixture.ts";

test("dry run selects and resolves contracts without changing any owner or launching a worker", async () => {
  const scout: ContractSpec = { kind: "artefact", acceptance: "independent_deliverable", requiredEvidence: ["tests"], requiredDeliverables: ["report"] };
  const { deps, tasks } = await fixture({
    tasks: [task("dry-a1"), [...task("dry-b1"), "--kind", "scout"]], byTaskKind: { scout },
  });
  deps.launch = async () => { assert.fail("Dry run must not launch a worker"); };
  const snapshot = async () => ({
    attempts: await deps.attempts.list(), leases: await deps.workspaces.leases(),
    tasks: await Promise.all([tasks.read("dry-a1"), tasks.read("dry-b1")]),
    runtime: await deps.runtime.discover(deps.contextId),
  });
  const before = await snapshot();
  const automatic = await dispatchOnce(deps, { dryRun: true, requestId: "preview" });
  assert.equal(automatic.reason, "dry_run");
  assert.equal(automatic.ok, true);
  assert.equal(automatic.lease, "none");
  assert.equal(automatic.attempt, undefined);
  assert.deepEqual(automatic.selection, { taskId: (await tasks.ready())[0], contract: { name: "default", ...deps.delivery.default } });
  const explicit = await dispatchOnce(deps, { dryRun: true, taskId: "dry-b1" });
  assert.deepEqual(explicit.selection, { taskId: "dry-b1", contract: { name: "scout", ...scout } });
  assert.match(describe(explicit), /Task dry-b1, delivery contract scout/);
  assert.deepEqual(await snapshot(), before);
});

test("dry run gives the same empty result and selection refusals as dispatch", async () => {
  const { deps } = await fixture({ tasks: [[...task("dry-a1"), "--kind", "unknown"]] });
  for (const taskId of [undefined, "dry-a1", "missing-a1"]) {
    const options = taskId === undefined ? {} : { taskId };
    const real = await dispatchOnce(deps, options);
    assert.equal(real.reason, "refused");
    assert.deepEqual(await dispatchOnce(deps, { ...options, dryRun: true }), real);
  }
  const empty = await fixture();
  assert.deepEqual(await dispatchOnce(empty.deps, { dryRun: true }), await dispatchOnce(empty.deps));
});

test("dry run shares preflight failures and existing request handling", async () => {
  const { deps } = await fixture({ tasks: [task("dry-a1")] });
  const ref = await deps.attempts.create("dry-a1", { requestId: "existing" }, 0);
  assert.deepEqual(
    await dispatchOnce(deps, { dryRun: true, requestId: "existing" }),
    await dispatchOnce(deps, { requestId: "existing" }),
  );
  await deps.attempts.append(ref, "launched", { sessionId: "00000000-0000-0000-0000-000000000000" });
  const real = await dispatchOnce(deps);
  assert.equal(real.reason, "refused");
  assert.equal(real.nextAction.code, "stop_worker");
  assert.deepEqual(await dispatchOnce(deps, { dryRun: true }), real);
  deps.workspaces.leases = async () => { throw new Error("Unavailable"); };
  assert.deepEqual(await dispatchOnce(deps, { dryRun: true }), await dispatchOnce(deps));
});
