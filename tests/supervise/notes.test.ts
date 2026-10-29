import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { AttemptStore } from "../../src/attempts/store.ts";
import { Database } from "../../src/database.ts";
import { ObjectiveStore, defaultPermissions } from "../../src/objectives/store.ts";
import { appendNote, readNotes } from "../../src/supervise/notes.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";
import { specificationFor } from "../helpers.ts";

const person = { kind: "person", id: "operator:creator" } as const;
const supervisor = { kind: "supervisor", objectiveId: "goal" } as const;
const root = resolve(".investigation/supervisor-notes");
mkdirSync(root, { recursive: true });

async function fixture() {
  const path = join(realpathSync(mkdtempSync(join(root, "case-"))), "switchboard.db");
  const tasks = await SqliteTaskStore.open({ caller: person, path });
  const objectives = new ObjectiveStore(tasks.database, person);
  await objectives.add({ id: "goal", request: "Do useful work", acceptanceCriteria: ["Useful output"] });
  return { path, tasks, database: tasks.database, objectives };
}

function contents(database: Database) {
  return Object.fromEntries(database.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map(row => [String(row.name), database.all(`SELECT * FROM ${row.name}`)]));
}

test("notes retain text, author, timestamps and per-objective sequence across concurrent appends and restarts", async () => {
  const f = await fixture();
  const second = await Database.open(f.path);
  try {
    await f.objectives.add({ id: "other", request: "Other work", acceptanceCriteria: ["Other output"] });
    await f.objectives.update("goal", { permissions: Object.fromEntries(Object.keys(defaultPermissions).map(key => [key, false])) as typeof defaultPermissions });
    const text = "  Keep this decision.\nUse the smaller design.  ";
    const first = await appendNote(f.database, supervisor, "goal", text);
    assert.equal(first.text, text);
    assert.equal(first.writtenBy, "supervisor:goal");
    assert.equal(first.sequence, 1);
    assert.ok(Number.isFinite(Date.parse(first.writtenAt)));
    const concurrent = await Promise.all(Array.from({ length: 10 }, (_, index) => appendNote(index % 2 ? f.database : second, supervisor, "goal", `Decision ${index}`)));
    assert.deepEqual(concurrent.map(note => note.sequence).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal((await appendNote(second, { kind: "supervisor", objectiveId: "other" }, "other", "Other note")).sequence, 1);
    assert.deepEqual(readNotes(f.database, "goal").map(note => note.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  } finally { second.close(); f.tasks.close(); }
  const reopened = await Database.open(f.path);
  try {
    assert.equal(readNotes(reopened, "goal")[0]!.text, "  Keep this decision.\nUse the smaller design.  ");
    assert.equal(readNotes(reopened, "goal").length, 11);
    assert.equal(readNotes(reopened, "other").length, 1);
  } finally { reopened.close(); }
});

test("notes cannot be updated, deleted or replaced, and only the bound supervisor may append nonblank notes to an open objective", async () => {
  const f = await fixture();
  try {
    const note = await appendNote(f.database, supervisor, "goal", "Remember this");
    for (const sql of ["UPDATE supervisor_notes SET text = 'Changed'", "UPDATE supervisor_notes SET sequence = 2", "DELETE FROM supervisor_notes",
      "INSERT OR REPLACE INTO supervisor_notes SELECT objective,sequence,'Replaced',written_at,written_by FROM supervisor_notes"]) {
      await assert.rejects(f.database.transaction(() => f.database.run(sql)), /Supervisor notes cannot be/);
    }
    await assert.rejects(appendNote(f.database, person, "goal", "No"), /Only the objective's supervisor/);
    await assert.rejects(appendNote(f.database, { kind: "supervisor", objectiveId: "other" }, "goal", "No"), /Only the objective's supervisor/);
    for (const text of ["", " \n\t "]) await assert.rejects(appendNote(f.database, supervisor, "goal", text), /must not be blank/);
    assert.deepEqual(readNotes(f.database, "goal"), [note]);
    await f.objectives.abandon("goal");
    await assert.rejects(appendNote(f.database, supervisor, "goal", "No"), /must be open/);
    assert.deepEqual(readNotes(f.database, "goal"), [note]);
  } finally { f.tasks.close(); }
});

test("schema 13 migrates concurrently to the current schema without changing any existing records", async () => {
  const f = await fixture();
  await f.tasks.add({ id: "work", title: "Work", objectiveId: "goal", acceptanceCriteria: ["Preserve me"] });
  await f.tasks.add({ id: "blocker", title: "Blocker", objectiveId: "goal" });
  const attempts = new AttemptStore(f.database, "context", person);
  const { ref } = await attempts.reserveAttempt({ taskId: "work", requested: { requestId: "stable" }, maximum: 1, specification: specificationFor });
  await attempts.append(ref, "halted", { stage: "acquire", reason: "stopped" });
  await f.tasks.block("work", "blocker");
  await f.tasks.hold("work", "Keep this hold");
  await f.objectives.update("goal", { scope: "Keep the scope", budget: { maxCost: 10, maxWorkerTimeMs: 2000 } });
  await f.database.transaction(() => {
    f.database.run("DROP TABLE supervisor_dispatches");
    f.database.run("DROP TABLE supervisor_positions");
    f.database.run("DROP TABLE supervisor_events");
    f.database.run("DROP TABLE supervisor_notes");
    f.database.run("PRAGMA user_version = 13");
  });
  const before = contents(f.database);
  f.tasks.close();
  const databases = await Promise.all([Database.open(f.path), Database.open(f.path)]);
  try {
    for (const database of databases) {
      assert.equal(database.get("PRAGMA user_version")!.user_version, 16);
      const { supervisor_dispatches, supervisor_notes, supervisor_events, supervisor_positions, ...after } = contents(database);
      assert.deepEqual(after, before);
      assert.deepEqual(supervisor_notes, []);
      assert.deepEqual(supervisor_events, []);
      assert.deepEqual(supervisor_positions, []);
      assert.deepEqual(database.all("PRAGMA foreign_key_check"), []);
    }
    await appendNote(databases[0]!, supervisor, "goal", "After migration");
    assert.equal(readNotes(databases[1]!, "goal").length, 1);
  } finally { for (const database of databases) database.close(); }
});
