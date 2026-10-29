import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { SQLInputValue } from "node:sqlite";
import { AttemptStore } from "../../src/attempts/store.ts";
import type { AttemptRef } from "../../src/attempts/log.ts";
import { personIntervention, personInterventions } from "../../src/objectives/interventions.ts";
import { ObjectiveStore } from "../../src/objectives/store.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";
import { specificationFor } from "../helpers.ts";

const person = { kind: "person", id: "operator:creator" } as const;
const root = resolve(".investigation/interventions-cost");
mkdirSync(root, { recursive: true });

async function fixture() {
  const dir = realpathSync(mkdtempSync(join(root, "case-")));
  const tasks = await SqliteTaskStore.open({ caller: person, path: join(dir, "switchboard.db") });
  const database = tasks.database;
  const objectives = new ObjectiveStore(database, person);
  for (const id of ["goal", "other"]) await objectives.add({ id, request: id, acceptanceCriteria: ["Working output"] });
  const attempts = new AttemptStore(database, "context", person);
  return { tasks, database, objectives, attempts };
}

function assertSources(f: Awaited<ReturnType<typeof fixture>>, ref: AttemptRef, objectiveId = "goal") {
  const interventions = personInterventions(f.database, objectiveId);
  for (const item of [...interventions.items, ...interventions.leaseReturns.items]) {
    assert.deepEqual(personIntervention(f.database, objectiveId, item.id, ref), item, item.id);
  }
  const events = f.database.all("SELECT details FROM supervisor_events WHERE objective = ? AND kind = 'person_intervention'", objectiveId);
  assert.deepEqual(events.map(row => JSON.parse(String(row.details)).id).sort(),
    [...interventions.items, ...interventions.leaseReturns.items].map(item => item.id).sort());
}

test("source lookups share finish, confirmation, dispatch, membership and forwarded-request rules with the briefing", async () => {
  const f = await fixture();
  try {
    await f.tasks.add({ id: "work", title: "Work", objectiveId: "goal" });
    const { ref } = await f.attempts.reserveAttempt({ taskId: "work", requested: {}, maximum: 1, specification: specificationFor });
    const commit = "a".repeat(40);
    await f.attempts.append(ref, "integration_started", { targetBranch: "main", from: "b".repeat(40), commit });
    await f.attempts.finishAttempt(ref, { state: "queued", holdReason: null });
    assert.equal(personInterventions(f.database, "goal").items.filter(item => item.action === "finish").length, 1);
    await f.attempts.finishAttempt(ref, { state: "done", holdReason: null });
    assert.equal(personInterventions(f.database, "goal").items.filter(item => item.action === "finish").length, 2);
    await f.attempts.append(ref, "rebase_started", { original: commit, upstream: commit, onto: commit });
    await f.attempts.recordConfirmation(ref, { fact: "worker_stopped", scope: { leaseId: "lease" } });
    await f.attempts.recordConfirmation(ref, { fact: "no_processes", scope: { leaseId: "lease", returnId: randomUUID() } });
    const requestId = randomUUID();
    await f.attempts.append(ref, "operator_request", { id: requestId, kind: "steer", sender: person.id, message: "Smaller", outcome: "delivered" });
    const request = personInterventions(f.database, "goal").items.find(item => item.id === `request:${requestId}`)!;
    assert.equal(request.source, "attempt_entries");
    assertSources(f, ref);
    await f.tasks.update("work", { objectiveId: "other" });
    await f.attempts.recordConfirmation(ref, { fact: "lease_returned", scope: { leaseId: "lease", outputBranch: "output" } });
    assertSources(f, ref);
    assertSources(f, ref, "other");
    await f.attempts.archiveAttempt(f.attempts.read(ref), { state: "finished" }, []);
    assertSources(f, ref);
    assertSources(f, ref, "other");
  } finally { f.tasks.close(); }
});

test("person-event recording reads only its source and related history, regardless of unrelated task and attempt counts", async t => {
  const f = await fixture();
  try {
    const other = await SqliteTaskStore.open({ path: f.database.path, caller: { kind: "supervisor", objectiveId: "other" } });
    const otherAttempts = new AttemptStore(f.database, "context", { kind: "supervisor", objectiveId: "other" });
    try {
      for (let n = 0; n < 40; n++) {
        const id = `unrelated-${n}`;
        await other.add({ id, title: id, objectiveId: "other" });
        await otherAttempts.reserveAttempt({ taskId: id, requested: {}, maximum: 100, specification: specificationFor });
      }
    } finally { other.close(); }
    const original = f.database.all.bind(f.database);
    const reads = t.mock.method(f.database, "all", (sql: string, ...values: SQLInputValue[]) => {
      if (/FROM task_changes\b/.test(sql)) assert.match(sql, /WHERE (?:task|sequence) = \?/);
      if (/FROM attempt_numbers\b/.test(sql)) assert.match(sql, /WHERE/);
      const rows = original(sql, ...values);
      assert.ok(rows.length < 10, `An event lookup read unrelated records: ${sql}`);
      return rows;
    });
    await f.objectives.update("goal", { scope: "Only this task" });
    await f.tasks.add({ id: "work", title: "Work", objectiveId: "goal" });
    await f.tasks.hold("work", "Wait");
    await f.tasks.release("work");
    const { ref } = await f.attempts.reserveAttempt({ taskId: "work", requested: {}, maximum: 100, specification: specificationFor });
    await f.attempts.recordConfirmation(ref, { fact: "worker_stopped", scope: { leaseId: "lease" } });
    await f.attempts.append(ref, "operator_request", { id: randomUUID(), kind: "steer", sender: person.id, message: "Smaller", outcome: "delivered" });
    assert.ok(reads.mock.callCount() > 0);
    reads.mock.restore();
    assertSources(f, ref);
    for (const [sql, index] of [
      ["SELECT * FROM task_changes WHERE task = ? ORDER BY changed_at,sequence", "task_changes_by_task"],
      ["SELECT * FROM confirmations WHERE context = ? AND task = ? AND attempt = ? ORDER BY id", "confirmations_by_attempt"],
    ] as const) {
      const parameters = sql.includes("context") ? ["context", "work", 1] : ["work"];
      const plan = f.database.all(`EXPLAIN QUERY PLAN ${sql}`, ...parameters).map(row => String(row.detail)).join("\n");
      assert.match(plan, new RegExp(`SEARCH .*${index}`));
      assert.doesNotMatch(plan, /SCAN/);
    }
  } finally { f.tasks.close(); }
});
