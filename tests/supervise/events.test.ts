import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AttemptStore } from "../../src/attempts/store.ts";
import { Database } from "../../src/database.ts";
import { ObjectiveStore } from "../../src/objectives/store.ts";
import { RuntimeRecords } from "../../src/runtime/records.ts";
import { RuntimeStore } from "../../src/runtime/store.ts";
import { handleEvent as handleObjectiveEvent, observeBudgetEvents, pendingEvents, waitForEvent as waitForObjectiveEvent } from "../../src/supervise/events.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";
import { specificationFor } from "../helpers.ts";

const person = { kind: "person", id: "operator:creator" } as const;
const supervisor = { kind: "supervisor", objectiveId: "goal" } as const;
const waitForEvent = (database: Database, objectiveId: string, timeoutSeconds?: number) =>
  waitForObjectiveEvent(database, { kind: "supervisor", objectiveId }, objectiveId, timeoutSeconds);
const handleEvent = (database: Database, objectiveId: string, id: string) =>
  handleObjectiveEvent(database, { kind: "supervisor", objectiveId }, objectiveId, id);
const root = resolve(".investigation/supervisor-events");
mkdirSync(root, { recursive: true });

async function fixture() {
  const dir = realpathSync(mkdtempSync(join(root, "case-")));
  const path = join(dir, "switchboard.db");
  const tasks = await SqliteTaskStore.open({ caller: supervisor, path });
  const database = tasks.database;
  const objectives = new ObjectiveStore(database, person);
  await objectives.add({ id: "goal", request: "Do useful work", acceptanceCriteria: ["Useful output"] });
  await objectives.add({ id: "other", request: "Other work", acceptanceCriteria: ["Other output"] });
  const attempts = new AttemptStore(database, "context", supervisor);
  const reserve = async (id: string) => {
    await tasks.add({ id, title: id, objectiveId: "goal" });
    return (await attempts.reserveAttempt({ taskId: id, requested: {}, maximum: 20, specification: specificationFor })).ref;
  };
  const launch = async (id: string) => {
    const ref = await reserve(id);
    const workspace = join(dir, id);
    mkdirSync(workspace);
    const leaseId = randomUUID(), sessionId = randomUUID();
    await attempts.append(ref, "leased", { leaseId, workspace, baseRef: "main", outputBranch: id, startingCommit: "a".repeat(40) });
    await attempts.startReservedTask(ref);
    const runtime = new RuntimeRecords(join(dir, "runtime"), database);
    const reserved = await runtime.reserve({ identity: { contextId: "context", taskId: id, leaseId, sessionId }, workspace,
      instructions: id, acceptanceCriteria: [], delivery: { kind: "code", acceptance: "review_or_integration", requiredEvidence: [], requiredDeliverables: [],
        baseRef: "main", outputBranch: id, startingCommit: "a".repeat(40) } });
    return { ...reserved, ref };
  };
  return { dir, path, tasks, database, objectives, attempts, reserve, launch };
}

for (const outcome of ["completed", "held", "failed", "stopped"]) test(`worker ${outcome} records its event with the worker-finished entry`, async () => {
  const f = await fixture();
  try {
    const ref = await f.reserve("work");
    await f.attempts.append(ref, "worker_finished", { status: outcome, runtimeDirectory: "runtime", outcome });
    const pending = pendingEvents(f.database, "goal");
    assert.equal(pending.count, 1);
    assert.partialDeepStrictEqual(pending.first, { ...ref, objectiveId: "goal", sequence: 1, kind: "worker_finished", details: { status: outcome, outcome } });
    assert.ok(Number.isFinite(Date.parse(pending.first!.at)));
    assert.equal((await waitForEvent(f.database, "goal", 0)).event!.id, pending.first!.id);
    assert.equal((await waitForEvent(f.database, "goal", 0)).event!.id, pending.first!.id);
    assert.equal(pendingEvents(f.database, "goal").count, 1);
  } finally { f.tasks.close(); }
});

test("holds and decision failures are recorded, while successful checks and unrelated tasks produce no events", async () => {
  const f = await fixture();
  try {
    const { ref } = await f.launch("work");
    const failed = await f.reserve("failed");
    const checked = await f.reserve("checked");
    await f.attempts.recordOutcome(ref, { outcome: "hold", reason: "Review needed", category: "review_required" });
    assert.equal(pendingEvents(f.database, "goal").first!.kind, "attempt_held");
    await f.attempts.append(failed, "halted", { stage: "acquire", reason: "outcome_unknown" });
    const check = { name: "tests", commit: "a".repeat(40), status: "passed" as const, exitCode: 0, timedOut: false, durationMs: 0, stdout: "", stderr: "" };
    await f.attempts.append(checked, "check_finished", check);
    assert.equal(pendingEvents(f.database, "goal").count, 2);
    await f.attempts.append(checked, "check_finished", { ...check, status: "failed", exitCode: 1 });
    await f.attempts.append(checked, "owner_read_failed", { owner: "git", classification: "effect_uncertain", operation: "finish", step: "integrate",
      failedAt: new Date().toISOString(), diagnostics: { message: "Read failed" } });
    assert.deepEqual(f.database.all("SELECT kind FROM supervisor_events ORDER BY sequence").map(row => row.kind), ["attempt_held", "decision_needed", "decision_needed", "decision_needed"]);
    const personTasks = await SqliteTaskStore.open({ caller: person, path: f.path });
    try { await personTasks.add({ id: "unlinked", title: "Unrelated" }); await personTasks.hold("unlinked", "Unrelated hold"); }
    finally { personTasks.close(); }
    assert.equal(pendingEvents(f.database, "goal").count, 4);
    assert.equal(pendingEvents(f.database, "other").count, 0);
  } finally { f.tasks.close(); }
});

test("a valid worker question appears once, and invalid files and duplicate polls produce no events", async () => {
  const f = await fixture();
  try {
    const runtime = await f.launch("work");
    const storage = new RuntimeStore(f.database);
    for (let n = 0; n < 2; n++) await storage.questions.record(runtime.directory, "design.question.json", { document: { text: "Which design?", waiting: true } });
    await storage.questions.record(runtime.directory, "invalid.question.json", { diagnostic: "Invalid JSON" });
    const question = (await storage.questions.list(runtime.ref)).questions[0]!;
    assert.partialDeepStrictEqual(pendingEvents(f.database, "goal"), { count: 1, first: { kind: "question_asked", ...runtime.ref, details: { questionId: question.id, text: "Which design?", waiting: true } } });
    await storage.questions.answer("context", "work", question.id, "Smaller", person);
    assert.equal(pendingEvents(f.database, "goal").count, 2, "The person answer is one intervention, not an extra steering event");
    assert.equal(f.database.all("SELECT * FROM supervisor_events WHERE kind = 'person_intervention'").length, 1);
  } finally { f.tasks.close(); }
});

test("budget usage and limit edits record events in their write transactions and checks do not duplicate them", async () => {
  const f = await fixture();
  try {
    const runtime = await f.launch("work");
    const storage = new RuntimeStore(f.database);
    await f.objectives.update("goal", { budget: { maxCost: 2, maxWorkerTimeMs: null } });
    await storage.recordUsage(runtime.directory, { cost: 2, tokens: 100 });
    let events = f.database.all("SELECT * FROM supervisor_events WHERE kind = 'budget_reached'");
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(String(events[0]!.details)), { budget: "cost", limit: 2, spent: 2 });
    await storage.recordUsage(runtime.directory, { cost: 3, tokens: 200 });
    await storage.objectiveBudgetRefusal(runtime.directory);
    await waitForEvent(f.database, "goal", 0);
    assert.equal(f.database.all("SELECT * FROM supervisor_events WHERE kind = 'budget_reached'").length, 1);
    await f.objectives.update("goal", { budget: { maxCost: 4, maxWorkerTimeMs: 0 } });
    events = f.database.all("SELECT * FROM supervisor_events WHERE kind = 'budget_reached'");
    assert.equal(events.length, 2);
    assert.equal(JSON.parse(String(events[1]!.details)).budget, "worker_time");
  } finally { f.tasks.close(); }
});

test("the first wait or dispatcher check observing a passed deadline records one persistent event", async () => {
  for (const observer of ["wait", "dispatcher"]) {
    const f = await fixture();
    try {
      const runtime = await f.launch("work");
      const deadline = new Date(Date.now() + 60000).toISOString();
      await f.objectives.update("goal", { deadline });
      // Keep the deadline update in the past without observing it during that update.
      await f.database.transaction(() => f.database.run("UPDATE objectives SET deadline = ? WHERE id = 'goal'", new Date(Date.now() - 1000).toISOString()));
      assert.equal(f.database.all("SELECT * FROM supervisor_events WHERE kind = 'deadline_reached'").length, 0);
      if (observer === "wait") await waitForEvent(f.database, "goal", 0);
      else await new RuntimeStore(f.database).objectiveBudgetRefusal(runtime.directory);
      const first = f.database.get("SELECT * FROM supervisor_events WHERE kind = 'deadline_reached'")!;
      await waitForEvent(f.database, "goal", 0);
      await waitForEvent(f.database, "goal", 0);
      await new RuntimeStore(f.database).objectiveBudgetRefusal(runtime.directory);
      assert.deepEqual(f.database.all("SELECT * FROM supervisor_events WHERE kind = 'deadline_reached'"), [first]);
    } finally { f.tasks.close(); }
  }
});

test("wait polls for new events, times out without moving the position, and reoffers events after reopening", async () => {
  const f = await fixture();
  const second = await Database.open(f.path);
  try {
    const ref = await f.reserve("work");
    const started = Date.now();
    const timedOut = await waitForEvent(second, "goal", 0.05);
    assert.deepEqual(timedOut, { ok: true, action: "wait", event: null, timedOut: true });
    assert.ok(Date.now() - started >= 45);
    const waiting = waitForEvent(second, "goal", 2);
    await sleep(50);
    await f.attempts.append(ref, "worker_finished", { status: "completed", runtimeDirectory: "runtime" });
    const received = await waiting;
    assert.equal(received.timedOut, false);
    assert.equal(received.event!.kind, "worker_finished");
    assert.deepEqual(f.database.all("SELECT * FROM supervisor_positions"), []);
    second.close();
    const reopened = await Database.open(f.path);
    try { assert.deepEqual(await waitForEvent(reopened, "goal", 0), received); }
    finally { reopened.close(); }
  } finally { second.close(); f.tasks.close(); }
});

test("handled advances only to the next event, refuses unknown and foreign events, and is safe to repeat", async () => {
  const f = await fixture();
  try {
    const { ref } = await f.launch("work");
    await f.attempts.append(ref, "worker_finished", { status: "failed", runtimeDirectory: "runtime" });
    await f.attempts.recordOutcome(ref, { outcome: "hold", reason: "Failure", category: "failed" });
    await f.objectives.update("other", { scope: "Another decision" });
    const first = pendingEvents(f.database, "goal").first!;
    const later = String(f.database.get("SELECT id FROM supervisor_events WHERE objective = 'goal' AND sequence = 2")!.id);
    const foreign = pendingEvents(f.database, "other").first!;
    await assert.rejects(handleEvent(f.database, "goal", "missing"), /Unknown event/);
    await assert.rejects(handleEvent(f.database, "goal", foreign.id), /Unknown event/);
    await assert.rejects(handleEvent(f.database, "goal", later), /next unhandled/);
    assert.equal(pendingEvents(f.database, "goal").count, 2);
    assert.deepEqual(await handleEvent(f.database, "goal", first.id), first);
    const position = f.database.get("SELECT * FROM supervisor_positions WHERE objective = 'goal'")!;
    assert.equal(position.handled_by, "supervisor:goal");
    assert.ok(Number.isFinite(Date.parse(String(position.handled_at))));
    assert.deepEqual(await handleEvent(f.database, "goal", first.id), first);
    assert.deepEqual(f.database.get("SELECT * FROM supervisor_positions WHERE objective = 'goal'"), position, "A repeated acknowledgement is a no-op");
    assert.equal(pendingEvents(f.database, "goal").first!.id, later);
    await handleEvent(f.database, "goal", later);
    await handleEvent(f.database, "goal", first.id);
    assert.deepEqual(pendingEvents(f.database, "goal"), { count: 0, first: null });
    assert.equal((await waitForEvent(f.database, "goal", 0)).timedOut, true);
  } finally { f.tasks.close(); }
});

test("event IDs, sequences and the handled position survive pruning, and event facts cannot be changed", async () => {
  const f = await fixture();
  try {
    const { ref } = await f.launch("work");
    await f.attempts.append(ref, "worker_finished", { status: "held", runtimeDirectory: "runtime" });
    await f.attempts.recordOutcome(ref, { outcome: "hold", reason: "Held", category: "held_by_worker" });
    const first = pendingEvents(f.database, "goal").first!;
    await handleEvent(f.database, "goal", first.id);
    const before = f.database.all("SELECT * FROM supervisor_events ORDER BY sequence");
    for (const sql of ["UPDATE supervisor_events SET kind = 'changed'", "UPDATE supervisor_events SET sequence = 100", "DELETE FROM supervisor_events",
      "INSERT OR REPLACE INTO supervisor_events SELECT * FROM supervisor_events WHERE sequence = 1"]) {
      await assert.rejects(f.database.transaction(() => f.database.run(sql)), /Supervisor events cannot be/);
    }
    await f.attempts.archiveAttempt(f.attempts.read(ref), { state: "held" }, []);
    assert.deepEqual(f.database.all("SELECT * FROM supervisor_events ORDER BY sequence"), before);
    assert.equal((await waitForEvent(f.database, "goal", 0)).event!.sequence, 2);
    assert.equal(pendingEvents(f.database, "goal").count, 1);
    await assert.rejects(f.database.transaction(() => f.database.run("UPDATE supervisor_positions SET sequence = 0")), /cannot move backwards/);
    const deletion = { ...ref, directory: join(f.dir, "cleanup") };
    await f.attempts.appendCleanup(deletion, "owner_read_failed", { classification: "effect_uncertain", diagnostics: { message: "Deletion needs reconciliation" } });
    const failure = f.database.get("SELECT * FROM supervisor_events WHERE sequence = 3")!;
    assert.equal(failure.kind, "decision_needed");
    assert.equal(failure.task, "work");
    assert.equal(JSON.parse(String(failure.details)).directory, deletion.directory);
  } finally { f.tasks.close(); }
});

test("event operations enforce the bound supervisor and current objective state inside the operation", async () => {
  const f = await fixture();
  try {
    const ref = await f.reserve("work");
    await f.attempts.append(ref, "worker_finished", { status: "completed", runtimeDirectory: "runtime" });
    const first = pendingEvents(f.database, "goal").first!;
    for (const caller of [person, { kind: "supervisor", objectiveId: "other" } as const]) {
      await assert.rejects(waitForObjectiveEvent(f.database, caller, "goal", 0), /Only the objective's supervisor/);
      await assert.rejects(handleObjectiveEvent(f.database, caller, "goal", first.id), /Only the objective's supervisor/);
    }
    await f.objectives.abandon("goal");
    await assert.rejects(waitForEvent(f.database, "goal", 0), /must be open/);
    await assert.rejects(handleEvent(f.database, "goal", first.id), /must be open/);
    assert.deepEqual(f.database.all("SELECT * FROM supervisor_positions"), []);
  } finally { f.tasks.close(); }
});

test("failed event writes roll back their source facts and sequence allocation", async () => {
  const f = await fixture();
  try {
    const runtime = await f.launch("work");
    await f.objectives.update("goal", { budget: { maxCost: 2, maxWorkerTimeMs: null } });
    const before = pendingEvents(f.database, "goal");
    await f.database.transaction(() => f.database.run("CREATE TRIGGER reject_events BEFORE INSERT ON supervisor_events BEGIN SELECT RAISE(ABORT, 'Event write failed'); END"));
    await assert.rejects(f.attempts.append(runtime.ref, "worker_finished", { status: "failed", runtimeDirectory: runtime.directory }), /Event write failed/);
    const storage = new RuntimeStore(f.database);
    await assert.rejects(storage.questions.record(runtime.directory, "question.question.json", { document: { text: "Which?", waiting: true } }), /Event write failed/);
    await assert.rejects(storage.recordUsage(runtime.directory, { cost: 3, tokens: 100 }), /Event write failed/);
    await assert.rejects(f.objectives.update("goal", { scope: "Must roll back" }), /Event write failed/);
    const personTasks = await SqliteTaskStore.open({ caller: person, path: f.path });
    try { await assert.rejects(personTasks.hold("work", "Must roll back"), /Event write failed/); }
    finally { personTasks.close(); }
    assert.equal((await f.tasks.read("work"))!.held, false);
    assert.equal(f.database.get("SELECT * FROM task_changes WHERE action = 'hold'"), undefined);
    assert.equal(f.attempts.read(runtime.ref).entries.some(entry => entry.kind === "worker_finished"), false);
    assert.equal((await storage.questions.list(runtime.ref)).questions.length, 0);
    assert.equal(f.database.get("SELECT * FROM worker_usage"), undefined);
    assert.equal(f.objectives.read("goal")!.scope, "");
    assert.deepEqual(pendingEvents(f.database, "goal"), before);
    await f.database.transaction(() => f.database.run("DROP TRIGGER reject_events"));
    await f.attempts.append(runtime.ref, "worker_finished", { status: "completed", runtimeDirectory: runtime.directory });
    assert.deepEqual(f.database.all("SELECT sequence FROM supervisor_events WHERE objective = 'goal' ORDER BY sequence").map(row => row.sequence), [1, 2]);
  } finally { f.tasks.close(); }
});

function contents(database: Database) {
  return Object.fromEntries(database.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map(row => [String(row.name), database.all(`SELECT * FROM ${row.name}`)]));
}

test("schema 14 migrates concurrently to 15 without changing existing data or backfilling events", async () => {
  const f = await fixture();
  await f.reserve("work");
  await f.objectives.update("goal", { scope: "Keep this scope" });
  await f.database.transaction(() => {
    f.database.run("DROP TABLE supervisor_positions");
    f.database.run("DROP TABLE supervisor_events");
    f.database.run("PRAGMA user_version = 14");
  });
  const before = contents(f.database);
  f.tasks.close();
  const databases = await Promise.all([Database.open(f.path), Database.open(f.path)]);
  try {
    for (const database of databases) {
      assert.equal(database.get("PRAGMA user_version")!.user_version, 15);
      const { supervisor_events, supervisor_positions, ...after } = contents(database);
      assert.deepEqual(after, before);
      assert.deepEqual(supervisor_events, []);
      assert.deepEqual(supervisor_positions, []);
      assert.deepEqual(database.all("PRAGMA foreign_key_check"), []);
    }
    await databases[0]!.transaction(() => observeBudgetEvents(databases[0]!, "goal"));
    assert.deepEqual(pendingEvents(databases[1]!, "goal"), { count: 0, first: null });
  } finally { for (const database of databases) database.close(); }
});
