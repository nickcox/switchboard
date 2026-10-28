import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RuntimeRecords } from "../../src/runtime/records.ts";
import { test } from "node:test";
import { AttemptStore, SqliteTaskStore } from "../caller.ts";
import { Database } from "../../src/database.ts";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { status } from "../../src/dispatch/status.ts";
import { specificationFromBinding } from "../../src/attempts/specification.ts";
import { fixture, task } from "../dispatch/fixture.ts";
import { specificationFor } from "../helpers.ts";

test("version 4 bindings migrate once without borrowing missing facts from the current task or configuration", async () => {
  const f = await fixture({ tasks: [task("snapshot-a1"), task("snapshot-b1")], scenario: "commit-result" });
  const result = await dispatchOnce(f.deps, { taskId: "snapshot-a1" });
  assert.equal(result.reason, "held");
  const [runtime] = await f.runtime.discover(f.deps.contextId);
  const expected = specificationFromBinding(runtime!.binding.input);
  const incomplete = (await f.deps.attempts.reserveAttempt({ taskId: "snapshot-b1", requested: {}, maximum: 1, specification: specificationFor })).ref;
  await f.deps.attempts.append(incomplete, "leased", {
    leaseId: "unused", workspace: f.dir, baseRef: "main", outputBranch: "unused", startingCommit: "a".repeat(40),
  });
  await f.tasks.update("snapshot-a1", { title: "Today's title", body: "Today's instructions", kind: "unconfigured" });
  await f.tasks.database.transaction(() => {
    f.tasks.database.run("DROP TABLE review_tasks");
    f.tasks.database.run("DROP TABLE request_records");
    f.tasks.database.run("DROP TABLE attempt_specifications");
    f.tasks.database.run("DROP TRIGGER task_definition_changed");
    f.tasks.database.run("ALTER TABLE tasks DROP COLUMN acceptance_criteria");
    f.tasks.database.run("ALTER TABLE tasks DROP COLUMN definition_revision");
    f.tasks.database.run("DROP INDEX tasks_by_objective");
    f.tasks.database.run("ALTER TABLE tasks DROP COLUMN objective_id");
    f.tasks.database.run("DROP TABLE task_changes");
    f.tasks.database.run("DROP TABLE objective_changes");
    f.tasks.database.run("DROP TABLE objectives");
    f.tasks.database.run("PRAGMA user_version = 4");
  });
  const path = f.tasks.database.path;
  f.tasks.close();
  const reopened = await Promise.all([Database.open(path), Database.open(path)]);
  try {
    for (const database of reopened) {
      assert.equal(database.get("PRAGMA user_version")!.user_version, 11);
      assert.deepEqual(database.all("PRAGMA foreign_key_check"), []);
      assert.equal(database.get("SELECT definition_revision FROM tasks WHERE id = 'snapshot-a1'")!.definition_revision, 1);
      const attempts = new AttemptStore(database, f.deps.contextId);
      const migrated = attempts.findForTask("snapshot-a1")!;
      assert.deepEqual(migrated.specification, expected);
      assert.equal(migrated.specification!.title, undefined);
      assert.equal(migrated.specification!.definitionRevision, undefined);
      assert.equal(migrated.specification!.runtime, undefined);
      assert.equal(migrated.specification!.provenance.runtime, "unknown");
      assert.notEqual(migrated.specification!.instructions, "Today's instructions");
      const reserved = attempts.read(incomplete);
      assert.equal(reserved.specification, undefined);
      assert.equal(reserved.allocation!.leaseId, "unused");
      await assert.rejects(attempts.startReservedTask(incomplete), { reason: "specification_incomplete" });
    }
    assert.equal(reopened[0]!.get("SELECT count(*) AS n FROM attempt_specifications")!.n, 1);
  } finally { for (const database of reopened) database.close(); }
  const tasks = await SqliteTaskStore.open({ path, repo: "fixture" });
  try {
    const attempts = new AttemptStore(tasks.database, f.deps.contextId);
    const inspected = await status({ ...f.deps, tasks, attempts, runtime: new RuntimeRecords(join(f.dir, "runtime"), tasks.database) });
    const entry = inspected.attempts.find(a => a.attempt.taskId === "snapshot-b1")!;
    assert.equal(entry.specificationComplete, false);
    assert.equal(entry.allocation!.leaseId, "unused");
    await attempts.appendConfirmed(incomplete, "operator_resolved", { action: "lease_returned" },
      { fact: "lease_returned", scope: { leaseId: "unused", outputBranch: "unused" } });
    assert.equal(attempts.read(incomplete).entries.at(-1)!.kind, "operator_resolved");
  } finally { tasks.close(); }
});

test("incomplete specifications remain inspectable and fenceable but cannot start or acquire launch permission", async () => {
  const f = await fixture({ tasks: [task("snapshot-a1")] });
  try {
    const ref = { contextId: f.deps.contextId, taskId: "snapshot-a1", attempt: 1 };
    await f.tasks.database.transaction(() => {
      f.tasks.database.run("INSERT INTO attempt_numbers VALUES(?,?,?)", ref.contextId, ref.taskId, ref.attempt);
      f.tasks.database.run("INSERT INTO attempts(context,task,number,reserved_at) VALUES(?,?,?,?)", ref.contextId, ref.taskId, ref.attempt, new Date().toISOString());
      f.tasks.database.run("INSERT INTO attempt_entries VALUES(?,?,?,?,?)", ref.contextId, ref.taskId, ref.attempt, 0, JSON.stringify({
        version: 1, ...ref, sequence: 0, kind: "requested", recordedAt: new Date().toISOString(), data: {},
      }));
    });
    await f.deps.attempts.append(ref, "leased", { leaseId: "unused", workspace: f.deps.repository, baseRef: "main", outputBranch: "unused", startingCommit: "a".repeat(40) });
    await assert.rejects(f.deps.attempts.startReservedTask(ref), { reason: "specification_incomplete" });
    await assert.rejects(f.runtime.reserve({
      identity: { contextId: f.deps.contextId, taskId: ref.taskId, leaseId: "unused", sessionId: randomUUID() },
      workspace: f.deps.repository, instructions: "Do not launch", acceptanceCriteria: [],
      delivery: { ...f.deps.delivery.default, baseRef: "main", outputBranch: "unused", startingCommit: "a".repeat(40) },
    }), /specification is incomplete/);
    assert.equal(f.tasks.database.get("SELECT count(*) AS n FROM launches")!.n, 0);
    assert.equal(f.tasks.database.get("SELECT count(*) AS n FROM worker_claims")!.n, 0);
    assert.equal((await status(f.deps)).attempts[0]!.specificationComplete, false);
    assert.equal(await f.runtime.fence(f.deps.contextId, "unused"), true);
    assert.equal(await f.runtime.fence(f.deps.contextId, "unused"), false);
  } finally { f.tasks.close(); }
});

test("a specification and its allocation cannot be replaced, and a bad snapshot rolls reservation back", async () => {
  const f = await fixture({ tasks: [task("snapshot-a1")] });
  try {
    await assert.rejects(f.deps.attempts.reserveAttempt({ taskId: "snapshot-a1", requested: { requestId: "request" }, maximum: 1,
      specification: (task, ref) => specificationFor(task, ref, { title: "Wrong title" }),
    }), /differs from the reserved task/);
    assert.equal(f.tasks.database.get("SELECT count(*) AS n FROM attempts")!.n, 0);
    assert.equal(f.tasks.database.get("SELECT count(*) AS n FROM attempt_numbers")!.n, 0);
    const { ref } = await f.deps.attempts.reserveAttempt({ taskId: "snapshot-a1", requested: { requestId: "request" }, maximum: 1, specification: specificationFor });
    const lease = { leaseId: "unused", workspace: f.dir, baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40), backingRepository: "/fixture" };
    await f.deps.attempts.append(ref, "leased", lease);
    const before = f.deps.attempts.read(ref);
    await assert.rejects(f.tasks.database.transaction(() => f.tasks.database.run("UPDATE attempt_specifications SET specification = '{}'")), /cannot be changed/);
    await assert.rejects(f.tasks.database.transaction(() => f.tasks.database.run("DELETE FROM attempt_specifications")), /cannot be removed/);
    await assert.rejects(f.deps.attempts.append(ref, "leased", { ...lease, leaseId: "another" }), /allocation cannot be changed/);
    assert.deepEqual(f.deps.attempts.read(ref), before);
  } finally { f.tasks.close(); }
});
