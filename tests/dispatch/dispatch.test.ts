import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { fixture, task } from "./fixture.ts";

test("no ready work is a successful no-op", async () => {
  const { deps } = await fixture();
  const outcome = await dispatchOnce(deps);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reason, "no_ready_work");
  assert.equal(outcome.lease, "none");
});

test("completed code work is held for review, retained on its branch, and the lease is preserved", async () => {
  const { deps, tasks, run } = await fixture({ tasks: [task("work-a1")], scenario: "commit-result" });
  const outcome = await dispatchOnce(deps);
  assert.equal(outcome.nextAction.code, "review_branch", JSON.stringify(outcome, null, 2));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.lease, "preserved");
  assert.equal(outcome.retention?.retained, true);
  assert.equal(outcome.attempt?.outputBranch, "switchboard/work-a1/attempt-1");
  assert.equal(run(["rev-parse", "refs/heads/switchboard/work-a1/attempt-1"]), outcome.attempt?.resultCommit);
  const held = await tasks.read("work-a1");
  assert.equal(held?.state, "queued");
  assert.equal(held?.held, true);
  assert.equal(held?.holdReason, "Switchboard attempt 1 review required");
  assert.ok(held?.body.startsWith("Implement the fixture change\n\n## Switchboard attempt 1"));
  assert.ok(held?.body.includes(outcome.attempt!.resultCommit!));
  const entries = (await deps.attempts.forTask("work-a1"))[0]!.entries.map(e => e.kind);
  assert.deepEqual(entries, ["requested", "leased", "task_started", "launched", "worker_finished", "retention_checked", "task_recorded"]);
  assert.equal((await deps.workspaces.leases()).filter(l => l.holder === "work-a1").length, 1);
});

test("an independent deliverable that is retained is recorded as done", async () => {
  const { deps, tasks } = await fixture({ tasks: [task("done-a1")], scenario: "commit-result", acceptance: "independent_deliverable" });
  const outcome = await dispatchOnce(deps);
  assert.equal(outcome.reason, "done", JSON.stringify(outcome, null, 2));
  assert.equal(outcome.ok, true);
  assert.equal((await tasks.read("done-a1"))?.state, "done");
  assert.equal(outcome.lease, "preserved");
});

test("a reported commit that is not on the output branch is held as not retained", async () => {
  // The default synthetic worker reports a commit ID that does not exist.
  const { deps, tasks } = await fixture({ tasks: [task("ghost-a1")], acceptance: "independent_deliverable" });
  const outcome = await dispatchOnce(deps);
  assert.equal(outcome.reason, "held");
  assert.equal(outcome.retention?.retained, false);
  assert.equal((await tasks.read("ghost-a1"))?.held, true);
});

test("a worker with no valid result is held as failed", async () => {
  const { deps, tasks } = await fixture({ tasks: [task("fail-a1")], scenario: "missing-result" });
  const outcome = await dispatchOnce(deps);
  assert.equal(outcome.reason, "held");
  assert.equal(outcome.worker?.status, "failed");
  assert.equal((await tasks.read("fail-a1"))?.holdReason, "Switchboard attempt 1 failed");
});

test("a held task is not dispatched again, and naming it explicitly is refused because of its lease", async () => {
  const { deps } = await fixture({ tasks: [task("again-a1")], scenario: "commit-result" });
  await dispatchOnce(deps);
  assert.equal((await dispatchOnce(deps)).reason, "no_ready_work");
  assert.equal((await dispatchOnce(deps, { taskId: "again-a1" })).nextAction.code, "choose_another_task");
});

test("a repeated request ID returns the existing attempt without dispatching again", async () => {
  const { deps } = await fixture({ tasks: [task("req-a1"), task("req-b1")], scenario: "commit-result" });
  const first = await dispatchOnce(deps, { requestId: "request-1" });
  const again = await dispatchOnce(deps, { requestId: "request-1" });
  assert.equal(again.reason, "existing_request");
  assert.equal(again.attempt?.taskId, first.attempt?.taskId);
  assert.equal(again.attempt?.leaseId, first.attempt?.leaseId);
  assert.equal((await deps.workspaces.leases()).length, 1);
});

test("an attempt whose worker may still be running blocks all dispatch", async () => {
  const { deps, runtime, dir } = await fixture({ tasks: [task("next-a1")] });
  const workspace = join(dir, "orphan-workspace");
  mkdirSync(workspace);
  // A runtime binding with no exit record, as left by a dispatcher that died after launching a worker.
  await runtime.reserve({
    identity: { contextId: "fixture-context", taskId: "earlier-a1", leaseId: "lease-x", sessionId: randomUUID() },
    workspace, instructions: "Earlier", acceptanceCriteria: [],
    delivery: { baseRef: "main", startingCommit: "a".repeat(40), outputBranch: "o", kind: "code", acceptance: "review_or_integration", requiredEvidence: [], requiredDeliverables: [] },
  });
  const outcome = await dispatchOnce(deps);
  assert.equal(outcome.nextAction.code, "stop_worker");
  assert.equal(outcome.nextAction.code, "stop_worker");
  assert.deepEqual(await deps.attempts.forTask("next-a1"), []);
});

test("a refused lease leaves the task unchanged and records why the attempt stopped", async () => {
  const { deps, tasks } = await fixture({ tasks: [task("refused-a1")], baseRef: "missing-base" });
  const outcome = await dispatchOnce(deps);
  assert.equal(outcome.reason, "stopped");
  assert.equal(outcome.lease, "none");
  const unchanged = await tasks.read("refused-a1");
  assert.equal(unchanged?.state, "queued");
  assert.equal(unchanged?.held, false);
  assert.deepEqual((await deps.attempts.forTask("refused-a1"))[0]!.entries.map(e => e.kind), ["requested", "halted"]);
});
