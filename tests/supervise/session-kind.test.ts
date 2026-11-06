import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Database } from "../../src/database.ts";
import { ObjectiveStore } from "../../src/objectives/store.ts";
import { appendNote } from "../../src/supervise/notes.ts";
import { recordSupervisorSessionState } from "../../src/supervise/session-state.ts";
import { recordSupervisorUsage, supervisorUsage } from "../../src/supervise/usage.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";

const person = { kind: "person", id: "operator:creator" } as const;
const supervisor = { kind: "supervisor", objectiveId: "goal" } as const;
const root = resolve(".investigation/supervisor-session-kind");
mkdirSync(root, { recursive: true });
async function fixture() {
  const path = join(mkdtempSync(join(root, "case-")), "switchboard.db");
  const tasks = await SqliteTaskStore.open({ caller: person, path });
  const objectives = new ObjectiveStore(tasks.database, person);
  await objectives.add({ id: "goal", request: "Useful work", acceptanceCriteria: ["Working output"] });
  return { path, tasks, database: tasks.database, objectives };
}
function contents(database: Database) {
  return Object.fromEntries(database.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map(row => [String(row.name), database.all(`SELECT rowid,* FROM ${row.name} ORDER BY rowid`)]));
}
const triggers = (database: Database) => database.all("SELECT name,sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name");

test("session kind is registered atomically once, survives restart and cannot change or be added later", async () => {
  const f = await fixture();
  try {
    for (const sessionKind of ["restricted", "unrestricted"] as const) {
      const first = await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: sessionKind, sessionKind });
      assert.equal(first.sessionKind, sessionKind);
      const next = await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: sessionKind, cost: 1 });
      assert.equal(next.sessionKind, sessionKind);
      await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: sessionKind, sessionKind });
      await assert.rejects(recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: sessionKind,
        sessionKind: sessionKind === "restricted" ? "unrestricted" : "restricted" }), /kind cannot change/);
    }
    await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "unknown" });
    await assert.rejects(recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "unknown", sessionKind: "restricted" }), /kind cannot change/);
    for (const sql of ["UPDATE supervisor_session_kinds SET kind = 'restricted'", "DELETE FROM supervisor_session_kinds",
      "INSERT OR REPLACE INTO supervisor_session_kinds VALUES('unrestricted','restricted')",
      "INSERT INTO supervisor_session_kinds VALUES('unknown','restricted')"]) {
      await assert.rejects(f.database.transaction(() => f.database.run(sql)), /Supervisor session kind/);
    }
    await f.objectives.abandon("goal");
    await assert.rejects(recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "closed", sessionKind: "restricted" }), /must be open/);
    assert.equal(f.database.get("SELECT * FROM supervisor_session_kinds WHERE session_id = 'closed'"), undefined);
    assert.equal(f.database.all("SELECT * FROM supervisor_session_kinds").length, 2);
  } finally { f.tasks.close(); }
  const database = await Database.open(f.path);
  try {
    assert.deepEqual(supervisorUsage(database, "goal").map(row => row.sessionKind), ["restricted", "not recorded", "unrestricted"]);
  } finally { database.close(); }
});

test("schema 21 migrates concurrently to 22 preserving every record and trigger without guessing old session kinds", async () => {
  const f = await fixture();
  await f.tasks.add({ id: "work", title: "Keep the task", objectiveId: "goal" });
  await f.objectives.update("goal", { scope: "Keep history" });
  await appendNote(f.database, supervisor, "goal", "Keep this note");
  await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "old", cost: 1, tokens: 100 });
  await recordSupervisorUsage(f.database, supervisor, "goal", { sessionId: "old", cost: 2, tokens: 200 });
  await recordSupervisorSessionState(f.database, supervisor, "goal", { sessionId: "old", state: "stopped", errorMessage: "Provider failed", eventIds: ["delivered"] });
  await recordSupervisorSessionState(f.database, supervisor, "goal", { sessionId: "old", state: "retrying", errorMessage: "Provider failed", eventIds: ["delivered"], retryNumber: 1, retryTotal: 2, nextRetryAt: new Date().toISOString() });
  await f.database.transaction(() => {
    f.database.run("DROP TABLE supervisor_session_kinds");
    f.database.run("PRAGMA user_version = 21");
  });
  const before = contents(f.database);
  const oldTriggers = triggers(f.database);
  f.tasks.close();
  const databases = await Promise.all([Database.open(f.path), Database.open(f.path)]);
  try {
    for (const database of databases) {
      assert.equal(database.get("PRAGMA user_version")!.user_version, 22);
      const { supervisor_session_kinds, ...after } = contents(database);
      assert.deepEqual(after, before);
      assert.deepEqual(supervisor_session_kinds, []);
      assert.deepEqual(triggers(database).filter(row => !String(row.name).startsWith("supervisor_session_kinds_")), oldTriggers);
      assert.deepEqual(database.all("PRAGMA foreign_key_check"), []);
      const old = supervisorUsage(database, "goal")[0]!;
      assert.equal(old.sessionKind, "not recorded");
      assert.equal(old.limitsNotice, null);
      assert.equal(old.cost, 2);
      assert.equal(new ObjectiveStore(database, person).show("goal").spending.supervisors.sessions[0]!.sessionKind, "not recorded");
    }
    await recordSupervisorUsage(databases[0]!, supervisor, "goal", { sessionId: "old", cost: 3 });
    assert.equal(supervisorUsage(databases[1]!, "goal")[0]!.sessionKind, "not recorded");
    await assert.rejects(recordSupervisorUsage(databases[0]!, supervisor, "goal", { sessionId: "old", sessionKind: "restricted" }), /kind cannot change/);
    await recordSupervisorUsage(databases[0]!, supervisor, "goal", { sessionId: "new", sessionKind: "unrestricted" });
    assert.equal(supervisorUsage(databases[1]!, "goal")[0]!.sessionKind, "unrestricted");
    for (const sql of ["UPDATE supervisor_usage SET cost = 0", "DELETE FROM supervisor_session_states", "INSERT OR REPLACE INTO supervisor_usage SELECT * FROM supervisor_usage"]) {
      await assert.rejects(databases[0]!.transaction(() => databases[0]!.run(sql)));
    }
  } finally { for (const database of databases) database.close(); }
});
