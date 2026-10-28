import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ObjectiveStore, defaultPermissions, type CompletionStatement, AttemptStore, SqliteTaskStore } from "../caller.ts";
import { specificationFor } from "../helpers.ts";

async function fixture() {
  const root = resolve(".investigation/objectives-unit");
  await mkdir(root, { recursive: true });
  const dir = await realpath(await mkdtemp(join(root, "case-")));
  const tasks = await SqliteTaskStore.open({ path: join(dir, "switchboard.db"), repo: "fixture" });
  const objectives = new ObjectiveStore(tasks.database, "operator:creator");
  const attempts = new AttemptStore(tasks.database, "fixture");
  return { tasks, objectives, attempts, path: tasks.database.path };
}
const add = (store: ObjectiveStore, id = "goal") => store.add({ id, request: "Please keep my exact words.\nIncluding this line.", acceptanceCriteria: ["First criterion", "Second criterion"] });

async function acceptedTask(f: Awaited<ReturnType<typeof fixture>>, taskId = "work") {
  await f.tasks.add({ id: taskId, title: "Work", objectiveId: "goal" });
  const { ref } = await f.attempts.reserveAttempt({ taskId, requested: {}, maximum: 10, specification: specificationFor });
  const commit = "a".repeat(40);
  await f.attempts.appendConfirmed(ref, "output_accepted", { commit }, { fact: "output_accepted", scope: { commit } });
  return { ref, commit };
}

test("objectives preserve the request, ordered criteria, defaults, creator and timestamps across opens", async () => {
  const f = await fixture();
  const objective = await add(f.objectives);
  assert.equal(objective.state, "open");
  assert.equal(objective.request, "Please keep my exact words.\nIncluding this line.");
  assert.deepEqual(objective.acceptanceCriteria, ["First criterion", "Second criterion"]);
  assert.deepEqual(objective.permissions, defaultPermissions);
  assert.deepEqual(objective.budget, { maxCost: null, maxWorkerTimeMs: null });
  assert.equal(objective.deadline, null);
  assert.equal(objective.createdBy, "operator:creator");
  assert.equal(objective.createdAt, objective.updatedAt);
  assert.equal(objective.closedAt, null);
  assert.equal(f.objectives.history("goal")[0]!.changedBy, "operator:creator");
  f.tasks.close();
  const reopened = await SqliteTaskStore.open({ path: f.path });
  try { assert.deepEqual(new ObjectiveStore(reopened.database, "operator:reader").read("goal"), objective); }
  finally { reopened.close(); }
});

test("creator updates record who changed each field and when, and budgets bind person dispatches", async () => {
  const f = await fixture();
  try {
    const original = await add(f.objectives);
    const editor = new ObjectiveStore(f.tasks.database, "operator:creator");
    const permissions = { ...defaultPermissions, dispatch: false, manageTasks: false };
    const changed = await editor.update("goal", { acceptanceCriteria: ["Replacement"], scope: "Only this project", constraints: "No publishing",
      permissions, budget: { maxCost: 0, maxWorkerTimeMs: 0 }, deadline: "2000-01-01T00:00:00Z" });
    assert.deepEqual(changed.acceptanceCriteria, ["Replacement"]);
    assert.equal(changed.createdBy, original.createdBy);
    assert.equal(changed.createdAt, original.createdAt);
    assert.deepEqual(changed.permissions, permissions);
    const history = editor.history("goal");
    assert.equal(history.length, 2);
    assert.equal(history[1]!.changedBy, "operator:creator");
    assert.equal(history[1]!.changedAt, changed.updatedAt);
    assert.deepEqual(history[1]!.changes.scope, { before: "", after: "Only this project" });
    assert.deepEqual(history[1]!.changes.budget.after, { maxCost: 0, maxWorkerTimeMs: 0 });
    await editor.update("goal", { scope: changed.scope });
    assert.equal(editor.history("goal").length, 2, "No-op updates do not add history");
    await f.tasks.add({ id: "work", title: "Allowed for now", objectiveId: "goal" });
    await assert.rejects(f.attempts.reserveAttempt({ taskId: "work", requested: {}, maximum: 1, specification: specificationFor }), { reason: "objective_deadline" });
    await editor.update("goal", { deadline: null, budget: { maxCost: null, maxWorkerTimeMs: null } });
    assert.equal(editor.read("goal")!.deadline, null);
  } finally { f.tasks.close(); }
});

test("invalid objective data and updates refuse atomically", async () => {
  const f = await fixture();
  try {
    for (const input of [{ id: "bad id" }, { request: " " }, { acceptanceCriteria: [] }, { acceptanceCriteria: ["two\nlines"] },
      { budget: { maxCost: -1, maxWorkerTimeMs: 1 } }, { deadline: "tomorrow" }, { permissions: { dispatch: true } }]) {
      await assert.rejects(f.objectives.add({ id: "goal", request: "Request", acceptanceCriteria: ["Criterion"], ...input } as Parameters<ObjectiveStore["add"]>[0]), { reason: "rejected" });
      assert.deepEqual(f.objectives.list(), []);
    }
    const before = await add(f.objectives);
    await assert.rejects(add(f.objectives), { reason: "rejected" });
    await assert.rejects(f.objectives.update("goal", { scope: "Not applied", budget: { maxCost: -1, maxWorkerTimeMs: null } }), { reason: "rejected" });
    assert.deepEqual(f.objectives.read("goal"), before);
    assert.equal(f.objectives.history("goal").length, 1);
    await assert.rejects(f.objectives.update("missing", { scope: "No" }), { reason: "rejected" });
    assert.throws(() => f.objectives.show("missing"), { reason: "rejected" });
    await assert.rejects(f.tasks.database.transaction(() => f.tasks.database.run("UPDATE objective_changes SET changed_by = 'other'")), /cannot be changed/);
    await assert.rejects(f.tasks.database.transaction(() => f.tasks.database.run("DELETE FROM objective_changes")), /cannot be removed/);
  } finally { f.tasks.close(); }
});

test("linking, moving and clearing one objective changes the task definition revision exactly once", async () => {
  const f = await fixture();
  try {
    await add(f.objectives);
    await add(f.objectives, "other");
    assert.equal((await f.tasks.add({ id: "unlinked", title: "A" })).objectiveId, null);
    const linked = await f.tasks.update("unlinked", { objectiveId: "goal", title: "B", acceptanceCriteria: ["Task criterion"] });
    assert.equal(linked.definitionRevision, 2);
    assert.equal(linked.objectiveId, "goal");
    assert.equal((await f.tasks.update("unlinked", { objectiveId: "goal" })).definitionRevision, 2);
    assert.equal((await f.tasks.update("unlinked", { objectiveId: "other" })).definitionRevision, 3);
    const cleared = await f.tasks.update("unlinked", { objectiveId: null });
    assert.equal(cleared.definitionRevision, 4);
    assert.equal(cleared.objectiveId, null);
    assert.equal((await f.tasks.add({ id: "linked", title: "Linked", objectiveId: "goal" })).definitionRevision, 1);
    const before = await f.tasks.read("linked");
    await assert.rejects(f.tasks.update("linked", { objectiveId: "missing", title: "Wrong" }), { reason: "rejected" });
    await assert.rejects(f.tasks.add({ id: "missing-goal", title: "Wrong", objectiveId: "missing" }), { reason: "rejected" });
    assert.deepEqual(await f.tasks.read("linked"), before);
    const { ref } = await f.attempts.reserveAttempt({ taskId: "linked", requested: {}, maximum: 1, specification: specificationFor });
    assert.equal(f.attempts.read(ref).specification!.objectiveId, "goal");
    await f.tasks.update("linked", { objectiveId: null });
    assert.equal(f.attempts.read(ref).specification!.objectiveId, "goal");
    await assert.rejects(f.attempts.startReservedTask(ref), { reason: "task_definition_changed" });
  } finally { f.tasks.close(); }
});

test("abandoning is separate, terminal objectives refuse changes and membership edits until explicitly reopened", async () => {
  const f = await fixture();
  try {
    await add(f.objectives);
    await f.tasks.add({ id: "linked", title: "Linked", objectiveId: "goal" });
    await f.tasks.add({ id: "unlinked", title: "Unlinked" });
    const abandoned = await f.objectives.abandon("goal");
    assert.equal(abandoned.state, "abandoned");
    assert.equal(abandoned.closedAt, abandoned.updatedAt);
    assert.deepEqual(f.objectives.list("open"), []);
    assert.equal(f.objectives.list("abandoned").length, 1);
    await assert.rejects(f.objectives.update("goal", { scope: "No" }), { reason: "rejected" });
    await assert.rejects(f.objectives.abandon("goal"), { reason: "rejected" });
    await assert.rejects(f.tasks.update("linked", { objectiveId: null }), { reason: "rejected" });
    await assert.rejects(f.tasks.update("unlinked", { objectiveId: "goal" }), { reason: "rejected" });
    await assert.rejects(f.tasks.add({ id: "new", title: "New", objectiveId: "goal" }), { reason: "rejected" });
    assert.equal(f.objectives.history("goal").length, 2);
    const reopened = await f.objectives.reopen("goal");
    assert.equal(reopened.state, "open");
    assert.equal(reopened.closedAt, null);
    await f.tasks.update("linked", { objectiveId: null });
    await f.objectives.update("goal", { scope: "Allowed now" });
    assert.deepEqual(f.objectives.history("goal").map(h => h.action), ["add", "abandon", "reopen", "update"]);
    await assert.rejects(f.objectives.reopen("goal"), { reason: "rejected" });
  } finally { f.tasks.close(); }
});

test("done tasks do not complete an objective; every criterion needs a statement and a real linked reference", async () => {
  const f = await fixture();
  try {
    await add(f.objectives);
    const { ref, commit } = await acceptedTask(f);
    await f.tasks.done("work");
    assert.equal(f.objectives.read("goal")!.state, "open");
    const reference = { kind: "accepted_commit" as const, ...ref, commit };
    const valid: CompletionStatement[] = [1, 2].map(position => ({ position, statement: `How criterion ${position} was met`, references: [reference] }));
    const invalid = [[], [{ position: 1, statement: "No reference", references: [] }], valid.slice(0, 1), [valid[0]!, valid[0]!],
      [valid[0]!, { ...valid[1]!, position: 3 }], valid.map(s => ({ ...s, statement: " " })),
      valid.map(s => ({ ...s, references: [{ ...reference, commit: "b".repeat(40) }] })),
      valid.map(s => ({ ...s, references: [{ ...reference, taskId: "outside" }] })),
      valid.map(s => ({ ...s, references: [{ ...reference, contextId: "outside" }] })),
      valid.map(s => ({ ...s, references: [{ ...reference, attempt: 9 }] }))];
    const before = f.objectives.read("goal");
    for (const statements of invalid) {
      await assert.rejects(f.objectives.complete("goal", statements), { reason: "rejected" });
      assert.deepEqual(f.objectives.read("goal"), before);
      assert.equal(f.objectives.history("goal").length, 1);
    }
    await f.tasks.update("work", { objectiveId: null });
    await assert.rejects(f.objectives.complete("goal", valid), { reason: "rejected" });
    await f.tasks.update("work", { objectiveId: "goal" });
    const completed = await f.objectives.complete("goal", [...valid].reverse());
    assert.equal(completed.state, "completed");
    assert.equal(completed.closedAt, completed.updatedAt);
    assert.deepEqual(completed.completionStatements.map(s => s.position), [1, 2]);
    assert.equal(f.objectives.show("goal").criteria[0]!.completion!.statement, valid[0]!.statement);
    await assert.rejects(f.objectives.update("goal", { scope: "No" }), { reason: "rejected" });
    await assert.rejects(f.objectives.complete("goal", valid), { reason: "rejected" });
    await assert.rejects(f.objectives.abandon("goal"), { reason: "rejected" });
    await f.objectives.reopen("goal");
    assert.deepEqual(f.objectives.read("goal")!.completionStatements, []);
    assert.ok(f.objectives.history("goal").find(h => h.action === "complete")!.changes.completionStatements.after.length);
  } finally { f.tasks.close(); }
});

test("recorded reviews are references, but a worker-reported or unaccepted commit alone is not", async () => {
  const f = await fixture();
  try {
    await add(f.objectives);
    await f.tasks.add({ id: "work", title: "Work", objectiveId: "goal" });
    const { ref } = await f.attempts.reserveAttempt({ taskId: "work", requested: {}, maximum: 1, specification: specificationFor });
    const commit = "b".repeat(40);
    await f.attempts.append(ref, "worker_finished", { status: "completed", runtimeDirectory: "/fixture", resultCommit: commit });
    assert.deepEqual(f.objectives.references("goal"), []);
    // The review operation records these findings against the source, not against the review task.
    await f.tasks.database.transaction(() => f.tasks.database.run("INSERT INTO attempt_entries VALUES(?,?,?,?,?)", ref.contextId, ref.taskId, ref.attempt, 2,
      JSON.stringify({ version: 1, ...ref, sequence: 2, recordedAt: new Date().toISOString(), kind: "review_recorded", data: { taskId: "review-work", attempt: 1, commit, verdict: "passed", findings: [] } })));
    const reference = f.objectives.references("goal")[0]!;
    assert.equal(reference.kind, "review");
    const statements = [1, 2].map(position => ({ position, statement: "The recorded review supports this criterion", references: [reference] }));
    await f.objectives.complete("goal", statements);
    assert.equal(f.objectives.read("goal")!.state, "completed");
  } finally { f.tasks.close(); }
});

test("show includes task states and latest live and archived attempts, and completion evidence survives pruning", async () => {
  const f = await fixture();
  try {
    await add(f.objectives);
    const { ref, commit } = await acceptedTask(f);
    await f.attempts.append(ref, "halted", { stage: "fixture", reason: "stopped" });
    const before = f.objectives.references("goal");
    assert.equal(before[0]!.commit, commit);
    let show = f.objectives.show("goal");
    assert.equal(show.tasks[0]!.state, "queued");
    assert.partialDeepStrictEqual(show.tasks[0]!.latestAttempts, [{ contextId: "fixture", attempt: 1, archived: false, closed: true }]);
    await f.attempts.archiveAttempt(f.attempts.read(ref), { state: "finished" }, []);
    assert.deepEqual(f.objectives.references("goal"), before);
    show = f.objectives.show("goal");
    assert.partialDeepStrictEqual(show.tasks[0]!.latestAttempts, [{ contextId: "fixture", attempt: 1, archived: true, closed: true, summary: { state: "finished" } }]);
    await f.objectives.complete("goal", [1, 2].map(position => ({ position, statement: "Met by the kept commit", references: before })));
    assert.equal(f.objectives.read("goal")!.state, "completed");
  } finally { f.tasks.close(); }
});

test("version 9 migration preserves task definitions and attempts, with null links and the revised trigger", async () => {
  const f = await fixture();
  await f.tasks.add({ id: "existing", title: "Existing", acceptanceCriteria: ["Preserve me"] });
  await f.tasks.update("existing", { body: "Instructions" });
  const { ref } = await f.attempts.reserveAttempt({ taskId: "existing", requested: {}, maximum: 1, specification: specificationFor });
  const before = await f.tasks.read("existing");
  const attempt = f.attempts.read(ref);
  await f.tasks.database.transaction(() => {
    f.tasks.database.run("DROP TRIGGER task_definition_changed");
    f.tasks.database.run("DROP INDEX tasks_by_objective");
    f.tasks.database.run("ALTER TABLE tasks DROP COLUMN objective_id");
    for (const table of ["answer_deliveries", "question_answers", "question_files", "worker_usage"]) f.tasks.database.run(`DROP TABLE ${table}`);
    f.tasks.database.run("DROP TABLE task_changes");
    f.tasks.database.run("DROP TABLE objective_changes");
    f.tasks.database.run("DROP TABLE objectives");
    f.tasks.database.run(`CREATE TRIGGER task_definition_changed AFTER UPDATE OF title, body, repo, kind, acceptance_criteria ON tasks
      WHEN NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body OR NEW.repo IS NOT OLD.repo OR NEW.kind IS NOT OLD.kind OR NEW.acceptance_criteria IS NOT OLD.acceptance_criteria
      BEGIN UPDATE tasks SET definition_revision = OLD.definition_revision + 1 WHERE id = NEW.id; END`);
    f.tasks.database.run("PRAGMA user_version = 9");
  });
  f.tasks.close();
  const reopened = await Promise.all([SqliteTaskStore.open({ path: f.path }), SqliteTaskStore.open({ path: f.path })]);
  try {
    for (const tasks of reopened) {
      assert.equal(tasks.database.get("PRAGMA user_version")!.user_version, 13);
      assert.deepEqual(await tasks.read("existing"), before);
      assert.deepEqual(new AttemptStore(tasks.database, "fixture").read(ref), attempt);
      assert.deepEqual(new ObjectiveStore(tasks.database, "operator:creator").list(), []);
      assert.deepEqual(tasks.database.all("PRAGMA foreign_key_check"), []);
    }
    const tasks = reopened[0]!;
    await add(new ObjectiveStore(tasks.database, "operator:creator"));
    assert.equal((await tasks.update("existing", { objectiveId: "goal", body: "Changed" })).definitionRevision, before!.definitionRevision + 1);
    await assert.rejects(tasks.database.transaction(() => tasks.database.run("UPDATE tasks SET objective_id = 'missing' WHERE id = 'existing'")), /FOREIGN KEY/);
  } finally { for (const tasks of reopened) tasks.close(); }
});
