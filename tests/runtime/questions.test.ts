import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { claimRequest, recordResult, unclaimedRequests } from "../../src/runtime/requests.ts";
import { maxQuestionBytes, pollQuestions, writeAnswerFile } from "../../src/runtime/questions.ts";
import { QuestionStore } from "../../src/runtime/questions-store.ts";
import { fixture, withRuntimeDatabase } from "../helpers.ts";

const caller = { kind: "person" as const, id: "operator:test" };
const document = { text: "Which design?", choices: ["Small", "Large"], waiting: true };

test("question polling records valid, malformed, oversized and invalid-schema files once, never adopting edits", async () => {
  const f = fixture();
  const record = await f.records.reserve(f.input);
  const directory = record.binding.input.questionsDirectory!;
  assert.ok(directory.startsWith(record.directory));
  assert.ok(!directory.startsWith(f.input.workspace));
  await writeFile(join(directory, "design.question.json"), JSON.stringify(document));
  await writeFile(join(directory, "malformed.question.json"), "{unfinished");
  await writeFile(join(directory, "oversized.question.json"), " ".repeat(maxQuestionBytes + 1));
  await writeFile(join(directory, "schema.question.json"), JSON.stringify({ text: "Missing waiting" }));
  await writeFile(join(directory, "ignored.tmp"), "not a question");
  await mkdir(join(directory, "directory.question.json"));
  await Promise.all([pollQuestions(record), pollQuestions(record)]);
  const selector = { contextId: f.input.identity.contextId, taskId: f.input.identity.taskId, attempt: 1 };
  const before = await record.storage.questions.list(selector);
  assert.equal(before.questions.length, 1);
  const question = before.questions[0]!;
  assert.deepEqual({ text: question.text, choices: question.choices, waiting: question.waiting }, document);
  assert.equal(question.attempt, 1);
  assert.match(question.id, /^[a-f0-9-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(question.askedAt)));
  assert.equal(before.invalid.length, 4);
  assert.match(before.invalid.find(file => file.filename === "oversized.question.json")!.diagnostic, /byte limit/);
  assert.match(before.invalid.find(file => file.filename === "directory.question.json")!.diagnostic, /regular JSON file/);
  await writeFile(join(directory, "design.question.json"), JSON.stringify({ text: "Changed", waiting: false }));
  await writeFile(join(directory, "malformed.question.json"), JSON.stringify(document));
  await pollQuestions(record);
  assert.deepEqual(await record.storage.questions.list(selector), before);
  await withRuntimeDatabase(f.records, async database => {
    await assert.rejects(database.transaction(() => database.run("UPDATE question_files SET document = '{}' WHERE id = ?", question.id)), /cannot be changed/);
  });
});

test("symlinked question files and directories are never read", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  const record = await f.records.reserve(f.input);
  const external = join(f.dir, "external.json");
  await writeFile(external, JSON.stringify(document));
  await symlink(external, join(record.binding.input.questionsDirectory!, "link.question.json"));
  await pollQuestions(record);
  const files = await record.storage.questions.list({ contextId: f.input.identity.contextId });
  assert.equal(files.questions.length, 0);
  assert.match(files.invalid[0]!.diagnostic, /regular JSON file/);
});

test("answering is atomic and single-use, addressed to the task, with file and request outcomes", async () => {
  const f = fixture();
  const record = await f.records.reserve(f.input);
  const filename = "design.question.json";
  await writeFile(join(record.binding.input.questionsDirectory!, filename), JSON.stringify(document));
  await pollQuestions(record);
  const store = record.storage.questions;
  const context = f.input.identity.contextId, task = f.input.identity.taskId;
  const question = (await store.list({ contextId: context })).questions[0]!;
  await assert.rejects(store.answer(context, task, "unknown", "Small", caller), /Unknown question/);
  await assert.rejects(store.answer(context, "other-task", question.id, "Small", caller), /Unknown question/);
  await assert.rejects(store.answer("other-context", task, question.id, "Small", caller), /Unknown question/);
  const attempts = await Promise.allSettled([
    store.answer(context, task, question.id, "Small", caller), store.answer(context, task, question.id, "Large", caller),
  ]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(attempts.filter(result => result.status === "rejected").length, 1);
  const answered = (await store.list({ contextId: context })).questions[0]!;
  assert.equal(answered.answer!.answeredBy, caller.id);
  const requests = await unclaimedRequests(record);
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.message!, new RegExp(question.id));
  assert.match(requests[0]!.message!, /guidance, not authority/);
  assert.equal(requests[0]!.questionId, question.id);
  await writeAnswerFile(store, record.directory, answered);
  const answerFile = JSON.parse(await readFile(join(record.binding.input.questionsDirectory!, "design.answer.json"), "utf8"));
  assert.equal(answerFile.questionId, question.id);
  assert.equal(answerFile.answer, answered.answer!.text);
  await pollQuestions(record);
  assert.equal((await store.list({ contextId: context })).questions.length, 1, "answer files are not questions");
  assert.equal(await claimRequest(record, requests[0]!.id, "dispatcher"), true);
  await recordResult(record, requests[0]!.id, { outcome: "steer:queued" });
  const final = (await store.list({ contextId: context })).questions[0]!;
  assert.deepEqual(final.answer!.deliveries.map(delivery => delivery.outcome), ["pending", "pending", "written", "steer:queued"]);
  await withRuntimeDatabase(f.records, async database => {
    await assert.rejects(database.transaction(() => database.run("UPDATE question_answers SET text = 'Changed' WHERE question_id = ?", question.id)), /cannot be changed/);
  });
});

test("questions remain open after an exit; late answers are retained and written, without a new request", async () => {
  const f = fixture();
  const record = await f.records.reserve(f.input);
  await writeFile(join(record.binding.input.questionsDirectory!, "late.question.json"), JSON.stringify({ text: "What next?", waiting: false }));
  await pollQuestions(record);
  await f.records.recordChildExit(record, { started: true, code: 0, signal: null });
  const store = new QuestionStore(f.records.databasePath);
  const context = f.input.identity.contextId;
  const question = (await store.list({ contextId: context })).questions[0]!;
  assert.equal(question.answer, undefined);
  const answered = await store.answer(context, f.input.identity.taskId, question.id, "Update the guide", caller);
  assert.equal(answered.question.answer!.requestId, undefined);
  await writeAnswerFile(store, record.directory, answered.question);
  assert.deepEqual(await unclaimedRequests(record), []);
  assert.deepEqual((await store.list({ contextId: context })).questions[0]!.answer!.deliveries.map(delivery => delivery.outcome), ["not_running", "pending", "written"]);
});
