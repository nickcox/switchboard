import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Database } from "../../src/database.ts";
import { ObjectiveStore } from "../../src/objectives/store.ts";
import { recordSupervisorSessionState, supervisorSessionHealth } from "../../src/supervise/session-state.ts";
import { recordSupervisorUsage } from "../../src/supervise/usage.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";

const person = { kind: "person", id: "operator:creator" } as const;
const supervisor = { kind: "supervisor", objectiveId: "goal" } as const;
const root = resolve(".investigation/supervisor-session-state");
mkdirSync(root, { recursive: true });
async function fixture() {
  const path = join(realpathSync(mkdtempSync(join(root, "case-"))), "switchboard.db");
  const tasks = await SqliteTaskStore.open({ caller: person, path });
  const database = tasks.database;
  const objectives = new ObjectiveStore(database, person);
  await objectives.add({ id: "goal", request: "Useful work", acceptanceCriteria: ["Working output"] });
  await recordSupervisorUsage(database, supervisor, "goal", { sessionId: "session", cost: 1, tokens: 100 });
  return { path, tasks, database, objectives };
}
const stopped = { sessionId: "session", state: "stopped", errorMessage: "Codex error: The usage limit has been reached", eventIds: ["first", "second"] } as const;
const stopInput = () => ({ ...stopped, eventIds: [...stopped.eventIds] });
function contents(database: Database) {
  return Object.fromEntries(database.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map(row => [String(row.name), database.all(`SELECT * FROM ${row.name}`)]));
}

test("stopped and resumed observations are append-only, scoped per session and retained on restart", async () => {
  const f = await fixture();
  const second = await Database.open(f.path);
  let first;
  try {
    first = await recordSupervisorSessionState(f.database, supervisor, "goal", stopInput());
    assert.equal(first!.sequence, 1);
    assert.ok(Number.isFinite(Date.parse(first!.observedAt)));
    assert.deepEqual(supervisorSessionHealth(second, "goal").stoppedSessions, [first]);
    assert.equal(f.objectives.show("goal").attentionRequired, true);
    assert.equal(f.objectives.list()[0]!.attentionRequired, true);
    for (const sql of ["UPDATE supervisor_session_states SET state = 'resumed'", "DELETE FROM supervisor_session_states",
      "INSERT OR REPLACE INTO supervisor_session_states SELECT * FROM supervisor_session_states",
      "INSERT INTO supervisor_session_states SELECT session_id,sequence-1,objective,observed_at,state,error_message,event_ids FROM supervisor_session_states"]) {
      await assert.rejects(f.database.transaction(() => f.database.run(sql)));
    }
    const resumed = await recordSupervisorSessionState(second, supervisor, "goal", { sessionId: "session", state: "resumed" });
    assert.equal(resumed!.sequence, 2);
    assert.equal(resumed!.errorMessage, null);
    assert.deepEqual(resumed!.eventIds, []);
    assert.equal(supervisorSessionHealth(f.database, "goal").attentionRequired, false);
    assert.deepEqual(f.database.all("SELECT * FROM supervisor_session_states").map(row => row.state), ["stopped", "resumed"]);
  } finally { second.close(); f.tasks.close(); }
  const reopened = await Database.open(f.path);
  try {
    assert.equal(supervisorSessionHealth(reopened, "goal").attentionRequired, false);
    assert.equal(reopened.all("SELECT * FROM supervisor_session_states").length, 2);
    assert.equal(reopened.get("SELECT error_message FROM supervisor_session_states WHERE sequence = 1")!.error_message, first!.errorMessage);
  } finally { reopened.close(); }
});

test("a successful replacement session clears earlier stops only for its objective, preserving history and later stops", async () => {
  const f = await fixture();
  try {
    const first = await recordSupervisorSessionState(f.database, supervisor, "goal", stopInput());
    await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "replacement" });
    assert.deepEqual(supervisorSessionHealth(f.database, "goal").stoppedSessions, [first], "registration is not recovery");
    await f.objectives.add({ id: "other", request: "Other", acceptanceCriteria: ["Other output"] });
    const other = { kind: "supervisor", objectiveId: "other" } as const;
    await recordSupervisorUsage(f.database, other, "other", { sessionId: "unrelated" });
    assert.equal(await recordSupervisorSessionState(f.database, other, "other", { sessionId: "unrelated", state: "resumed" }), null);
    assert.deepEqual(supervisorSessionHealth(f.database, "goal").stoppedSessions, [first]);
    const resumed = await recordSupervisorSessionState(f.database, supervisor, "goal", { sessionId: "replacement", state: "resumed" });
    assert.equal(resumed!.sessionId, "replacement");
    assert.equal(resumed!.sequence, 1);
    assert.equal(supervisorSessionHealth(f.database, "goal").attentionRequired, false);
    assert.equal(await recordSupervisorSessionState(f.database, supervisor, "goal", { sessionId: "replacement", state: "resumed" }), null);
    assert.deepEqual(f.database.all("SELECT state FROM supervisor_session_states ORDER BY rowid").map(row => row.state), ["stopped", "resumed"]);
    assert.equal(f.database.get("SELECT error_message FROM supervisor_session_states WHERE session_id = 'session'")!.error_message, first!.errorMessage);
    const later = await recordSupervisorSessionState(f.database, supervisor, "goal", stopInput());
    assert.deepEqual(supervisorSessionHealth(f.database, "goal").stoppedSessions, [later], "an earlier success cannot clear a later stop");
    await recordSupervisorSessionState(f.database, other, "other", { sessionId: "unrelated", state: "stopped", errorMessage: "Other provider failed" });
    await recordSupervisorSessionState(f.database, other, "other", { sessionId: "unrelated", state: "resumed" });
    assert.deepEqual(supervisorSessionHealth(f.database, "goal").stoppedSessions, [later], "even a recorded recovery for another objective clears nothing here");
    await recordSupervisorSessionState(f.database, supervisor, "goal", { sessionId: "replacement", state: "resumed" });
    assert.equal(supervisorSessionHealth(f.database, "goal").attentionRequired, false);
  } finally { f.tasks.close(); }
});

test("observations require the bound registered session, validate inputs and remain recordable after objective closure", async () => {
  const f = await fixture();
  try {
    await f.objectives.add({ id: "other", request: "Other", acceptanceCriteria: ["Other output"] });
    for (const caller of [person, { kind: "supervisor", objectiveId: "other" } as const]) {
      await assert.rejects(recordSupervisorSessionState(f.database, caller, "goal", stopInput()), /Only the objective's supervisor/);
    }
    await assert.rejects(recordSupervisorSessionState(f.database, { kind: "supervisor", objectiveId: "other" }, "other", stopInput()), /registered to this objective/);
    await assert.rejects(recordSupervisorSessionState(f.database, supervisor, "goal", { ...stopInput(), sessionId: "unregistered" }), /registered/);
    await assert.rejects(recordSupervisorSessionState(f.database, supervisor, "goal", { ...stopInput(), sessionId: " " }), /nonblank/);
    await assert.rejects(recordSupervisorSessionState(f.database, supervisor, "goal", { ...stopInput(), errorMessage: " " }), /error message/);
    await assert.rejects(recordSupervisorSessionState(f.database, supervisor, "goal", { ...stopInput(), eventIds: [""] }), /Event IDs/);
    await assert.rejects(recordSupervisorSessionState(f.database, supervisor, "goal", { ...stopInput(), state: "resumed" }), /cannot include/);
    await f.objectives.abandon("goal");
    await recordSupervisorSessionState(f.database, supervisor, "goal", stopInput());
    await recordSupervisorSessionState(f.database, supervisor, "goal", { sessionId: "session", state: "resumed" });
    assert.equal(f.objectives.read("goal")!.state, "abandoned");
    assert.equal(f.database.all("SELECT * FROM supervisor_session_states").length, 2);
  } finally { f.tasks.close(); }
});

test("schema 19 migrates concurrently to schema 20 without changing existing records", async () => {
  const f = await fixture();
  await f.tasks.add({ id: "work", title: "Preserve this", objectiveId: "goal" });
  await f.objectives.update("goal", { scope: "Keep the scope" });
  await f.database.transaction(() => {
    f.database.run("DROP TABLE supervisor_session_states");
    f.database.run("PRAGMA user_version = 19");
  });
  const before = contents(f.database);
  f.tasks.close();
  const databases = await Promise.all([Database.open(f.path), Database.open(f.path)]);
  try {
    for (const database of databases) {
      assert.equal(database.get("PRAGMA user_version")!.user_version, 20);
      const { supervisor_session_states, ...after } = contents(database);
      assert.deepEqual(after, before);
      assert.deepEqual(supervisor_session_states, []);
      assert.deepEqual(database.all("PRAGMA foreign_key_check"), []);
    }
    await recordSupervisorSessionState(databases[0]!, supervisor, "goal", stopInput());
    assert.equal(supervisorSessionHealth(databases[1]!, "goal").stoppedSessions.length, 1);
  } finally { for (const database of databases) database.close(); }
});
