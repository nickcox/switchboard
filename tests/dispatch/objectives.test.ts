import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { onPath } from "../../src/infra/executables.ts";
import { ObjectiveStore } from "../../src/objectives/store.ts";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { finish } from "../../src/dispatch/finish.ts";
import { createReview } from "../../src/dispatch/review.ts";
import { describeStatus, status } from "../../src/dispatch/status.ts";
import { PiWorker } from "../../src/runtime/pi/worker.ts";
import { fixture, task } from "./fixture.ts";

for (const policy of ["manual", "local-merge"] as const) test(`an objective uses the exact commit accepted by ordinary finish under ${policy}, not a worker result alone`, async () => {
  const taskId = `objective-${policy}`;
  const f = await fixture({ tasks: [task(taskId)], scenario: "commit-result" });
  try {
    f.deps.policy = { git: onPath("git"), environment: f.environment, repository: f.deps.repository, baseRef: "main",
      globalFile: join(f.dir, "no-global-policy.json"), context: { kind: policy } };
    const objectives = new ObjectiveStore(f.tasks.database, "operator:fixture");
    await objectives.add({ id: "goal", request: "Implement this change", acceptanceCriteria: ["The change is retained"] });
    await f.tasks.update(taskId, { objectiveId: "goal" });
    const dispatched = await dispatchOnce(f.deps, { taskId });
    assert.equal(dispatched.reason, "held", JSON.stringify(dispatched));
    assert.deepEqual(objectives.references("goal"), [], "The worker's commit is not acceptance");
    const record = f.deps.attempts.findForTask(taskId)!;
    assert.equal(record.specification!.objectiveId, "goal");
    const view = await status(f.deps);
    assert.partialDeepStrictEqual(view.objectives, [{ id: "goal", request: "Implement this change", state: "open", taskCount: 1, doneTaskCount: 0 }]);
    assert.match(describeStatus(view), /Objective goal: Implement this change; 0\/1 tasks done/);
    const finished = await finish(f.deps, { leaseId: dispatched.attempt!.leaseId!, noProcesses: false });
    assert.equal(finished.reason, "finished", JSON.stringify(finished));
    assert.equal(objectives.read("goal")!.state, "open", "Finishing all tasks does not finish the objective");
    const references = objectives.references("goal");
    assert.deepEqual(references, [{ kind: "accepted_commit", contextId: f.deps.contextId, taskId, attempt: 1, commit: dispatched.attempt!.resultCommit }]);
    assert.equal(objectives.show("goal").tasks[0]!.state, "done");
    assert.match(describeStatus(await status(f.deps)), /Objective goal: Implement this change; 1\/1 tasks done/);
    await objectives.complete("goal", [{ position: 1, statement: "The finished output contains the requested change", references }]);
    assert.deepEqual((await status(f.deps)).objectives, []);
  } finally { f.tasks.close(); }
});

test("review tasks inherit objective membership and their recorded findings can support objective completion", async () => {
  const taskId = "objective-review";
  const f = await fixture({ tasks: [task(taskId)], scenario: "commit-result", byTaskKind: {
    review: { kind: "artefact", acceptance: "independent_deliverable", requiredEvidence: [], requiredDeliverables: ["report"] },
  } });
  try {
    const objectives = new ObjectiveStore(f.tasks.database, "operator:fixture");
    await objectives.add({ id: "goal", request: "Make and review the change", acceptanceCriteria: ["The change meets its task criterion"] });
    await f.tasks.update(taskId, { objectiveId: "goal", acceptanceCriteria: ["Keep the output"] });
    const first = await dispatchOnce(f.deps, { taskId });
    assert.equal(first.reason, "held", JSON.stringify(first));
    const created = await createReview(f.deps, { taskId });
    assert.equal(created.reason, "review_created", JSON.stringify(created));
    const reviewId = created.task!.id;
    assert.equal((await f.tasks.read(reviewId))!.objectiveId, "goal");
    const worker = new PiWorker(f.runtime, {
      executable: process.execPath, entrypoint: resolve(import.meta.dirname, "../fixtures/pi-rpc.ts"), provider: "fixture", model: "fixture", shellTool: "bash",
      requestMs: 2000, runMs: 5000, stopMs: 600, environment: { ...f.environment, FAKE_PI_SCENARIO: "review-pass", FAKE_PI_LOG: resolve(f.dir, "review-requests.jsonl") },
    });
    f.deps.launch = (input, signal, onRequest) => worker.execute(input, signal, onRequest ? { onRequest } : {});
    const reviewed = await dispatchOnce(f.deps, { taskId: reviewId });
    assert.equal(reviewed.reason, "done", JSON.stringify(reviewed));
    const reference = objectives.references("goal").find(ref => ref.kind === "review")!;
    assert.deepEqual(reference, { kind: "review", contextId: f.deps.contextId, taskId, attempt: 1, commit: first.attempt!.resultCommit, reviewTaskId: reviewId, reviewAttempt: 1 });
    await objectives.complete("goal", [{ position: 1, statement: "The review judged the task's criterion met", references: [reference] }]);
    assert.equal(objectives.read("goal")!.state, "completed");
    assert.equal((await f.tasks.read(taskId))!.held, true, "Completing an objective does not accept or integrate its tasks");
  } finally { f.tasks.close(); }
});
