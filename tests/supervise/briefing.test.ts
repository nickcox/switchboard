import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { AttemptStore } from "../../src/attempts/store.ts";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { createReview } from "../../src/dispatch/review.ts";
import { status } from "../../src/dispatch/status.ts";
import { ObjectiveStore, defaultPermissions } from "../../src/objectives/store.ts";
import { PiWorker } from "../../src/runtime/pi/worker.ts";
import { QuestionStore } from "../../src/runtime/questions-store.ts";
import { briefing } from "../../src/supervise/briefing.ts";
import { appendNote } from "../../src/supervise/notes.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";
import { fixture } from "../dispatch/fixture.ts";
import { specificationFor } from "../helpers.ts";

const supervisor = { kind: "supervisor", objectiveId: "goal" } as const;
const reviewContract = { kind: "artefact" as const, acceptance: "independent_deliverable" as const, requiredEvidence: [], requiredDeliverables: ["report"] };

async function setup() {
  const f = await fixture({ scenario: "commit-result", byTaskKind: { review: reviewContract } });
  const objectives = new ObjectiveStore(f.tasks.database, f.deps.caller);
  await objectives.add({ id: "goal", request: "Preserve the person's exact request\n", acceptanceCriteria: ["Useful output", "Safe output"],
    scope: "Only the fixture", constraints: "Do not publish", budget: { maxCost: 100, maxWorkerTimeMs: 1000000 }, deadline: "2099-01-01T00:00:00Z" });
  await objectives.add({ id: "other", request: "Other objective", acceptanceCriteria: ["Other output"] });
  const tasks = await SqliteTaskStore.open({ caller: supervisor, path: f.tasks.database.path, repo: "fixture" });
  const deps = { ...f.deps, caller: supervisor, tasks, attempts: new AttemptStore(f.tasks.database, f.deps.contextId, supervisor) };
  return { ...f, objectives, supervisorTasks: tasks, deps, close: () => { tasks.close(); f.tasks.close(); } };
}

function contents(f: Awaited<ReturnType<typeof setup>>) {
  const database = f.tasks.database;
  return database.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(row => [row.name, database.all(`SELECT * FROM ${row.name}`)]);
}

test("briefing summarises current records, agrees with status in several states, and makes running workers and retained leases plain", async () => {
  const f = await setup();
  try {
    await f.supervisorTasks.add({ id: "work", title: "Useful work", body: "Implement the fixture", objectiveId: "goal", repo: "fixture", acceptanceCriteria: ["Keep the output"] });
    const dispatched = await dispatchOnce(f.deps, { taskId: "work", requestId: "work-1" });
    assert.equal(dispatched.reason, "held", JSON.stringify(dispatched));
    const source = f.deps.attempts.findForTask("work", 1)!;
    const commit = dispatched.attempt!.resultCommit!;
    const check = { name: "tests", commit, status: "passed" as const, exitCode: 0, timedOut: false, durationMs: 1, stdout: "Passed", stderr: "" };
    await f.deps.attempts.append(source, "check_finished", { ...check, status: "failed", exitCode: 1 });
    await f.deps.attempts.append(source, "check_finished", check);
    const review = await createReview(f.deps, { taskId: "work" });
    assert.equal(review.ok, true, JSON.stringify(review));
    const worker = new PiWorker(f.runtime, { executable: process.execPath, entrypoint: resolve("tests/fixtures/pi-rpc.ts"), provider: "fixture", model: "fixture", shellTool: "bash",
      requestMs: 2000, runMs: 5000, stopMs: 600, environment: { ...f.environment, FAKE_PI_SCENARIO: "review-pass", FAKE_PI_LOG: join(f.dir, "review-requests.jsonl") } });
    const reviewed = await dispatchOnce({ ...f.deps, launch: (input, signal, onRequest) => worker.execute(input, signal, onRequest ? { onRequest } : {}) }, { taskId: review.task!.id });
    assert.equal(reviewed.reason, "held", JSON.stringify(reviewed));
    await f.supervisorTasks.add({ id: "pending", title: "Pending", objectiveId: "goal", repo: "other-repo", acceptanceCriteria: ["Wait for work"] });
    await f.deps.attempts.reserveAttempt({ taskId: "pending", requested: {}, maximum: 10, specification: specificationFor });
    await f.supervisorTasks.block("pending", "work");
    await f.supervisorTasks.add({ id: "stopped", title: "Stopped", objectiveId: "goal" });
    const stopped = await f.deps.attempts.reserveAttempt({ taskId: "stopped", requested: {}, maximum: 10, specification: specificationFor });
    await f.deps.attempts.append(stopped.ref, "halted", { stage: "acquire", reason: "stopped" });
    await f.supervisorTasks.add({ id: "running", title: "Running", objectiveId: "goal" });
    const running = await f.deps.attempts.reserveAttempt({ taskId: "running", requested: {}, maximum: 10, specification: specificationFor });
    const workspace = join(f.dir, "running-workspace");
    mkdirSync(workspace);
    const leaseId = randomUUID(), sessionId = randomUUID();
    await f.deps.attempts.append(running.ref, "leased", { leaseId, workspace, baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40) });
    await f.deps.attempts.startReservedTask(running.ref);
    await f.deps.attempts.append(running.ref, "launched", { sessionId });
    const runtime = await f.runtime.reserve({ identity: { contextId: f.deps.contextId, taskId: "running", leaseId, sessionId }, workspace,
      instructions: "Running", acceptanceCriteria: [], delivery: { ...f.deps.delivery.default, baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40) } });
    const questions = new QuestionStore(f.tasks.database);
    await questions.record(runtime.directory, "open.question.json", { document: { text: "Which design?", waiting: true, choices: ["Small", "Large"] } });
    const exited = (await f.runtime.discover(f.deps.contextId)).find(record => record.binding.input.identity.taskId === "work")!;
    await questions.record(exited.directory, "late.question.json", { document: { text: "A question left open after exit", waiting: false } });
    await questions.record(exited.directory, "answered.question.json", { document: { text: "Already answered", waiting: false } });
    const answered = (await questions.list(source)).questions.find(question => question.filename === "answered.question.json")!;
    await questions.answer(f.deps.contextId, "work", answered.id, "Use the smaller design", supervisor);
    await questions.record(exited.directory, "invalid.question.json", { diagnostic: "Invalid question" });
    await appendNote(f.tasks.database, supervisor, "goal", "First decision");
    await appendNote(f.tasks.database, supervisor, "goal", "Second decision");
    await f.tasks.add({ id: "foreign", title: "Other work", objectiveId: "other" });
    await appendNote(f.tasks.database, { kind: "supervisor", objectiveId: "other" }, "other", "Do not include this note");
    const before = contents(f);
    const current = await status(f.deps, { activity: false, transcript: false });
    const value = await briefing(f.deps, "goal");
    assert.deepEqual(contents(f), before, "A briefing does not change any record");
    assert.equal(value.objective.request, "Preserve the person's exact request\n");
    assert.equal(value.objective.scope, "Only the fixture");
    assert.equal(value.objective.constraints, "Do not publish");
    assert.deepEqual(value.objective.budget, { maxCost: 100, maxWorkerTimeMs: 1000000 });
    assert.equal(value.objective.deadline, "2099-01-01T00:00:00Z");
    assert.equal(value.objective.permissions.dispatch, true);
    assert.deepEqual(value.objective.criteria.map(criterion => criterion.status), ["pending", "pending"]);
    assert.equal(value.objective.spending.observedCost, f.objectives.show("goal").spending.observedCost);
    const attempts = value.tasks.flatMap(task => task.attempts);
    assert.ok(new Set(attempts.map(attempt => attempt.status)).size >= 4);
    for (const attempt of attempts) {
      const same = current.attempts.find(candidate => candidate.attempt.taskId === attempt.taskId && candidate.attempt.attempt === attempt.attempt)!;
      assert.equal(attempt.status, same.state);
      assert.deepEqual(attempt.assessment, same);
    }
    const work = value.tasks.find(task => task.id === "work")!;
    assert.deepEqual(work.acceptanceCriteria, ["Keep the output"]);
    assert.equal(work.state, "queued");
    assert.deepEqual(work.attempts[0]!.checks, [check]);
    assert.equal(work.attempts[0]!.reviews[0]!.verdict, "passed");
    assert.equal(work.attempts[0]!.outputRetained, true);
    assert.equal(work.attempts[0]!.leaseHeld, true);
    assert.match(work.attempts[0]!.leaseReturn, /Only a person/);
    assert.deepEqual(value.tasks.find(task => task.id === "pending")!.dependencies, ["work"]);
    assert.equal(value.tasks.find(task => task.id === "pending")!.repo, "other-repo");
    assert.deepEqual(value.possiblyRunning.map(attempt => attempt.taskId), ["running"]);
    assert.match(value.possiblyRunning[0]!.warning, /may still be running.*Do not start this task again/);
    assert.deepEqual(value.openQuestions.map(question => question.text).sort(), ["A question left open after exit", "Which design?"]);
    assert.ok(value.openQuestions.every(question => question.id));
    assert.deepEqual(value.notes.map(note => note.text), ["First decision", "Second decision"]);
    assert.equal(value.personInterventions.count, 0, "Creation is not an intervention; every later operation was the supervisor's");
    assert.deepEqual(value.personInterventions, f.objectives.show("goal").personInterventions);
    assert.ok(!JSON.stringify(value).includes("Other work"));
    await f.runtime.recordChildExit(runtime, { started: true, code: 0, signal: null });
  } finally { f.close(); }
});

test("briefing and notes remain available only within the supervisor's objective when all permissions are removed", async () => {
  const f = await setup();
  try {
    await f.supervisorTasks.add({ id: "work", title: "Work", objectiveId: "goal" });
    await f.objectives.update("goal", { permissions: Object.fromEntries(Object.keys(defaultPermissions).map(key => [key, false])) as typeof defaultPermissions });
    const note = await appendNote(f.tasks.database, supervisor, "goal", "Start the next session from these records");
    const before = contents(f);
    const value = await briefing(f.deps, "goal");
    assert.deepEqual(value.notes, [note]);
    assert.deepEqual(value.tasks.map(task => task.id), ["work"]);
    assert.ok(Object.values(value.objective.permissions).every(permission => permission === false));
    assert.equal(Object.hasOwn(value.objective.permissions, "recordAttempt"), false);
    await assert.rejects(briefing(f.deps, "other"), /outside_objective/);
    await assert.rejects(appendNote(f.tasks.database, supervisor, "other", "No"), /Only the objective's supervisor/);
    assert.deepEqual(contents(f), before, "Inspection and refused operations leave the records unchanged");
  } finally { f.close(); }
});

test("briefing includes other contexts and archived records without inventing missing historical evidence", async () => {
  const f = await setup();
  try {
    await f.supervisorTasks.add({ id: "work", title: "Work", objectiveId: "goal" });
    const other = new AttemptStore(f.tasks.database, "other-context", supervisor);
    const { ref } = await other.reserveAttempt({ taskId: "work", requested: {}, maximum: 1, specification: specificationFor });
    await other.append(ref, "halted", { stage: "acquire", reason: "stopped" });
    const first = await briefing(f.deps, "goal");
    assert.equal(first.tasks[0]!.attempts[0]!.contextId, "other-context");
    const assessed = (await status({ ...f.deps, contextId: "other-context", attempts: other })).attempts[0]!;
    assert.equal(first.tasks[0]!.attempts[0]!.status, assessed.state);
    await other.archiveAttempt(other.read(ref), { ...assessed.attempt, state: assessed.state }, []);
    const archived = (await briefing(f.deps, "goal")).tasks[0]!.attempts[0]!;
    assert.equal(archived.archived, true);
    assert.equal(archived.status, assessed.state);
    assert.equal(archived.outputRetained, null);
    assert.deepEqual(archived.checks, []);
    assert.deepEqual(archived.reviews, []);
    assert.equal((await briefing(f.deps, "goal")).personInterventions.count, 0);
  } finally { f.close(); }
});

test("briefing keeps status's unknown state and exposes unavailable owners rather than treating unknown leases as returned", async () => {
  const f = await setup();
  try {
    await f.supervisorTasks.add({ id: "work", title: "Work", objectiveId: "goal" });
    await f.deps.attempts.reserveAttempt({ taskId: "work", requested: {}, maximum: 1, specification: specificationFor });
    const deps = { ...f.deps, workspaces: Object.assign(Object.create(f.deps.workspaces), { leases: async () => { throw new Error("Inventory unavailable"); } }) };
    const value = await briefing(deps, "goal");
    const attempt = value.tasks[0]!.attempts[0]!;
    assert.equal(attempt.status, (await status(deps)).attempts[0]!.state);
    assert.equal(attempt.status, "unknown");
    assert.equal(attempt.leaseHeld, null);
    assert.match(attempt.leaseReturn, /unknown/);
    assert.match(value.diagnostics[0]!.detail, /Inventory unavailable/);
    assert.equal(value.personInterventions.count, 0);
    await assert.rejects(briefing(f.deps, "other"), /outside_objective/);
  } finally { f.close(); }
});
