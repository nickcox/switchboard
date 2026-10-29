import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ObjectiveStore, defaultPermissions } from "../../src/objectives/store.ts";
import { handleEvent, pendingEvents, waitForEvent } from "../../src/supervise/events.ts";
import { askPerson } from "../../src/supervise/questions.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";

const person = { kind: "person", id: "operator:creator" } as const;
const supervisor = { kind: "supervisor", objectiveId: "goal" } as const;
const root = resolve(".investigation/supervisor-events-cost");
mkdirSync(root, { recursive: true });

async function fixture() {
  const dir = realpathSync(mkdtempSync(join(root, "case-")));
  const tasks = await SqliteTaskStore.open({ caller: person, path: join(dir, "switchboard.db") });
  const database = tasks.database;
  const objectives = new ObjectiveStore(database, person);
  await objectives.add({ id: "goal", request: "Useful work", acceptanceCriteria: ["Working output"] });
  return { tasks, database, objectives };
}

test("several seconds of idle wait poll without any write transactions, as does objective show", async t => {
  const f = await fixture();
  try {
    const writes = t.mock.method(f.database, "transaction");
    const reads = t.mock.method(f.database, "get");
    const started = Date.now();
    assert.deepEqual(await waitForEvent(f.database, supervisor, "goal", 3.1), { ok: true, action: "wait", event: null, timedOut: true });
    assert.ok(Date.now() - started >= 3000);
    assert.ok(reads.mock.callCount() > 30, "The wait polled repeatedly");
    assert.equal(writes.mock.callCount(), 0);
    assert.equal(f.objectives.show("goal").id, "goal");
    assert.equal(writes.mock.callCount(), 0);
    await f.objectives.update("goal", { scope: "A person's decision" });
    const recorded = writes.mock.callCount();
    assert.equal((await waitForEvent(f.database, supervisor, "goal", 0)).event!.kind, "person_intervention");
    f.objectives.show("goal");
    assert.equal(writes.mock.callCount(), recorded, "Returning an existing event does not need a write");
  } finally { f.tasks.close(); }
});

test("wait records newly reached limits in one transaction, in budget then deadline order, even with an earlier pending event", async t => {
  const f = await fixture();
  try {
    await f.objectives.update("goal", { scope: "Earlier event" });
    const first = pendingEvents(f.database, "goal").first!;
    await f.database.transaction(() => f.database.run("UPDATE objectives SET budget = ?, deadline = ? WHERE id = 'goal'",
      JSON.stringify({ maxCost: 0, maxWorkerTimeMs: 0 }), new Date(Date.now() - 1000).toISOString()));
    const writes = t.mock.method(f.database, "transaction");
    assert.equal((await waitForEvent(f.database, supervisor, "goal", 0)).event!.id, first.id);
    assert.equal(writes.mock.callCount(), 1);
    assert.deepEqual(f.database.all("SELECT source,kind FROM supervisor_events WHERE objective = 'goal' ORDER BY sequence").map(row => row.kind),
      ["person_intervention", "budget_reached", "budget_reached", "deadline_reached"]);
    assert.deepEqual(f.database.all("SELECT source FROM supervisor_events WHERE kind = 'budget_reached' ORDER BY sequence").map(row => row.source),
      ["budget:cost:0", "budget:worker_time:0"]);
    await waitForEvent(f.database, supervisor, "goal", 0);
    assert.equal(writes.mock.callCount(), 1, "Previously recorded limits do not take the write lock again");
    while (pendingEvents(f.database, "goal").first) await handleEvent(f.database, supervisor, "goal", pendingEvents(f.database, "goal").first!.id);
    const acknowledged = writes.mock.callCount();
    assert.equal((await waitForEvent(f.database, supervisor, "goal", 0.4)).timedOut, true);
    assert.equal(writes.mock.callCount(), acknowledged);
  } finally { f.tasks.close(); }
});

test("a deadline passing during an idle wait opens just the transaction that records it", async t => {
  const f = await fixture();
  try {
    await f.objectives.update("goal", { deadline: new Date(Date.now() + 500).toISOString() });
    await handleEvent(f.database, supervisor, "goal", pendingEvents(f.database, "goal").first!.id);
    const writes = t.mock.method(f.database, "transaction");
    assert.equal((await waitForEvent(f.database, supervisor, "goal", 3)).event!.kind, "deadline_reached");
    assert.equal(writes.mock.callCount(), 1);
    await waitForEvent(f.database, supervisor, "goal", 0);
    assert.equal(writes.mock.callCount(), 1);
  } finally { f.tasks.close(); }
});

test("wait, handled and ask need scope, not task mutation permissions, and still refuse another supervisor", async () => {
  const f = await fixture();
  try {
    await f.objectives.add({ id: "other", request: "Other work", acceptanceCriteria: ["Other output"] });
    const permissions = Object.fromEntries(Object.keys(defaultPermissions).map(key => [key, false])) as typeof defaultPermissions;
    await f.objectives.update("goal", { permissions });
    const event = (await waitForEvent(f.database, supervisor, "goal", 0)).event!;
    assert.ok(event);
    await handleEvent(f.database, supervisor, "goal", event.id);
    assert.equal((await waitForEvent(f.database, supervisor, "goal", 0)).timedOut, true);
    const question = await askPerson(f.database, supervisor, "goal", "Which approach?", undefined, "design");
    assert.equal(question.askedBy, "supervisor:goal");
    const other = { kind: "supervisor", objectiveId: "other" } as const;
    await assert.rejects(waitForEvent(f.database, other, "goal", 0), /Only the objective's supervisor/);
    await assert.rejects(handleEvent(f.database, other, "goal", event.id), /Only the objective's supervisor/);
    await assert.rejects(askPerson(f.database, other, "goal", "Which approach?"), /Only the objective's supervisor/);
  } finally { f.tasks.close(); }
});
