import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ObjectiveStore } from "../../src/objectives/store.ts";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { describeStatus, status } from "../../src/dispatch/status.ts";
import { testCaller } from "../caller.ts";
import { fixture, task } from "./fixture.ts";

async function objectiveFixture(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture({ scenario: "commit-result", ...options, tasks: [task("first"), task("next"), task("independent")] });
  const objectives = new ObjectiveStore(f.tasks.database, testCaller);
  await objectives.add({ id: "goal", request: "Do the work", acceptanceCriteria: ["It works"] });
  await f.tasks.update("first", { objectiveId: "goal" });
  await f.tasks.update("next", { objectiveId: "goal" });
  return { ...f, objectives };
}

test("dispatch, dry run and continuation share objective refusal, while replay and unlinked tasks are unaffected", async () => {
  const f = await objectiveFixture();
  try {
    await f.objectives.update("goal", { budget: { maxCost: 0.01, maxWorkerTimeMs: null } });
    const first = await dispatchOnce(f.deps, { taskId: "first", requestId: "first-request" });
    assert.equal(first.reason, "held");
    const state = await status(f.deps);
    const objective = state.objectives[0]!;
    assert.equal(objective.budget.maxCost, 0.01);
    assert.equal(objective.spending.cost, 0.01);
    assert.ok(objective.spending.workerTimeMs! > 0);
    assert.deepEqual(objective.spending.unknown, []);
    assert.match(describeStatus(state), /budget: cost 0.01[\s\S]*spending: cost 0.01[\s\S]*deadline: none/);
    for (const dryRun of [false, true]) {
      const refused = await dispatchOnce(f.deps, { taskId: "next", requestId: "next-request", dryRun });
      assert.equal(refused.reason, "refused");
      assert.equal(refused.observed.reason, "objective_cost_limit");
      assert.equal(refused.nextAction.code, "review_objective_budget");
      assert.equal(f.deps.attempts.taskAttemptCount("next"), 0);
    }
    const replay = await dispatchOnce(f.deps, { taskId: "first", requestId: "first-request" });
    assert.equal(replay.reason, "existing_request");
    assert.equal(f.deps.attempts.taskAttemptCount("first"), 1);
    await f.tasks.release("first");
    const continued = await dispatchOnce(f.deps, { taskId: "first", startingPoint: { taskId: "first", attempt: 1 }, requestId: "continuation" });
    assert.equal(continued.reason, "refused");
    assert.equal(continued.observed.reason, "objective_cost_limit");
    assert.equal(continued.nextAction.code, "review_objective_budget");
    assert.equal(f.deps.attempts.taskAttemptCount("first"), 1);
    assert.equal((await dispatchOnce(f.deps, { taskId: "independent" })).reason, "held");
    assert.equal(f.objectives.show("goal").spending.cost, 0.01, "unlinked work does not consume this budget");
    await f.objectives.update("goal", { budget: { maxCost: 0.02, maxWorkerTimeMs: null } });
    assert.equal((await dispatchOnce(f.deps, { taskId: "next" })).reason, "held");
    assert.equal(f.objectives.show("goal").spending.cost, 0.02);
  } finally { f.tasks.close(); }
});

test("an objective cost overrun stops the worker and records its reason as an over-budget task outcome", async () => {
  const f = await objectiveFixture({ worker: { statsMs: 10, requestPollMs: 10 } });
  try {
    await f.objectives.update("goal", { budget: { maxCost: 0.005, maxWorkerTimeMs: null } });
    const result = await dispatchOnce(f.deps, { taskId: "first" });
    assert.equal(result.reason, "held");
    const record = f.deps.attempts.findForTask("first")!;
    assert.equal(record.entries.find(entry => entry.kind === "task_recorded")!.data.category, "over_budget");
    const finish = record.entries.find(entry => entry.kind === "worker_finished")!;
    assert.equal(finish.data.reason, "over_budget");
    assert.match(String(finish.data.detail), /objective_cost_limit/);
    assert.equal((await f.tasks.read("first"))!.held, true);
    assert.equal(f.objectives.show("goal").spending.cost, 0.01);
  } finally { f.tasks.close(); }
});

test("an objective budget stops only its own attempt while another task keeps running", async () => {
  const f = await objectiveFixture({ scenario: "await-release", maxAttempts: 2, runMs: 25_000, worker: { statsMs: 10, requestPollMs: 10 } });
  const first = dispatchOnce(f.deps, { taskId: "first" });
  const independent = dispatchOnce(f.deps, { taskId: "independent" });
  try {
    const log = join(f.dir, "requests.jsonl");
    let running = false;
    for (let i = 0; i < 400; i += 1) {
      if (existsSync(log) && readFileSync(log, "utf8").split("\n").filter(line => line.includes('"type":"prompt"')).length === 2) { running = true; break; }
      await sleep(25);
    }
    assert.equal(running, true, "both synthetic workers must be running before lowering the budget");
    await f.objectives.update("goal", { budget: { maxCost: 0.005, maxWorkerTimeMs: null } });
    assert.equal((await first).reason, "held");
    const record = f.deps.attempts.findForTask("first")!;
    assert.equal(record.entries.find(entry => entry.kind === "task_recorded")!.data.category, "over_budget");
    assert.match(String(record.entries.find(entry => entry.kind === "worker_finished")!.data.detail), /objective_cost_limit/);
    const view = await status(f.deps);
    assert.deepEqual(view.capacity, { maximum: 2, active: 1 });
    const other = view.attempts.find(attempt => attempt.attempt.taskId === "independent")!;
    assert.equal(other.worker!.exit, "not_observed");
    assert.equal(other.worker!.dispatcherHeartbeat, "fresh");
    assert.deepEqual(view.blockingDispatch, []);
  } finally {
    writeFileSync(join(f.dir, "release"), "");
    await Promise.all([first, independent]);
    f.tasks.close();
  }
  assert.equal((await independent).reason, "held");
});

test("status identifies unknown finished usage without presenting its cost as zero", async () => {
  const f = await objectiveFixture();
  try {
    await dispatchOnce(f.deps, { taskId: "first" });
    // Emulate a historical runtime whose diagnostic snapshots were unavailable.
    await f.tasks.database.transaction(() => {
      f.tasks.database.run("DELETE FROM worker_usage");
      f.tasks.database.run("DELETE FROM worker_activity WHERE json_extract(entry, '$.kind') = 'stats'");
    });
    const state = await status(f.deps);
    assert.equal(state.objectives[0]!.spending.cost, null);
    assert.equal(state.objectives[0]!.spending.unknown[0]!.taskId, "first");
    assert.match(describeStatus(state), /cost unknown \(observed 0\)[\s\S]*first\/1 \(cost\)/);
    const refused = await dispatchOnce(f.deps, { taskId: "next" });
    assert.equal(refused.observed.reason, "objective_usage_unknown");
    assert.equal(refused.nextAction.code, "review_objective_budget");
    await f.objectives.confirmBudget("goal", "Inspected the historical session and allow further work");
    assert.equal((await dispatchOnce(f.deps, { taskId: "next" })).reason, "held");
    assert.equal(f.objectives.show("goal").spending.cost, null);
  } finally { f.tasks.close(); }
});
