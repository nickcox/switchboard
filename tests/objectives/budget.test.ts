import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AttemptStore, ObjectiveStore, SqliteTaskStore } from "../caller.ts";
import { ObjectiveStore as HostedObjectiveStore } from "../../src/objectives/store.ts";
import { RuntimeStore } from "../../src/runtime/store.ts";
import { objectiveBudget, attemptSpending, checkObjectiveBudget } from "../../src/objectives/budget.ts";
import type { AttemptRef } from "../../src/attempts/log.ts";
import { RuntimeRecords, type ChildExit, type RuntimeBinding } from "../../src/runtime/records.ts";
import { WorkerSupervisor, type RuntimeSession } from "../../src/runtime/supervisor.ts";
import { RuntimeFailure } from "../../src/runtime/async.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { specificationFor } from "../helpers.ts";

async function fixture() {
  const root = resolve(".investigation/objective-budgets");
  await mkdir(root, { recursive: true });
  const dir = await realpath(await mkdtemp(join(root, "case-")));
  const tasks = await SqliteTaskStore.open({ path: join(dir, "switchboard.db"), repo: "fixture" });
  const objectives = new ObjectiveStore(tasks.database, "operator:creator");
  await objectives.add({ id: "goal", request: "Do the work", acceptanceCriteria: ["It works"] });
  const attempts = new AttemptStore(tasks.database, "fixture");
  const runtime = new RuntimeStore(tasks.database);
  async function reserve(id: string, store = attempts, objectiveId: string | null = "goal") {
    if (!(await tasks.read(id))) await tasks.add({ id, title: id, objectiveId });
    return store.reserveAttempt({ taskId: id, maximum: 10, maximumPerTask: 10, requested: {}, specification: specificationFor });
  }
  async function launch(ref: AttemptRef, createdAt = "2020-01-01T00:00:00.000Z") {
    const directory = join(dir, `${ref.contextId}-${ref.taskId}-${ref.attempt}`);
    const leaseId = randomUUID();
    await new AttemptStore(tasks.database, ref.contextId).append(ref, "leased", {
      leaseId, workspace: dir, backingRepository: dir, baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40),
    });
    const binding: RuntimeBinding = { version: 1, createdAt, sessionDirectory: join(directory, "sessions"), artefactDirectory: join(directory, "artefacts"), resultPath: join(directory, "result.json"),
      input: { identity: { contextId: ref.contextId, taskId: ref.taskId, leaseId, sessionId: randomUUID() }, workspace: dir, instructions: "Work", acceptanceCriteria: [],
        delivery: { baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40), kind: "code", acceptance: "review_or_integration", requiredEvidence: [], requiredDeliverables: [] } } };
    await runtime.claimLaunch({ context: ref.contextId, task: ref.taskId, attempt: ref.attempt, leaseId, directory, createdAt }, binding);
    return directory;
  }
  async function exit(ref: AttemptRef, directory: string, at = "2020-01-01T00:00:01.000Z", started = true) {
    await tasks.database.transaction(() => tasks.database.run("INSERT INTO worker_observations VALUES(?,?,?,?)", directory, "exit", at,
      JSON.stringify({ started, code: 0, signal: null })));
    await new AttemptStore(tasks.database, ref.contextId).append(ref, "halted", { stage: "fixture", reason: "stopped" });
  }
  return { dir, tasks, objectives, attempts, runtime, reserve, launch, exit };
}

test("spending sums latest cost and worker time across tasks, attempts and contexts, and survives archiving", async () => {
  const f = await fixture();
  try {
    const first = (await f.reserve("work")).ref;
    const directory = await f.launch(first);
    await f.runtime.recordUsage(directory, { cost: 1, tokens: 10 });
    await f.runtime.recordUsage(directory, { cost: 2, tokens: 20 });
    await f.exit(first, directory);
    const otherContext = new AttemptStore(f.tasks.database, "other-context");
    const second = (await f.reserve("work", otherContext)).ref;
    const otherDirectory = await f.launch(second);
    await f.runtime.recordUsage(otherDirectory, { cost: 3, tokens: 30 });
    await f.exit(second, otherDirectory);
    const running = (await f.reserve("parallel")).ref;
    const runningDirectory = await f.launch(running);
    await f.runtime.recordUsage(runningDirectory, { cost: 0, tokens: 10 });
    const now = Date.parse("2020-01-01T00:00:02.000Z");
    const before = objectiveBudget(f.tasks.database, "goal", now);
    assert.deepEqual(before.spending, { cost: 5, observedCost: 5, workerTimeMs: 4000, observedWorkerTimeMs: 4000, unknown: [] });
    await f.attempts.archiveAttempt(f.attempts.read(first), {}, []);
    assert.equal(f.tasks.database.get("SELECT 1 FROM worker_usage WHERE directory = ?", directory), undefined);
    assert.deepEqual(objectiveBudget(f.tasks.database, "goal", now), before);
    assert.deepEqual(f.objectives.show("goal").spending.cost, 5);
  } finally { f.tasks.close(); }
});

for (const [name, budget, reason] of [
  ["cost", { maxCost: 2, maxWorkerTimeMs: null }, "objective_cost_limit"],
  ["worker time, even with zero subscription cost", { maxCost: null, maxWorkerTimeMs: 1000 }, "objective_worker_time_limit"],
] as const) {
  test(`reservation refuses at the objective ${name} limit inside its transaction`, async () => {
    const f = await fixture();
    try {
      const first = (await f.reserve("work")).ref;
      const directory = await f.launch(first);
      await f.runtime.recordUsage(directory, { cost: name === "cost" ? 2 : 0, tokens: 50 });
      await f.exit(first, directory);
      await f.objectives.update("goal", { budget });
      await f.tasks.add({ id: "next", title: "Next", objectiveId: "goal" });
      for (const dryRun of [false, true]) {
        await assert.rejects(f.attempts.reserveAttempt({ taskId: "next", maximum: 10, requested: { requestId: "refused" }, specification: specificationFor, dryRun }),
          { reason, nextAction: "review_objective_budget" });
        assert.equal(f.attempts.taskAttemptCount("next"), 0);
        assert.equal(await f.attempts.findByRequest("refused"), undefined);
      }
      assert.equal(checkObjectiveBudget("goal", objectiveBudget(f.tasks.database, "goal"), true), undefined, "running workers are stopped over, not at, the budget");
      assert.equal((await f.reserve("independent", f.attempts, null)).created, true, "unlinked tasks are unaffected");
    } finally { f.tasks.close(); }
  });
}

test("a past deadline and zero budgets refuse even the first attempt, without reserving it", async () => {
  const f = await fixture();
  try {
    await f.objectives.update("goal", { deadline: "2000-01-01T00:00:00Z" });
    await assert.rejects(f.reserve("work"), { reason: "objective_deadline", nextAction: "review_objective_budget" });
    assert.equal(f.objectives.show("goal").timeLeftMs, 0);
    assert.equal(f.attempts.taskAttemptCount("work"), 0);
    await f.objectives.update("goal", { deadline: null, budget: { maxCost: 0, maxWorkerTimeMs: null } });
    await assert.rejects(f.reserve("work"), { reason: "objective_cost_limit" });
    await f.objectives.update("goal", { budget: { maxCost: null, maxWorkerTimeMs: 0 } });
    await assert.rejects(f.reserve("work"), { reason: "objective_worker_time_limit" });
    assert.equal((await f.reserve("independent", f.attempts, null)).created, true);
  } finally { f.tasks.close(); }
});

test("missing finished usage stays unknown and refuses further attempts until the creator confirms it", async () => {
  const f = await fixture();
  try {
    const first = (await f.reserve("work")).ref;
    const directory = await f.launch(first);
    const running = objectiveBudget(f.tasks.database, "goal", Date.parse("2020-01-01T00:00:02Z"));
    assert.equal(running.spending.cost, null);
    assert.equal(running.spending.workerTimeMs, 2000);
    assert.equal(running.spending.unknown[0]!.finished, false);
    await f.exit(first, directory);
    const shown = f.objectives.show("goal");
    assert.equal(shown.spending.cost, null);
    assert.equal(shown.spending.observedCost, 0, "zero is only the known subtotal, not the total");
    assert.equal(shown.spending.unknown[0]!.confirmed, false);
    await assert.rejects(f.reserve("next"), { reason: "objective_usage_unknown" });
    await assert.rejects(new HostedObjectiveStore(f.tasks.database, { kind: "supervisor", objectiveId: "goal" }).confirmBudget("goal", "Allow it"), /person_required/);
    await assert.rejects(new ObjectiveStore(f.tasks.database, "operator:other").confirmBudget("goal", "Allow it"), /creator_required/);
    await assert.rejects(f.objectives.confirmBudget("goal", " "), { reason: "rejected" });
    await f.objectives.confirmBudget("goal", "Inspected the subscription session; allow further work despite unknown cost");
    assert.equal(f.objectives.show("goal").spending.cost, null, "confirmation never invents zero usage");
    assert.equal(f.objectives.show("goal").spending.unknown[0]!.confirmed, true);
    assert.equal((await f.reserve("next")).created, true);
    const last = f.objectives.history("goal").at(-1)!;
    assert.equal(last.action, "confirm-budget");
    assert.equal(last.changedBy, "operator:creator");
    assert.match(last.changes.note, /Inspected/);
    await f.attempts.archiveAttempt(f.attempts.read(first), {}, []);
    assert.equal(f.objectives.show("goal").spending.unknown[0]!.confirmed, true);
  } finally { f.tasks.close(); }
});

test("raising a budget confirms only the currently finished unknown attempts, not future ones", async () => {
  const f = await fixture();
  try {
    await f.objectives.update("goal", { budget: { maxCost: 1, maxWorkerTimeMs: null } });
    const first = (await f.reserve("work")).ref;
    const directory = await f.launch(first);
    await f.exit(first, directory);
    await assert.rejects(f.reserve("next"), { reason: "objective_usage_unknown" });
    await f.objectives.update("goal", { budget: { maxCost: 2, maxWorkerTimeMs: null } });
    const next = (await f.reserve("next")).ref;
    const nextDirectory = await f.launch(next);
    await f.exit(next, nextDirectory);
    await assert.rejects(f.reserve("third"), { reason: "objective_usage_unknown" });
    assert.deepEqual(f.objectives.show("goal").spending.unknown.map(a => a.confirmed).sort(), [false, true]);
  } finally { f.tasks.close(); }
});

test("an operator-confirmed stop without an observed exit leaves worker time unknown", async () => {
  const f = await fixture();
  try {
    const ref = (await f.reserve("work")).ref;
    const directory = await f.launch(ref);
    await f.runtime.recordUsage(directory, { cost: 0, tokens: 1 });
    await f.runtime.confirmStopped(directory, { kind: "person", id: "operator:test" });
    const spending = attemptSpending(f.tasks.database, ref);
    assert.equal(spending.workerTimeMs, null);
    assert.equal(spending.cost, 0);
    assert.equal(spending.finished, true);
    await assert.rejects(f.reserve("next"), { reason: "objective_usage_unknown" });
  } finally { f.tasks.close(); }
});

test("unused reservations and observed spawn failures have known zero worker spending", async () => {
  const f = await fixture();
  try {
    const unused = (await f.reserve("unused")).ref;
    assert.deepEqual(attemptSpending(f.tasks.database, unused), { ...unused, cost: 0, workerTimeMs: 0, finished: false });
    const failed = (await f.reserve("failed")).ref;
    const directory = await f.launch(failed);
    await f.exit(failed, directory, undefined, false);
    assert.deepEqual(attemptSpending(f.tasks.database, failed), { ...failed, cost: 0, workerTimeMs: 0, finished: true });
  } finally { f.tasks.close(); }
});

for (const limit of ["cost", "worker time", "deadline"] as const) {
  test(`the owning dispatcher stops a running worker over the objective ${limit}, even when usage fails`, async () => {
    const f = await fixture();
    try {
      const earlier = (await f.reserve("earlier")).ref;
      const earlierDirectory = await f.launch(earlier);
      await f.runtime.recordUsage(earlierDirectory, { cost: 1, tokens: 10 });
      await f.exit(earlier, earlierDirectory);
      await f.objectives.update("goal", { budget: { maxCost: limit === "cost" ? 1.5 : null, maxWorkerTimeMs: limit === "worker time" ? 1050 : null } });
      const ref = (await f.reserve("active")).ref;
      const workspace = join(f.dir, "workspace");
      await mkdir(workspace);
      const leaseId = randomUUID();
      await f.attempts.append(ref, "leased", { leaseId, workspace, backingRepository: f.dir, baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40) });
      await f.attempts.startReservedTask(ref);
      const input: RuntimeBinding["input"] = { identity: { contextId: ref.contextId, taskId: ref.taskId, leaseId, sessionId: randomUUID() }, workspace,
        instructions: "Work", acceptanceCriteria: [], delivery: { baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40), kind: "code", acceptance: "review_or_integration", requiredEvidence: [], requiredDeliverables: [] } };
      const records = new RuntimeRecords(join(f.dir, "runtime"), f.tasks.database);
      let childExit: ChildExit | undefined;
      let resolveExit: (exit: ChildExit) => void = () => {};
      const exited = new Promise<ChildExit>(resolve => { resolveExit = resolve; });
      let stopped = false;
      const notes: string[] = [];
      const supervisor = new WorkerSupervisor(records, {
        open() {
          const session: RuntimeSession = {
            exited, get childExit() { return childExit; }, failure: undefined, stderrTail: "",
            async start() {
              if (limit === "deadline") await f.objectives.update("goal", { deadline: new Date(Date.now() + 100).toISOString() });
            },
            async waitForEnd(_ms, signal) {
              const end = Date.now() + 3000;
              while (!signal.aborted && Date.now() < end) await sleep(5);
              if (!signal.aborted) throw new Error("Objective budget never stopped the worker");
              throw new RuntimeFailure("interrupted", "Stopped");
            },
            async confirmEnd() { throw new Error("A stopped worker must not be accepted"); },
            async usage() {
              if (limit !== "cost") throw new Error("Provider cannot report usage");
              return { cost: 1, tokens: 10 };
            },
            async deliver() { return "accepted"; },
            async shutdown(abort) {
              stopped = abort;
              childExit = { started: true, code: null, signal: "SIGTERM" };
              resolveExit(childExit);
            },
            async closed() {},
          };
          return session;
        },
      }, { keepAwake: false, requestMs: 100, runMs: 3000, statsMs: 10, requestPollMs: 10 });
      const report = await supervisor.execute(input, undefined, { onActivity: entry => { if (entry.kind === "note") notes.push(entry.text); } });
      assert.equal(stopped, true);
      assert.equal(report.status, "interrupted");
      assert.equal(report.reason, "over_budget");
      const reason = limit === "cost" ? "objective_cost_limit" : limit === "worker time" ? "objective_worker_time_limit" : "objective_deadline";
      assert.match(report.detail!, new RegExp(reason));
      assert.ok(notes.some(note => note.includes(reason)));
      const spending = objectiveBudget(f.tasks.database, "goal").spending;
      if (limit === "cost") assert.equal(spending.cost, 2, "the worker's own cost was below the objective limit; the total stopped it");
      else assert.equal(spending.cost, null, "failed usage snapshots never become zero");
    } finally { f.tasks.close(); }
  });
}
