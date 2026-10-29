import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AttemptStore } from "../../src/attempts/store.ts";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { finish } from "../../src/dispatch/finish.ts";
import { status } from "../../src/dispatch/status.ts";
import { personInterventions } from "../../src/objectives/interventions.ts";
import { ObjectiveStore } from "../../src/objectives/store.ts";
import { QuestionStore } from "../../src/runtime/questions-store.ts";
import { submitRequest } from "../../src/runtime/requests.ts";
import { briefing } from "../../src/supervise/briefing.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";
import { fixture } from "../dispatch/fixture.ts";
import { specificationFor } from "../helpers.ts";

const supervisor = { kind: "supervisor", objectiveId: "goal" } as const;

async function setup() {
  const f = await fixture({ scenario: "commit-result" });
  const objectives = new ObjectiveStore(f.tasks.database, f.deps.caller);
  await objectives.add({ id: "goal", request: "Useful output", acceptanceCriteria: ["Working output"] });
  const tasks = await SqliteTaskStore.open({ caller: supervisor, path: f.tasks.database.path });
  const supervisorAttempts = new AttemptStore(f.tasks.database, f.deps.contextId, supervisor);
  const supervisorDeps = { ...f.deps, caller: supervisor, tasks, attempts: supervisorAttempts };
  return { ...f, objectives, supervisorTasks: tasks, supervisorAttempts, supervisorDeps, close: () => { tasks.close(); f.tasks.close(); } };
}

test("person changes, dispatch, explicit acceptance, finish and answers are counted from original records, with lease return separate and no loss on archive", async () => {
  const f = await setup();
  try {
    assert.equal(f.objectives.show("goal").personInterventions.count, 0);
    await f.objectives.update("goal", { scope: "Only this fixture" });
    await f.tasks.add({ id: "work", title: "Work", objectiveId: "goal", repo: "fixture" });
    await f.tasks.update("work", { body: "New instructions" });
    await f.tasks.hold("work", "Wait for the person");
    await f.tasks.release("work");
    assert.equal(personInterventions(f.tasks.database, "goal").count, 5);
    const dispatched = await dispatchOnce(f.deps, { taskId: "work", requestId: "person-dispatch" });
    assert.equal(dispatched.reason, "held");
    assert.equal(personInterventions(f.tasks.database, "goal").count, 6, "Automatic dispatch stages and its task outcome are not new interventions");
    await dispatchOnce(f.deps, { taskId: "work", requestId: "person-dispatch" });
    assert.equal(personInterventions(f.tasks.database, "goal").count, 6, "Replaying the same request is not a new intervention");
    const finished = await finish(f.deps, { leaseId: dispatched.attempt!.leaseId!, noProcesses: false, acceptOutput: true });
    assert.equal(finished.reason, "finished", JSON.stringify(finished));
    const afterFinish = personInterventions(f.tasks.database, "goal");
    assert.equal(afterFinish.count, 8, "Explicit acceptance is one confirmation and finish is one task decision, not their mirrored entries and automatic effects");
    assert.equal(afterFinish.items.filter(item => item.action === "output_accepted").length, 1);
    assert.equal(afterFinish.items.filter(item => item.action === "finish").length, 1);
    assert.equal(afterFinish.leaseReturns.count, 0);
    const runtime = (await f.runtime.discover(f.deps.contextId))[0]!;
    const questions = new QuestionStore(f.tasks.database);
    await questions.record(runtime.directory, "late.question.json", { document: { text: "Which design?", waiting: false } });
    const question = (await questions.list({ contextId: f.deps.contextId, taskId: "work" })).questions[0]!;
    await questions.answer(f.deps.contextId, "work", question.id, "The smaller design", f.deps.caller);
    const returned = await finish(f.deps, { leaseId: dispatched.attempt!.leaseId!, noProcesses: true });
    assert.equal(returned.reason, "finished", JSON.stringify(returned));
    const beforeArchive = personInterventions(f.tasks.database, "goal");
    assert.equal(beforeArchive.count, 9);
    assert.equal(beforeArchive.leaseReturns.count, 1);
    assert.equal(beforeArchive.leaseReturns.items[0]!.action, "no_processes");
    assert.equal(beforeArchive.items.filter(item => item.action === "answer")[0]!.id, `answer:${question.id}`);
    assert.ok(beforeArchive.items.every(item => item.actor === "operator:test"));
    const value = await briefing(f.supervisorDeps, "goal");
    assert.deepEqual(value.personInterventions, f.objectives.show("goal").personInterventions);
    assert.deepEqual(value.personInterventions, beforeArchive);
    const current = (await status(f.deps)).attempts[0]!;
    const source = f.deps.attempts.findForTask("work", 1)!;
    await f.deps.attempts.archiveAttempt(source, { ...current.attempt, state: current.state }, []);
    assert.deepEqual(personInterventions(f.tasks.database, "goal"), beforeArchive, "Archiving moves the original evidence rather than resetting the count");
    assert.deepEqual(f.objectives.show("goal").personInterventions, beforeArchive);
    assert.deepEqual((await briefing(f.supervisorDeps, "goal")).personInterventions, beforeArchive);
  } finally { f.close(); }
});

test("stop, steer, answers and confirmations use the requesting person, not the dispatcher, and never count both message copies", async () => {
  const f = await setup();
  try {
    await f.supervisorTasks.add({ id: "work", title: "Work", objectiveId: "goal" });
    const { ref } = await f.supervisorAttempts.reserveAttempt({ taskId: "work", requested: {}, maximum: 1, specification: specificationFor });
    const workspace = join(f.dir, "workspace");
    mkdirSync(workspace);
    const leaseId = randomUUID(), sessionId = randomUUID();
    await f.supervisorAttempts.append(ref, "leased", { leaseId, workspace, baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40) });
    await f.supervisorAttempts.startReservedTask(ref);
    await f.supervisorAttempts.append(ref, "launched", { sessionId });
    const runtime = await f.runtime.reserve({ identity: { contextId: f.deps.contextId, taskId: "work", leaseId, sessionId }, workspace,
      instructions: "Work", acceptanceCriteria: [], delivery: { ...f.deps.delivery.default, baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40) } });
    const steer = await submitRequest(runtime, f.deps.caller, { kind: "steer", message: "Try the smaller design", label: "supervisor:spoofed" });
    await f.supervisorAttempts.append(ref, "operator_request", { id: steer.id, kind: steer.kind, sender: steer.sender, label: steer.label!, outcome: "delivered", message: steer.message! });
    await submitRequest(runtime, f.deps.caller, { kind: "stop" });
    assert.equal(personInterventions(f.tasks.database, "goal").count, 2);
    const questions = new QuestionStore(f.tasks.database);
    await questions.record(runtime.directory, "open.question.json", { document: { text: "Which design?", waiting: true } });
    const question = (await questions.list(ref)).questions[0]!;
    const answered = await questions.answer(f.deps.contextId, "work", question.id, "The smaller design", f.deps.caller);
    assert.ok(answered.question.answer!.requestId);
    await f.supervisorAttempts.append(ref, "operator_request", { id: answered.question.answer!.requestId!, kind: "steer", sender: "operator:test", message: "Answer", outcome: "delivered" });
    const answering = personInterventions(f.tasks.database, "goal");
    assert.equal(answering.count, 3, "The answer's delivery is not another steering intervention");
    assert.deepEqual(answering.items.map(item => item.action).sort(), ["answer", "steer", "stop"]);
    assert.ok(answering.items.every(item => item.actor === "operator:test"));
    await f.deps.attempts.appendConfirmed(ref, "operator_resolved", { action: "worker_stopped" }, { fact: "worker_stopped", scope: { leaseId, sessionId } });
    const beforeArchive = personInterventions(f.tasks.database, "goal");
    assert.equal(beforeArchive.count, 4, "The confirmation and its operator_resolved entry are one fact");
    assert.deepEqual((await briefing(f.supervisorDeps, "goal")).personInterventions, beforeArchive);
    await f.deps.attempts.archiveAttempt(f.deps.attempts.read(ref), { state: "finished" }, []);
    assert.deepEqual(personInterventions(f.tasks.database, "goal"), beforeArchive, "Even pending requests survive archiving as their original records");
    assert.equal(f.tasks.database.all("SELECT * FROM control_requests").length, 0);
  } finally { f.close(); }
});

test("historical missing actors are not invented, creation and earlier unlinked work are excluded, and moving tasks retains their history", async () => {
  const f = await setup();
  try {
    await f.tasks.add({ id: "unlinked", title: "Earlier unlinked work" });
    const earlier = await f.deps.attempts.reserveAttempt({ taskId: "unlinked", requested: {}, maximum: 1, specification: specificationFor });
    await f.deps.attempts.append(earlier.ref, "halted", { stage: "acquire", reason: "stopped" });
    await f.tasks.update("unlinked", { objectiveId: "goal" });
    assert.equal(personInterventions(f.tasks.database, "goal").count, 1, "Linking is a change; the earlier unrelated attempt is not");
    await f.objectives.add({ id: "other", request: "Other work", acceptanceCriteria: ["Other output"] });
    await f.tasks.update("unlinked", { objectiveId: "other" });
    assert.equal(personInterventions(f.tasks.database, "goal").count, 2);
    await f.tasks.update("unlinked", { body: "Change after moving" });
    assert.equal(personInterventions(f.tasks.database, "goal").count, 2);
    assert.equal(personInterventions(f.tasks.database, "other").count, 2);
    await f.supervisorTasks.add({ id: "legacy", title: "Legacy", objectiveId: "goal" });
    await f.tasks.database.transaction(() => {
      f.tasks.database.run("INSERT INTO attempt_numbers VALUES(?,?,1)", f.deps.contextId, "legacy");
      f.tasks.database.run("INSERT INTO attempts(context,task,number,reserved_at,closed) VALUES(?,?,1,?,1)", f.deps.contextId, "legacy", new Date().toISOString());
      f.tasks.database.run("INSERT INTO attempt_entries VALUES(?,?,1,0,?)", f.deps.contextId, "legacy", JSON.stringify({
        version: 1, contextId: f.deps.contextId, taskId: "legacy", attempt: 1, sequence: 0, kind: "requested", recordedAt: new Date().toISOString(), data: {},
      }));
    });
    assert.equal(personInterventions(f.tasks.database, "goal").count, 2);
    const tables = f.tasks.database.all("SELECT name FROM sqlite_master WHERE type = 'table'").map(row => row.name);
    assert.ok(!tables.some(name => String(name).includes("intervention")), "Interventions are a view of records, not another audit table");
  } finally { f.close(); }
});
