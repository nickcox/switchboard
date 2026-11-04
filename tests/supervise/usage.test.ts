import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Database } from "../../src/database.ts";
import { AttemptStore } from "../../src/attempts/store.ts";
import { specificationFor } from "../helpers.ts";
import { objectiveBudget, describeObjectiveBudget } from "../../src/objectives/budget.ts";
import { ObjectiveStore, defaultPermissions } from "../../src/objectives/store.ts";
import { recordSupervisorUsage, supervisorUsage } from "../../src/supervise/usage.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";

const person = { kind: "person", id: "operator:creator" } as const;
const supervisor = { kind: "supervisor", objectiveId: "goal" } as const;
const root = resolve(".investigation/supervisor-usage");
mkdirSync(root, { recursive: true });

async function fixture() {
  const path = join(realpathSync(mkdtempSync(join(root, "case-"))), "switchboard.db");
  const tasks = await SqliteTaskStore.open({ caller: person, path });
  const database = tasks.database;
  const objectives = new ObjectiveStore(database, person);
  await objectives.add({ id: "goal", request: "Useful work", acceptanceCriteria: ["Working output"] });
  return { path, tasks, database, objectives };
}

function contents(database: Database) {
  return Object.fromEntries(database.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map(row => [String(row.name), database.all(`SELECT * FROM ${row.name}`)]));
}

test("cumulative snapshots are append-only high-water marks, serialised across connections and retained on restart", async () => {
  const f = await fixture();
  const second = await Database.open(f.path);
  try {
    const first = await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "pi-session", cost: 1, tokens: 100 });
    assert.equal(first.sequence, 1);
    assert.ok(Number.isFinite(Date.parse(first.observedAt)));
    const snapshots = await Promise.all([2, 5, 3, 4].map((cost, index) => recordSupervisorUsage(index % 2 ? second : f.database,
      supervisor, "goal", { sessionId: "pi-session", cost, tokens: cost * 100 })));
    assert.deepEqual(snapshots.map(s => s.sequence).sort(), [2, 3, 4, 5]);
    assert.equal(supervisorUsage(f.database, "goal")[0]!.cost, 5);
    const repeated = await recordSupervisorUsage(second, supervisor, "goal", { sessionId: "pi-session", cost: 0, tokens: 1 });
    assert.equal(repeated.cost, 5);
    assert.equal(repeated.tokens, 500);
    await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "new-session", cost: 2, tokens: 50 });
    assert.equal(objectiveBudget(f.database, "goal").spending.cost, 7, "sum sessions, not snapshots");
    assert.equal(objectiveBudget(f.database, "goal").spending.supervisors.tokens, 550);
    assert.equal(f.database.all("SELECT * FROM supervisor_usage").length, 7);
    for (const sql of ["UPDATE supervisor_usage SET cost = 0", "DELETE FROM supervisor_usage",
      "INSERT OR REPLACE INTO supervisor_usage SELECT * FROM supervisor_usage",
      "INSERT INTO supervisor_usage SELECT session_id,sequence+10,objective,observed_at,0,0 FROM supervisor_usage WHERE sequence = 1"]) {
      await assert.rejects(f.database.transaction(() => f.database.run(sql)), /Supervisor usage cannot be/);
    }
  } finally { second.close(); f.tasks.close(); }
  const reopened = await Database.open(f.path);
  try {
    assert.equal(objectiveBudget(reopened, "goal").spending.supervisors.cost, 7);
    assert.equal(supervisorUsage(reopened, "goal").length, 2);
  } finally { reopened.close(); }
});

test("missing supervisor cost and tokens stay unknown, independently, without inventing zero", async () => {
  const f = await fixture();
  try {
    await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "unreported" });
    let value = objectiveBudget(f.database, "goal");
    assert.equal(value.spending.cost, null);
    assert.equal(value.spending.supervisors.cost, null);
    assert.equal(value.spending.supervisors.tokens, null);
    assert.equal(value.spending.supervisors.sessions[0]!.cost, null);
    assert.match(describeObjectiveBudget(value), /supervisors: cost unknown \(observed 0\), tokens unknown/);
    await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "reported", cost: 2, tokens: 100 });
    value = objectiveBudget(f.database, "goal");
    assert.equal(value.spending.cost, null);
    assert.equal(value.spending.observedCost, 2);
    await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "unreported", tokens: 30 });
    assert.equal(objectiveBudget(f.database, "goal").spending.supervisors.tokens, 130);
    assert.equal(objectiveBudget(f.database, "goal").spending.cost, null);
    await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "unreported", cost: 0 });
    const after = await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "unreported" });
    assert.equal(after.cost, 0, "a reported zero is known; a later missing value cannot lower the snapshot");
    assert.equal(after.tokens, 30);
    assert.equal(f.objectives.show("goal").spending.cost, 2);
  } finally { f.tasks.close(); }
});

test("usage checks objective scope and registration openness, not task permissions, and refuses invalid observations or session reassignment", async () => {
  const f = await fixture();
  try {
    await f.objectives.add({ id: "other", request: "Other work", acceptanceCriteria: ["Other output"] });
    await f.objectives.update("goal", { permissions: Object.fromEntries(Object.keys(defaultPermissions).map(key => [key, false])) as typeof defaultPermissions });
    await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "session", cost: 1, tokens: 10 });
    for (const caller of [person, { kind: "supervisor", objectiveId: "other" } as const]) {
      await assert.rejects(recordSupervisorUsage(f.database, caller, "goal", { sessionId: "session" }), /Only the objective's supervisor/);
    }
    await assert.rejects(recordSupervisorUsage(f.database, { kind: "supervisor", objectiveId: "other" }, "other", { sessionId: "session" }), /cannot be moved/);
    for (const sessionId of ["", " \n "]) await assert.rejects(recordSupervisorUsage(f.database, supervisor, "goal", { sessionId }), /nonblank session/);
    for (const value of [-1, NaN, Infinity]) for (const key of ["cost", "tokens"]) {
      await assert.rejects(recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "session", [key]: value }), /finite nonnegative/);
    }
    await f.objectives.abandon("goal");
    await assert.rejects(recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "new-session" }), /must be open/);
    assert.equal(f.database.all("SELECT * FROM supervisor_usage").length, 1);
  } finally { f.tasks.close(); }
});

for (const state of ["completed", "abandoned"] as const) test(`registered sessions keep append-only usage and budget accounting after ${state}`, async () => {
  const f = await fixture();
  try {
    await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "known", cost: 1, tokens: 10 });
    await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "unknown" });
    if (state === "completed") {
      await f.tasks.add({ id: "work", title: "Work", objectiveId: "goal" });
      const attempts = new AttemptStore(f.database, "fixture", person);
      const { ref } = await attempts.reserveAttempt({ taskId: "work", requested: {}, maximum: 1, specification: specificationFor });
      const commit = "a".repeat(40);
      await attempts.appendConfirmed(ref, "output_accepted", { commit }, { fact: "output_accepted", scope: { commit } });
      await f.objectives.complete("goal", [{ position: 1, statement: "Working output", references: f.objectives.show("goal").availableReferences }]);
    } else await f.objectives.abandon("goal");
    const before = f.database.all("SELECT * FROM supervisor_usage ORDER BY session_id,sequence");
    const later = await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "known", cost: 1.07, tokens: 20 });
    assert.equal(later.sequence, 2);
    assert.equal(later.cost, 1.07);
    assert.equal(later.tokens, 20);
    const lower = await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "known", cost: 0, tokens: 1 });
    assert.equal(lower.sequence, 3);
    assert.equal(lower.cost, 1.07);
    assert.equal(lower.tokens, 20);
    await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "unknown" });
    assert.deepEqual(f.database.all("SELECT * FROM supervisor_usage WHERE sequence = 1 ORDER BY session_id,sequence"), before);
    const spending = objectiveBudget(f.database, "goal").spending;
    assert.equal(spending.supervisors.observedCost, 1.07);
    assert.equal(spending.supervisors.cost, null);
    assert.equal(spending.cost, null);
    assert.equal(spending.observedCost, 1.07);
    assert.equal(spending.supervisors.sessions.find(row => row.sessionId === "unknown")!.tokens, null);
    assert.equal(f.objectives.read("goal")!.state, state);
    await assert.rejects(recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "new", cost: 5 }), /must be open before registering/);
    assert.equal(f.database.all("SELECT * FROM supervisor_usage").length, 5);
  } finally { f.tasks.close(); }
});

test("schema 18 migrates concurrently without changing existing records", async () => {
  const f = await fixture();
  await f.tasks.add({ id: "work", title: "Preserve this", objectiveId: "goal" });
  await f.objectives.update("goal", { scope: "Preserve this too" });
  await f.database.transaction(() => {
    f.database.run("DROP TABLE supervisor_usage");
    f.database.run("PRAGMA user_version = 18");
  });
  const before = contents(f.database);
  f.tasks.close();
  const databases = await Promise.all([Database.open(f.path), Database.open(f.path)]);
  try {
    for (const database of databases) {
      assert.equal(database.get("PRAGMA user_version")!.user_version, 19);
      const { supervisor_usage, ...after } = contents(database);
      assert.deepEqual(after, before);
      assert.deepEqual(supervisor_usage, []);
      assert.deepEqual(database.all("PRAGMA foreign_key_check"), []);
    }
    await recordSupervisorUsage(databases[0]!, supervisor, "goal", { sessionId: "after-migration", cost: 1, tokens: 10 });
    assert.equal(supervisorUsage(databases[1]!, "goal")[0]!.cost, 1);
  } finally { for (const database of databases) database.close(); }
});
