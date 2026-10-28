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
  assert.equal(outcome.nextAction.code, "review_then_finish", JSON.stringify(outcome, null, 2));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.lease, "preserved");
  assert.equal(outcome.retention?.retained, true);
  assert.equal(outcome.attempt?.outputBranch, "switchboard/work-a1/attempt-1");
  assert.equal(run(["rev-parse", "refs/heads/switchboard/work-a1/attempt-1"]), outcome.attempt?.resultCommit);
  const held = await tasks.read("work-a1");
  assert.equal(held?.state, "queued");
  assert.equal(held?.held, true);
  assert.equal(held?.holdReason, "Switchboard attempt 1 review required");
  assert.equal(held?.body, "Implement the fixture change");
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

test("a provider error reaches the dispatch report and attempt log without changing instructions", async () => {
  const { deps, tasks } = await fixture({ tasks: [task("error-a1")], scenario: "model-error" });
  const outcome = await dispatchOnce(deps);
  const detail = "The model request ended with stop reason error: WebSocket error";
  assert.equal(outcome.reason, "held");
  assert.equal(outcome.worker?.status, "failed");
  assert.equal(outcome.worker?.reason, detail);
  const entries = (await deps.attempts.forTask("error-a1"))[0]!.entries;
  const finished = entries.find(entry => entry.kind === "worker_finished")!;
  assert.equal(finished.data.reason, "invalid_model_end");
  assert.equal(finished.data.detail, detail);
  const held = await tasks.read("error-a1");
  assert.equal(held?.held, true);
  assert.equal(held?.body, "Implement the fixture change");
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
  const { deps, runtime, dir } = await fixture({ tasks: [task("next-a1"), task("earlier-a1")] });
  const workspace = join(dir, "orphan-workspace");
  mkdirSync(workspace);
  // A runtime binding with no exit record, as left by a dispatcher that died after launching a worker.
  const ref = await deps.attempts.create("earlier-a1", {}, 0);
  await deps.attempts.append(ref, "leased", { leaseId: "lease-x", workspace, baseRef: "main", outputBranch: "o", startingCommit: "a".repeat(40) });
  const reserved = await runtime.reserve({
    identity: { contextId: "fixture-context", taskId: "earlier-a1", leaseId: "lease-x", sessionId: randomUUID() },
    workspace, instructions: "Earlier", acceptanceCriteria: [],
    delivery: { baseRef: "main", startingCommit: "a".repeat(40), outputBranch: "o", kind: "code", acceptance: "review_or_integration", requiredEvidence: [], requiredDeliverables: [] },
  });
  await reserved.storage.releaseClaim(reserved.claimId);
  const outcome = await dispatchOnce(deps);
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

for (const done of [true, false]) {
  test(`a ${done ? "done" : "hold"} update with a worker record longer than any command-line limit succeeds and reads back`, async () => {
    const f = await fixture({ tasks: [task("long-a1")], scenario: "commit-result", acceptance: done ? "independent_deliverable" : "review_or_integration" });
    const launch = f.deps.launch;
    f.deps.launch = async (...args) => {
      const report = await launch(...args);
      assert.ok(report.result);
      // Longer than Windows' whole command line, Linux's per-argument limit and macOS's total argument space.
      report.result.summary = "s".repeat(1_500_000);
      return report;
    };
    const outcome = await dispatchOnce(f.deps);
    assert.equal(outcome.reason, done ? "done" : "held", String(outcome.detail).slice(0, 1500));
    const recorded = await f.tasks.read("long-a1");
    assert.equal(recorded?.state, done ? "done" : "queued");
    assert.equal(recorded!.body, "Implement the fixture change");
  });
}
