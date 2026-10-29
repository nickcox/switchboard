import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Database } from "../../src/database.ts";
import { AttemptStore, SqliteTaskStore } from "../caller.ts";
import { requestFingerprint } from "../../src/attempts/requests.ts";
import { specificationFor } from "../helpers.ts";

const root = resolve(import.meta.dirname, "../../.investigation/request-records-unit");
mkdirSync(root, { recursive: true });
const at = "2026-10-20T00:00:00.000Z";

async function historical(change: (database: Database) => void) {
  const path = join(mkdtempSync(join(root, "case-")), "switchboard.db");
  const tasks = await SqliteTaskStore.open({ path });
  try {
    await tasks.add({ id: "first", title: "First" });
    await tasks.add({ id: "second", title: "Second" });
    await tasks.database.transaction(() => {
      for (const table of ["supervisor_notes", "answer_deliveries", "question_answers", "question_files", "worker_usage"]) tasks.database.run(`DROP TABLE ${table}`);
      tasks.database.run("DROP TABLE review_tasks");
      tasks.database.run("DROP TABLE request_records");
      tasks.database.run("DROP TRIGGER task_definition_changed");
      tasks.database.run("ALTER TABLE tasks DROP COLUMN acceptance_criteria");
      tasks.database.run(`CREATE TRIGGER task_definition_changed AFTER UPDATE OF title, body, repo, kind ON tasks
        WHEN NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body OR NEW.repo IS NOT OLD.repo OR NEW.kind IS NOT OLD.kind
        BEGIN UPDATE tasks SET definition_revision = OLD.definition_revision + 1 WHERE id = NEW.id; END`);
      tasks.database.run("DROP INDEX tasks_by_objective");
      tasks.database.run("ALTER TABLE tasks DROP COLUMN objective_id");
      tasks.database.run("DROP TABLE task_changes");
      tasks.database.run("DROP TABLE objective_changes");
      tasks.database.run("DROP TABLE objectives");
      tasks.database.run("PRAGMA user_version = 5");
      change(tasks.database);
    });
  } finally { tasks.close(); }
  return path;
}

function archive(database: Database, taskId: string, attempt: number, requestId: string, style: "reservation" | "summary" | "facts" = "reservation") {
  database.run("INSERT INTO attempt_numbers VALUES('context',?,?)", taskId, attempt);
  database.run("INSERT INTO archived_attempts VALUES('context',?,?,?)", taskId, attempt, JSON.stringify({
    contextId: "context", taskId, attempt, finishedAt: at, archivedAt: at,
    ...(style === "reservation" ? { reservation: { requestId, taskId, reservedAt: at } } : {}),
    summary: style === "summary" ? { requestId } : style === "facts" ? { facts: { requested: { data: { requestId } } } } : {},
  }));
}

test("fingerprint version 1 distinguishes automatic selection from an explicit task and ignores object key order", () => {
  assert.equal(requestFingerprint({}), requestFingerprint({}));
  assert.equal(requestFingerprint({ taskId: "first" }), requestFingerprint({ ...{ taskId: "first" } }));
  assert.notEqual(requestFingerprint({}), requestFingerprint({ taskId: "first" }));
  assert.notEqual(requestFingerprint({ taskId: "first" }), requestFingerprint({ taskId: "second" }));
});

test("migration retains orphan and attempt reservations without guessing historical explicit inputs", async () => {
  const path = await historical(database => {
    database.run("INSERT INTO attempts(context,task,request_id,reserved_at,closed) VALUES('context','first','orphan',?,1)", at);
    database.run("INSERT INTO attempt_numbers VALUES('context','second',1)");
    database.run("INSERT INTO attempts(context,task,number,request_id,reserved_at,closed) VALUES('context','second',1,'attempt',?,1)", at);
  });
  const database = await Database.open(path);
  try {
    const attempts = new AttemptStore(database, "context");
    assert.equal(database.all("SELECT * FROM request_records").length, 2);
    for (const [taskId, requestId] of [["first", "orphan"], ["second", "attempt"]]) {
      const row = database.get("SELECT * FROM request_records WHERE request_id = ?", requestId!)!;
      assert.equal(row.encoding_version, 0);
      assert.equal(row.fingerprint, null);
      await assert.rejects(attempts.reserveAttempt({ taskId: taskId!, requested: { requestId: requestId! }, maximum: 1, specification: specificationFor }), { reason: "request_reserved" });
      await assert.rejects(attempts.findByRequest(requestId!, { taskId: taskId === "first" ? "second" : "first" }), { reason: "request_input_mismatch" });
    }
    assert.equal(database.get("SELECT count(*) AS n FROM attempt_numbers")!.n, 1);
  } finally { database.close(); }
});

for (const style of ["reservation", "summary", "facts"] as const) test(`migration finds archived request IDs in ${style}`, async () => {
  const path = await historical(database => archive(database, "first", 1, "archived", style));
  const database = await Database.open(path);
  try {
    const attempts = new AttemptStore(database, "context");
    const found = await attempts.findByRequest("archived");
    assert.ok(found && "archived" in found);
    assert.equal(found.taskId, "first");
    assert.equal(found.attempt, 1);
    await assert.rejects(attempts.findByRequest("archived", { taskId: "second" }), { reason: "request_input_mismatch" });
    await assert.rejects(attempts.reserveAttempt({ taskId: "first", requested: { requestId: "archived" }, maximum: 1, specification: specificationFor }), { reason: "request_reserved" });
    assert.equal(database.get("SELECT count(*) AS n FROM attempts")!.n, 0);
  } finally { database.close(); }
});

for (const conflict of ["another task", "another attempt", "orphan task"] as const) test(`migration refuses conflicting historical mappings: ${conflict}`, async () => {
  const path = await historical(database => {
    archive(database, "first", 1, "conflict");
    if (conflict === "orphan task") database.run("INSERT INTO attempts(context,task,request_id,reserved_at,closed) VALUES('context','second','conflict',?,1)", at);
    else archive(database, conflict === "another task" ? "second" : "first", 2, "conflict");
  });
  await assert.rejects(Database.open(path), /Conflicting historical mappings/);
  const unchanged = await Database.open(path, 5000, { migrate: false });
  try {
    assert.equal(unchanged.get("PRAGMA user_version")!.user_version, 5);
    assert.equal(unchanged.get("SELECT name FROM sqlite_master WHERE name = 'request_records'"), undefined);
  } finally { unchanged.close(); }
});

for (const [field, value, reason] of [
  ["$.reservation.taskId", "second", /Conflicting historical identity/],
  ["$.requestId", "different", /Conflicting historical request IDs/],
  ["$.requestId", 123, /Invalid historical request ID/],
] as const) test(`migration refuses an inconsistent archived request: ${field} = ${value}`, async () => {
  const path = await historical(database => {
    archive(database, "first", 1, "request");
    database.run("UPDATE archived_attempts SET summary = json_set(summary, ?, ?)", field, value);
  });
  await assert.rejects(Database.open(path), reason);
});

test("migration joins an orphan reservation to its archived attempt when their task agrees", async () => {
  const path = await historical(database => {
    database.run("INSERT INTO attempts(context,task,request_id,reserved_at,closed) VALUES('context','first','same',?,1)", at);
    archive(database, "first", 1, "same");
  });
  const database = await Database.open(path);
  try {
    const found = await new AttemptStore(database, "context").findByRequest("same");
    assert.ok(found && "archived" in found);
    assert.equal(found.attempt, 1);
    assert.equal(database.get("SELECT count(*) AS n FROM request_records")!.n, 1);
  } finally { database.close(); }
});
