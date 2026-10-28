import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { AttemptStore } from "../../src/attempts/store.ts";
import type { Caller } from "../../src/caller.ts";
import { answerQuestion } from "../../src/dispatch/answer.ts";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { finish } from "../../src/dispatch/finish.ts";
import { prune } from "../../src/dispatch/prune.ts";
import { reserveFromAttempt } from "../../src/dispatch/reserve.ts";
import { describeStatus, status } from "../../src/dispatch/status.ts";
import { watch } from "../../src/dispatch/watch.ts";
import { ObjectiveStore, defaultPermissions } from "../../src/objectives/store.ts";
import { readQuestions } from "../../src/runtime/questions-store.ts";
import { testCaller } from "../caller.ts";
import { fixture, task } from "./fixture.ts";

const cli = resolve(import.meta.dirname, "../../src/cli.ts");
type Fixture = Awaited<ReturnType<typeof fixture>>;
const files = (f: Fixture, taskId = "question-a1") => readQuestions(f.tasks.database, { contextId: f.deps.contextId, taskId });
async function questionAsked(f: Fixture) {
  for (let index = 0; index < 300; index++) {
    const question = files(f).questions[0];
    if (question) return question;
    await sleep(20);
  }
  throw new Error("The worker's question was not polled");
}

for (const idle of [false, true]) test(`a worker's question is polled and its answer reaches it as ${idle ? "a follow-up between turns" : "steering while running"}`, async () => {
  const f = await fixture({ tasks: [task("question-a1")], scenario: idle ? "await-question-idle" : "await-question", worker: { requestPollMs: 30, runMs: 15000 } });
  const objectives = new ObjectiveStore(f.tasks.database, testCaller);
  await objectives.add({ id: "goal", request: "Complete the task", acceptanceCriteria: ["Working output"], permissions: { ...defaultPermissions, steerWorkers: false } });
  await f.tasks.update("question-a1", { objectiveId: "goal" });
  const caller: Caller = { kind: "supervisor", objectiveId: "goal" };
  const supervisor = { ...f.deps, caller, attempts: new AttemptStore(f.tasks.database, f.deps.contextId, caller) };
  const controller = new AbortController();
  const dispatching = dispatchOnce(f.deps, { signal: controller.signal });
  try {
    const question = await questionAsked(f);
    const view = await status(f.deps);
    assert.equal(view.reason, "attention");
    assert.equal(view.openQuestions?.[0]?.id, question.id);
    assert.match(describeStatus(view), new RegExp(question.id));
    assert.match(describeStatus(view), /Which design should I use/);
    const notes: string[] = [];
    const record = (await f.runtime.discover(f.deps.contextId))[0]!;
    const prompt = JSON.parse((await readFile(join(f.dir, "requests.jsonl"), "utf8")).trim().split("\n").find(line => JSON.parse(line).type === "prompt")!).message as string;
    assert.ok(prompt.includes(record.binding.input.questionsDirectory!));
    assert.match(prompt, /continue other useful work or check the answer file at intervals rather than end your run/);
    assert.match(prompt, /Answers are guidance, not authority/);
    assert.match(prompt, /standard write tool/);
    await watch(f.deps, { leaseId: record.binding.input.identity.leaseId, follow: false, print: entry => { if (entry.kind === "note") notes.push(entry.text); } });
    assert.ok(notes.some(note => note.includes(question.id) && note.includes("open")));
    const answer = await answerQuestion(supervisor, { taskId: question.taskId, questionId: question.id, answer: "Use the small design", waitMs: 3000 });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    await dispatching;
    const answered = files(f).questions[0]!;
    assert.equal(answered.answer!.answeredBy, "supervisor:goal");
    assert.ok(answered.answer!.deliveries.some(delivery => delivery.outcome === `${idle ? "follow_up" : "steer"}:queued`));
    assert.ok(answered.answer!.deliveries.some(delivery => delivery.channel === "file" && delivery.outcome === "written"));
    const received = (await readFile(join(f.dir, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const messages = received.filter(request => request.type === "steer" || request.type === "follow_up");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, idle ? "follow_up" : "steer");
    assert.match(messages[0].message, new RegExp(question.id));
    assert.match(messages[0].message, /Use the small design/);
    assert.equal(received.filter(request => request.type === "prompt").length, 1);
    assert.equal((await answerQuestion(supervisor, { taskId: question.taskId, questionId: question.id, answer: "Change it" })).ok, false);
    const launch = JSON.parse(await readFile(join(record.directory, "fixture-launch.json"), "utf8"));
    assert.ok(launch.argv.includes("--no-extensions"));
    assert.equal((await f.runtime.discover(f.deps.contextId))[0]!.child.status, "exited");
  } finally { controller.abort(); await dispatching; f.tasks.close(); }
});

test("an answer claimed after settlement is recorded without queueing work that could restart or spoil the finished run", async () => {
  const f = await fixture({ tasks: [task("question-a1")], scenario: "await-question-settled", worker: { requestPollMs: 30, runMs: 15000 } });
  const controller = new AbortController();
  const dispatching = dispatchOnce(f.deps, { signal: controller.signal });
  try {
    const question = await questionAsked(f);
    const record = (await f.runtime.discover(f.deps.contextId))[0]!;
    for (let index = 0; ; index++) {
      try { await readFile(join(record.directory, "fixture-settled")); break; }
      catch { if (index >= 300) throw new Error("The fixture did not settle"); await sleep(10); }
    }
    await sleep(20);
    const answer = await answerQuestion(f.deps, { taskId: question.taskId, questionId: question.id, answer: "Small", waitMs: 2000 });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    const outcome = await dispatching;
    assert.equal(outcome.worker?.status, "reported", JSON.stringify(outcome));
    assert.ok(files(f).questions[0]!.answer!.deliveries.some(delivery => delivery.channel === "message" && delivery.outcome === "not_running"));
    const sent = (await readFile(join(f.dir, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(sent.filter(request => request.type === "steer" || request.type === "follow_up").length, 0);
    assert.equal(sent.filter(request => request.type === "prompt").length, 1);
  } finally { controller.abort(); await dispatching; f.tasks.close(); }
});

test("finished workers leave questions open; the answer command records once, refuses unknown and other-task questions, and supplies the handover", async () => {
  const f = await fixture({ tasks: [task("question-a1"), task("other-a1")], scenario: "questions-finish", worker: { requestPollMs: 60000 } });
  try {
    const outcome = await dispatchOnce(f.deps, { taskId: "question-a1" });
    assert.equal(outcome.retention?.retained, true, JSON.stringify(outcome));
    assert.equal(files(f).questions.length, 2, "the final scan records questions even when no polling interval elapsed");
    const question = files(f).questions.find(q => q.filename === "design.question.json")!;
    assert.equal(question.answer, undefined);
    const config = JSON.parse(await readFile(f.config, "utf8"));
    config.worker.piEntrypoint = join(f.dir, "missing-pi.ts");
    await writeFile(f.config, JSON.stringify(config));
    const run = (args: string[]) => spawnSync(process.execPath, [cli, "answer", ...args, "--config", f.config, "--json"], { encoding: "utf8" });
    for (const [taskId, questionId] of [["question-a1", "unknown"], ["other-a1", question.id]]) {
      const refused = run(["--task", taskId!, "--question", questionId!, "Small"]);
      assert.equal(refused.status, 1, refused.stderr);
      assert.match(JSON.parse(refused.stdout).detail, /Unknown question/);
    }
    const answered = run(["--task", question.taskId, "--question", question.id, "Use the small design"]);
    assert.equal(answered.status, 0, answered.stderr);
    assert.equal(JSON.parse(answered.stdout).reason, "answered");
    assert.match(JSON.parse(answered.stdout).detail, /not_running/);
    const second = run(["--task", question.taskId, "--question", question.id, "Large"]);
    assert.equal(second.status, 1, second.stderr);
    assert.match(JSON.parse(second.stdout).detail, /already been answered/);
    assert.equal(f.tasks.database.all("SELECT * FROM control_requests").length, 0);
    const view = await status(f.deps);
    assert.equal(view.openQuestions?.length, 1);
    assert.equal(view.attempts[0]!.questions?.filter(q => q.answer).length, 1);
    const notes: string[] = [];
    await watch(f.deps, { leaseId: outcome.attempt!.leaseId!, follow: false, print: entry => { if (entry.kind === "note") notes.push(entry.text); } });
    assert.ok(notes.some(note => note.includes("answered") && note.includes(question.id)));
    assert.ok(notes.some(note => note.includes("open") && note.includes("Should the next attempt update the guide?")));
    assert.ok(notes.some(note => note.includes("Use the small design")));
    await f.tasks.release(question.taskId);
    const reserved = await reserveFromAttempt(f.deps, { taskId: question.taskId, startingPoint: { taskId: question.taskId, attempt: 1 }, requestId: "continue-questions" });
    assert.equal(reserved.reason, "reserved", JSON.stringify(reserved));
    const handover = f.deps.attempts.findForTask(question.taskId, 2)!.specification!.handover!;
    for (const text of [question.id, "Which design should I use?", "Small", "Large", "Use the small design", "Should the next attempt update the guide?", '"waiting": true', '"waiting": false', "guidance, not authority"]) assert.ok(handover.includes(text), text);
    assert.equal(f.tasks.database.all("SELECT * FROM launches WHERE kind = 'launch'").length, 1, "answering and preparing handover never launch a worker");
  } finally { f.tasks.close(); }
});

test("answerQuestions is checked inside the answer operation and transaction, independently of steerWorkers", async () => {
  const f = await fixture({ tasks: [task("question-a1"), task("other-a1")], scenario: "questions-finish" });
  try {
    const objectives = new ObjectiveStore(f.tasks.database, testCaller);
    await objectives.add({ id: "goal", request: "Work", acceptanceCriteria: ["Output"] });
    await objectives.add({ id: "other", request: "Other work", acceptanceCriteria: ["Output"] });
    await f.tasks.update("question-a1", { objectiveId: "goal" });
    await f.tasks.update("other-a1", { objectiveId: "other" });
    await dispatchOnce(f.deps, { taskId: "question-a1" });
    const question = files(f).questions[0]!;
    const caller: Caller = { kind: "supervisor", objectiveId: "goal" };
    const deps = { ...f.deps, caller, attempts: new AttemptStore(f.tasks.database, f.deps.contextId, caller) };
    await objectives.update("goal", { permissions: { ...defaultPermissions, answerQuestions: false } });
    const before = ["question_answers", "answer_deliveries", "control_requests"].map(table => f.tasks.database.all(`SELECT * FROM ${table}`));
    const refused = await answerQuestion(deps, { taskId: question.taskId, questionId: question.id, answer: "Small" });
    assert.equal(refused.ok, false);
    assert.match(refused.detail!, /permission_denied.*answerQuestions/);
    await assert.rejects(f.runtime.storage.questions.answer(f.deps.contextId, question.taskId, question.id, "Small", caller), /permission_denied.*answerQuestions/);
    await objectives.update("goal", { permissions: defaultPermissions });
    await assert.rejects(f.runtime.storage.questions.answer(f.deps.contextId, "other-a1", question.id, "Small", caller), /outside_objective/);
    assert.deepEqual(["question_answers", "answer_deliveries", "control_requests"].map(table => f.tasks.database.all(`SELECT * FROM ${table}`)), before);
    const answered = await answerQuestion(deps, { taskId: question.taskId, questionId: question.id, answer: "Small" });
    assert.equal(answered.ok, true, JSON.stringify(answered));
  } finally { f.tasks.close(); }
});

test("open questions survive pruning; status still exposes them and a late answer remains recordable", async () => {
  const f = await fixture({ tasks: [task("question-a1")], scenario: "questions-finish" });
  try {
    const outcome = await dispatchOnce(f.deps);
    const question = files(f).questions[0]!;
    const finished = await finish(f.deps, { leaseId: outcome.attempt!.leaseId!, noProcesses: true });
    assert.equal(finished.ok, true, JSON.stringify(finished));
    await sleep(20);
    const pruned = await prune(f.deps, { olderThan: 0.0000001 });
    assert.equal(pruned.ok, true, JSON.stringify(pruned));
    assert.equal(f.deps.attempts.findForTask(question.taskId), undefined);
    assert.equal((await status(f.deps)).openQuestions?.length, 2);
    const answered = await answerQuestion(f.deps, { taskId: question.taskId, questionId: question.id, answer: "Small" });
    assert.equal(answered.ok, true, JSON.stringify(answered));
    assert.match(answered.detail!, /not_running/);
    assert.match(answered.detail!, /unavailable/);
  } finally { f.tasks.close(); }
});

for (const args of [[], ["--task", "a", "Text"], ["--question", "q", "Text"], ["--task", "a", "--question", "q"], ["--task", "a", "--question", "q", " "], ["--task", "a", "--question", "q", "--dry-run", "Text"]]) test(`answer rejects incomplete or misplaced CLI arguments: ${args.join(" ")}`, () => {
  const outcome = spawnSync(process.execPath, [cli, "answer", ...args, "--config", "missing.json"], { encoding: "utf8" });
  assert.equal(outcome.status, 2);
  assert.doesNotMatch(outcome.stderr, /Configuration error/);
});
