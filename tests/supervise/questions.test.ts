import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Database } from "../../src/database.ts";
import { ObjectiveStore, defaultPermissions } from "../../src/objectives/store.ts";
import { askPerson, answerPersonQuestion, readPersonQuestions } from "../../src/supervise/questions.ts";
import { waitForEvent } from "../../src/supervise/events.ts";
import { appendNote } from "../../src/supervise/notes.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";

const person = { kind: "person", id: "operator:creator" } as const;
const supervisor = { kind: "supervisor", objectiveId: "goal" } as const;
const root = resolve(".investigation/person-questions");
mkdirSync(root, { recursive: true });

async function fixture() {
  const path = join(realpathSync(mkdtempSync(join(root, "case-"))), "switchboard.db");
  const tasks = await SqliteTaskStore.open({ caller: person, path });
  const objectives = new ObjectiveStore(tasks.database, person);
  await objectives.add({ id: "goal", request: "Do useful work", acceptanceCriteria: ["Useful output"] });
  await objectives.add({ id: "other", request: "Other work", acceptanceCriteria: ["Other output"] });
  return { path, tasks, database: tasks.database, objectives };
}

function contents(database: Database) {
  return Object.fromEntries(database.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map(row => [String(row.name), database.all(`SELECT * FROM ${row.name}`)]));
}

test("questions retain exact text, choices, identity and time; concurrent request replays and restarts keep one question", async () => {
  const f = await fixture();
  const second = await Database.open(f.path);
  try {
    await f.objectives.update("goal", { permissions: Object.fromEntries(Object.keys(defaultPermissions).map(key => [key, false])) as typeof defaultPermissions });
    const questions = await Promise.all([f.database, second].map(database => askPerson(database, supervisor, "goal", "  Which design?\n", ["Small", "Large"], "stable")));
    assert.deepEqual(questions[0], questions[1]);
    const question = questions[0]!;
    assert.equal(question.text, "  Which design?\n");
    assert.deepEqual(question.choices, ["Small", "Large"]);
    assert.equal(question.objectiveId, "goal");
    assert.equal(question.askedBy, "supervisor:goal");
    assert.ok(question.id);
    assert.ok(Number.isFinite(Date.parse(question.askedAt)));
    assert.equal(readPersonQuestions(f.database).length, 1);
    await assert.rejects(askPerson(f.database, supervisor, "goal", "Different", ["Small", "Large"], "stable"), /different question/);
    await assert.rejects(askPerson(f.database, supervisor, "goal", question.text, ["Different"], "stable"), /different question/);
    const other = await askPerson(f.database, { kind: "supervisor", objectiveId: "other" }, "other", "Other?", undefined, "stable");
    assert.notEqual(other.id, question.id);
    assert.deepEqual(f.objectives.show("goal").openPersonQuestions, [question]);
  } finally { second.close(); f.tasks.close(); }
  const reopened = await Database.open(f.path);
  try { assert.equal(readPersonQuestions(reopened, "goal")[0]!.text, "  Which design?\n"); }
  finally { reopened.close(); }
});

test("only the bound supervisor asks; only a person answers once for the matching objective", async () => {
  const f = await fixture();
  try {
    await assert.rejects(askPerson(f.database, person, "goal", "No?"), /Only the objective's supervisor/);
    await assert.rejects(askPerson(f.database, supervisor, "other", "No?"), /Only the objective's supervisor/);
    await assert.rejects(askPerson(f.database, supervisor, "missing", "No?"), /Only the objective's supervisor/);
    await assert.rejects(askPerson(f.database, supervisor, "goal", " \n "), /must not be blank/);
    await assert.rejects(askPerson(f.database, supervisor, "goal", "Question?", [" "]), /must not be blank/);
    const question = await askPerson(f.database, supervisor, "goal", "Which design?");
    await assert.rejects(answerPersonQuestion(f.database, supervisor, "goal", question.id, "Small"), /Only a person/);
    await assert.rejects(answerPersonQuestion(f.database, person, "other", question.id, "Small"), /Unknown question/);
    await assert.rejects(answerPersonQuestion(f.database, person, "goal", "missing", "Small"), /Unknown question/);
    await assert.rejects(answerPersonQuestion(f.database, person, "goal", question.id, " \n"), /must not be blank/);
    const result = await answerPersonQuestion(f.database, person, "goal", question.id, "Small, please");
    assert.equal(result.answer!.text, "Small, please");
    assert.equal(result.answer!.answeredBy, "operator:creator");
    assert.ok(Number.isFinite(Date.parse(result.answer!.answeredAt)));
    await assert.rejects(answerPersonQuestion(f.database, person, "goal", question.id, "Large"), /already answered by operator:creator.*Small, please/);
    assert.deepEqual(readPersonQuestions(f.database, "goal"), [result]);
    assert.deepEqual(f.objectives.show("goal").openPersonQuestions, []);
    const interventions = f.objectives.show("goal").personInterventions.items;
    assert.equal(interventions.length, 1);
    assert.equal(interventions[0]!.action, "answer");
    const event = (await waitForEvent(f.database, supervisor, "goal", 0)).event!;
    assert.equal(event.kind, "person_answered");
    assert.deepEqual(event.details, { questionId: question.id, question: question.text, answer: result.answer });
    assert.equal(f.database.all("SELECT * FROM supervisor_events").length, 1);
    const late = await askPerson(f.database, supervisor, "goal", "A late answer?", undefined, "late");
    await f.objectives.abandon("goal");
    await assert.rejects(askPerson(f.database, supervisor, "goal", "No?"), /must be open|abandoned/);
    const lateAnswer = await answerPersonQuestion(f.database, { kind: "person", id: "operator:another" }, "goal", late.id, "Still useful");
    assert.equal(lateAnswer.answer!.answeredBy, "operator:another");
    assert.equal(f.objectives.show("goal").state, "abandoned");
  } finally { f.tasks.close(); }
});

test("questions and answers cannot be changed, removed or replaced; answer and event roll back together", async () => {
  const f = await fixture();
  try {
    const question = await askPerson(f.database, supervisor, "goal", "Which design?");
    await f.database.transaction(() => f.database.run(`CREATE TRIGGER fail_answer_event BEFORE INSERT ON supervisor_events
      WHEN NEW.kind = 'person_answered' BEGIN SELECT RAISE(ABORT, 'Injected event failure'); END`));
    await assert.rejects(answerPersonQuestion(f.database, person, "goal", question.id, "Small"), /Injected event failure/);
    assert.deepEqual(readPersonQuestions(f.database, "goal"), [question]);
    assert.equal(f.database.all("SELECT * FROM supervisor_events").length, 0);
    await f.database.transaction(() => f.database.run("DROP TRIGGER fail_answer_event"));
    const second = await Database.open(f.path);
    try {
      const results = await Promise.allSettled([f.database, second].map(database => answerPersonQuestion(database, person, "goal", question.id, "Small")));
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(results.filter(result => result.status === "rejected").length, 1);
    } finally { second.close(); }
    const before = contents(f.database);
    for (const table of ["person_questions", "person_answers"]) {
      for (const sql of [`UPDATE ${table} SET text = 'Changed'`, `DELETE FROM ${table}`, `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`]) {
        await assert.rejects(f.database.transaction(() => f.database.run(sql)), /cannot be/);
      }
    }
    assert.deepEqual(contents(f.database), before);
  } finally { f.tasks.close(); }
});

test("schema 16 migrates concurrently to 17 without changing existing data", async () => {
  const f = await fixture();
  await f.tasks.add({ id: "work", title: "Keep this task", objectiveId: "goal", acceptanceCriteria: ["Keep this criterion"] });
  await f.tasks.hold("work", "Keep this hold");
  await f.objectives.update("goal", { scope: "Keep this scope", budget: { maxCost: 10, maxWorkerTimeMs: 2000 } });
  await appendNote(f.database, supervisor, "goal", "Keep this note");
  await f.database.transaction(() => {
    f.database.run(`INSERT INTO supervisor_dispatches(context,request_id,caller,inputs,fingerprint,config_path,runtime_root,output_path,recorded_at,process_pid,result)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, "context", "keep-request", JSON.stringify(supervisor), JSON.stringify({ taskId: "work" }), "keep-fingerprint",
      join(root, "config.json"), root, "supervisor-dispatches/keep/output.log", new Date().toISOString(), 123, JSON.stringify({ ok: false, reason: "held" }));
    f.database.run("DROP TABLE person_answers");
    f.database.run("DROP TABLE person_questions");
    f.database.run("PRAGMA user_version = 16");
  });
  const before = contents(f.database);
  f.tasks.close();
  const databases = await Promise.all([Database.open(f.path), Database.open(f.path)]);
  try {
    for (const database of databases) {
      assert.equal(database.get("PRAGMA user_version")!.user_version, 17);
      const { person_questions, person_answers, ...after } = contents(database);
      assert.deepEqual(after, before);
      assert.deepEqual(person_questions, []);
      assert.deepEqual(person_answers, []);
      assert.deepEqual(database.all("PRAGMA foreign_key_check"), []);
    }
    await askPerson(databases[0]!, supervisor, "goal", "After migration?");
    assert.equal(readPersonQuestions(databases[1]!, "goal").length, 1);
  } finally { for (const database of databases) database.close(); }
});
