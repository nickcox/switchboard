import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { createReview } from "../../src/dispatch/review.ts";
import { discard, finish } from "../../src/dispatch/finish.ts";
import { AttemptStore } from "../../src/attempts/store.ts";
import { briefing } from "../../src/supervise/briefing.ts";
import { defaultPermissions } from "../../src/objectives/store.ts";
import { describe } from "../../src/dispatch/result.ts";
import { describeStatus, status } from "../../src/dispatch/status.ts";
import { workerInput } from "../../src/attempts/specification.ts";
import { PiWorker } from "../../src/runtime/pi/worker.ts";
import { ObjectiveStore } from "../../src/objectives/store.ts";
import { fixture, task } from "./fixture.ts";

const taskId = "review-a1";
const reviewContract = { kind: "artefact" as const, acceptance: "independent_deliverable" as const, requiredEvidence: [], requiredDeliverables: ["report"] };
const criteria = ["Keep the output", "Cover the edge case"];

async function completed(withObjective = false) {
  const f = await fixture({ tasks: [task(taskId)], scenario: "commit-result", byTaskKind: { review: reviewContract } });
  if (withObjective) await new ObjectiveStore(f.tasks.database, f.deps.caller).add({ id: "goal", request: "Reviewed output", acceptanceCriteria: criteria });
  await f.tasks.update(taskId, { acceptanceCriteria: criteria, ...(withObjective ? { objectiveId: "goal" } : {}) });
  const first = await dispatchOnce(f.deps, { taskId });
  assert.equal(first.retention?.retained, true, JSON.stringify(first));
  const source = f.deps.attempts.findForTask(taskId, 1)!;
  return { ...f, first, source };
}

function reviewWorker(f: Awaited<ReturnType<typeof completed>>, scenario: string) {
  const worker = new PiWorker(f.runtime, {
    executable: process.execPath, entrypoint: resolve(import.meta.dirname, "../fixtures/pi-rpc.ts"), provider: "fixture", model: "fixture", shellTool: "bash",
    requestMs: 2000, runMs: 5000, stopMs: 600, environment: { ...f.environment, FAKE_PI_SCENARIO: scenario, FAKE_PI_LOG: resolve(f.dir, "review-requests.jsonl") },
  });
  f.deps.launch = (input, signal, onRequest) => worker.execute(input, signal, onRequest ? { onRequest } : {});
}

for (const verdict of ["passed", "failed"] as const) test(`a ${verdict} review starts at the exact output in a new session and records criterion findings`, async () => {
  const f = await completed(true);
  try {
    // Later task edits and source/target branch heads must not change what is reviewed.
    await f.tasks.update(taskId, { acceptanceCriteria: ["Later criterion"], body: "Later instructions" });
    f.run(["commit", "--allow-empty", "--no-gpg-sign", "-m", "Later source work"], f.source.allocation!.workspace);
    f.run(["commit", "--allow-empty", "--no-gpg-sign", "-m", "Later target work"]);
    const created = await createReview(f.deps, { taskId, attempt: 1 });
    assert.equal(created.reason, "review_created", JSON.stringify(created));
    const reviewId = created.task!.id;
    const review = (await f.tasks.read(reviewId))!;
    assert.equal(review.kind, "review");
    assert.deepEqual(review.acceptanceCriteria, criteria);
    for (const text of [taskId, "attempt 1", f.first.attempt!.resultCommit!, "each acceptance criterion", "criteriaReport", "Implement the fixture change"]) assert.ok(review.body.includes(text), text);
    assert.ok(!review.body.includes("Later instructions"));
    assert.equal((await f.runtime.discover(f.deps.contextId)).length, 1, "Creating a review launches nothing");
    reviewWorker(f, verdict === "passed" ? "review-pass" : "review-fail");
    const launch = f.deps.launch;
    f.deps.launch = async (input, ...rest) => {
      assert.equal(f.run(["rev-parse", "HEAD"], input.workspace), f.first.attempt!.resultCommit);
      assert.equal(input.delivery.startingCommit, f.first.attempt!.resultCommit);
      assert.notEqual(input.identity.sessionId, f.first.attempt!.sessionId);
      assert.notEqual(input.identity.leaseId, f.first.attempt!.leaseId);
      assert.notEqual(input.workspace, f.source.allocation!.workspace);
      assert.deepEqual(input.acceptanceCriteria, criteria);
      assert.equal(input.reviewTarget!.commit, f.first.attempt!.resultCommit);
      return launch(input, ...rest);
    };
    const outcome = await dispatchOnce(f.deps, { taskId: reviewId, requestId: "review-request" });
    assert.equal(outcome.reason, "done", JSON.stringify(outcome));
    const record = f.deps.attempts.findForTask(taskId, 1)!;
    const reviews = record.entries.filter(entry => entry.kind === "review_recorded");
    assert.equal(reviews.length, 1);
    assert.deepEqual(reviews[0]!.data, {
      taskId: reviewId, attempt: 1, commit: f.first.attempt!.resultCommit, verdict,
      findings: criteria.map((criterion, index) => ({ position: index + 1, criterion,
        status: verdict === "failed" && index === 0 ? "not_met" : "met", evidence: "Synthetic fixture evidence" })),
    });
    assert.equal((await f.tasks.read(taskId))!.held, true, "Review does not accept or repair the source task");
    const view = await status(f.deps);
    assert.deepEqual(view.attempts.find(attempt => attempt.attempt.taskId === taskId)!.reviews, reviews.map(entry => entry.data));
    assert.match(describeStatus(view), new RegExp(`Review ${reviewId} attempt 1: ${verdict}`));
    assert.ok(describeStatus(view).includes("Cover the edge case: met"));
    const evidence = view.attempts.find(attempt => attempt.attempt.taskId === taskId)!.acceptanceEvidence;
    assert.equal(evidence.commit, f.first.attempt!.resultCommit);
    assert.equal(evidence.permission.allowed, verdict === "passed", "No configured checks still requires a passed review");
    const specification = f.deps.attempts.findForTask(reviewId, 1)!.specification!;
    const allocation = f.deps.attempts.findForTask(reviewId, 1)!.allocation!;
    assert.equal(f.run(["branch", "--list", `switchboard-starting-points/*`]), "");
    assert.throws(() => workerInput(specification as Parameters<typeof workerInput>[0], allocation, f.first.attempt!.sessionId!), /allocation does not match/);
    assert.throws(() => workerInput(specification as Parameters<typeof workerInput>[0], { ...allocation, startingCommit: "c".repeat(40) }, randomUUID()), /allocation does not match/);
    assert.equal((await dispatchOnce(f.deps, { taskId: reviewId, requestId: "review-request" })).reason, "existing_request");
    assert.equal(f.deps.attempts.findForTask(taskId, 1)!.entries.filter(entry => entry.kind === "review_recorded").length, 1);
    const events = f.tasks.database.all("SELECT * FROM supervisor_events WHERE objective = 'goal' AND kind = 'review_recorded'");
    assert.equal(events.length, 1, "Replaying the review does not record another event");
    assert.equal(events[0]!.task, taskId);
    assert.equal(events[0]!.attempt, 1);
    assert.deepEqual(JSON.parse(String(events[0]!.details)), reviews[0]!.data);
    assert.equal(events[0]!.at, reviews[0]!.recordedAt);
    const commit = f.run(["rev-parse", "HEAD"], f.source.allocation!.workspace);
    await f.deps.attempts.appendConfirmed(f.source, "output_accepted", { commit }, { fact: "output_accepted", scope: { commit } });
    const changed = await status(f.deps);
    assert.equal(changed.attempts.find(attempt => attempt.attempt.taskId === taskId)!.reviews, undefined, "Old findings do not apply to a later output commit");
    assert.equal(f.deps.attempts.findForTask(taskId, 1)!.entries.filter(entry => entry.kind === "review_recorded").length, 1, "Historical findings are kept");
  } finally { f.tasks.close(); }
});

test("status and finish report exact-commit acceptance evidence without restricting the operator", async () => {
  const f = await completed();
  try {
    const created = await createReview(f.deps, { taskId });
    reviewWorker(f, "review-pass");
    assert.equal((await dispatchOnce(f.deps, { taskId: created.task!.id })).reason, "done");
    f.deps.checks = [{ name: "tests", command: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 5000 }];
    f.deps.checkEnvironment = f.environment;
    const before = await status(f.deps);
    assert.equal(before.attempts.find(attempt => attempt.attempt.taskId === taskId)!.acceptanceEvidence.permission.allowed, false);
    const leaseId = f.source.allocation!.leaseId;
    const plan = await finish(f.deps, { leaseId, noProcesses: false, dryRun: true });
    assert.equal(plan.reason, "planned", JSON.stringify(plan));
    assert.equal(plan.acceptanceEvidence!.permission.allowed, false, "A planned check is not evidence of a pass");
    const finished = await finish(f.deps, { leaseId, noProcesses: false });
    assert.equal(finished.reason, "finished", JSON.stringify(finished));
    assert.deepEqual(finished.acceptanceEvidence, { commit: f.first.attempt!.resultCommit, permission: { allowed: true } });
    assert.match(describe(finished), /Acceptance evidence for .*: sufficient/);
    const after = await status(f.deps);
    assert.deepEqual(after.attempts.find(attempt => attempt.attempt.taskId === taskId)!.acceptanceEvidence, finished.acceptanceEvidence);
    assert.match(describeStatus(after), /Acceptance evidence for .*: sufficient/);
    f.run(["commit", "--allow-empty", "--no-gpg-sign", "-m", "Later unreviewed output"], f.source.allocation!.workspace);
    const later = f.run(["rev-parse", "HEAD"], f.source.allocation!.workspace);
    const accepted = await finish(f.deps, { leaseId, noProcesses: false, acceptOutput: true });
    assert.equal(accepted.reason, "finished", JSON.stringify(accepted));
    assert.equal(accepted.acceptanceEvidence!.commit, later);
    assert.equal(accepted.acceptanceEvidence!.permission.allowed, false, "The operator can accept later output without a new review");
    assert.match(describe(accepted), /Acceptance evidence for .*: NOT sufficient.*no recorded review/);
    const changed = await status(f.deps);
    assert.deepEqual(changed.attempts.find(attempt => attempt.attempt.taskId === taskId)!.acceptanceEvidence, accepted.acceptanceEvidence);
  } finally { f.tasks.close(); }
});

test("dispatch from a failed review starts a repair at the reviewed commit with its findings", async () => {
  const f = await completed();
  try {
    const repairLaunch = f.deps.launch;
    const created = await createReview(f.deps, { taskId });
    reviewWorker(f, "review-fail");
    const reviewed = await dispatchOnce(f.deps, { taskId: created.task!.id });
    assert.equal(reviewed.reason, "done", JSON.stringify(reviewed));
    const source = f.deps.attempts.findForTask(taskId, 1)!;
    const review = source.entries.find(entry => entry.kind === "review_recorded")!.data;
    assert.equal(review.verdict, "failed");
    const commit = review.commit as string;
    f.run(["commit", "--allow-empty", "--no-gpg-sign", "-m", "Later unreviewed output"], source.allocation!.workspace);
    const later = f.run(["rev-parse", "HEAD"], source.allocation!.workspace);
    await f.tasks.release(taskId);
    let launches = 0;
    f.deps.launch = async (input, ...rest) => {
      launches++;
      assert.equal(input.delivery.startingCommit, commit);
      assert.equal(f.run(["rev-parse", "HEAD"], input.workspace), commit);
      assert.notEqual(input.delivery.startingCommit, later);
      assert.notEqual(input.identity.sessionId, f.first.attempt!.sessionId);
      assert.notEqual(input.identity.leaseId, source.allocation!.leaseId);
      assert.notEqual(input.workspace, source.allocation!.workspace);
      assert.ok(input.instructions.includes(JSON.stringify([review], null, 2)));
      return repairLaunch(input, ...rest);
    };
    const repaired = await dispatchOnce(f.deps, { taskId, startingPoint: { taskId, attempt: 1 }, requestId: "repair-request", note: "Repair the failed criterion" });
    assert.equal(repaired.retention?.retained, true, JSON.stringify(repaired));
    assert.equal(launches, 1);
    const repair = f.deps.attempts.findForTask(taskId, 2)!;
    assert.equal(repair.allocation!.startingCommit, commit);
    assert.equal(repair.specification!.startingPoint!.commit, commit);
    assert.ok(repair.specification!.handover!.includes("Repair the failed criterion"));
    assert.deepEqual(f.deps.attempts.findForTask(taskId, 1), source, "Repair leaves the source records unchanged");
    assert.equal(f.run(["rev-parse", source.allocation!.outputBranch]), later);
    assert.ok((await f.deps.workspaces.leases()).some(lease => lease.leaseId === source.allocation!.leaseId));
  } finally { f.tasks.close(); }
});

test("review command creates a queued review without requiring Pi to be installed", async () => {
  const f = await completed();
  try {
    const config = JSON.parse(readFileSync(f.config, "utf8"));
    config.worker.piEntrypoint = resolve(f.dir, "missing-pi.js");
    writeFileSync(f.config, JSON.stringify(config));
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "../../src/cli.ts"), "review", "--task", taskId, "--attempt", "1", "--config", f.config, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const created = JSON.parse(result.stdout);
    assert.equal(created.reason, "review_created");
    assert.equal((await f.tasks.read(created.task.id))!.kind, "review");
  } finally { f.tasks.close(); }
});

for (const kind of ["unrecorded", "not retained"] as const) test(`review refuses ${kind} output without creating a task`, async () => {
  const f = kind === "unrecorded" ? await fixture({ tasks: [task(taskId)], scenario: "failed", byTaskKind: { review: reviewContract } }) : await completed();
  try {
    if (kind === "unrecorded") await dispatchOnce(f.deps, { taskId });
    else f.run(["update-ref", "-d", `refs/heads/${f.deps.attempts.findForTask(taskId, 1)!.allocation!.outputBranch}`]);
    const before = await f.tasks.list();
    const created = await createReview(f.deps, { taskId });
    assert.equal(created.ok, false);
    assert.equal(created.observed.reason, kind === "unrecorded" ? "output_not_recorded" : "not_retained");
    assert.deepEqual(await f.tasks.list(), before);
  } finally { f.tasks.close(); }
});

test("a review reporting another commit is invalid and is never recorded against the reviewed attempt", async () => {
  const f = await completed();
  try {
    const created = await createReview(f.deps, { taskId });
    reviewWorker(f, "review-wrong-commit");
    const outcome = await dispatchOnce(f.deps, { taskId: created.task!.id });
    assert.equal(outcome.reason, "held", JSON.stringify(outcome));
    assert.equal(outcome.worker!.status, "failed");
    assert.equal(f.deps.attempts.findForTask(taskId, 1)!.entries.some(entry => entry.kind === "review_recorded"), false);
  } finally { f.tasks.close(); }
});

test("launch permission refuses a reviewer trying to reuse the source worker session", async () => {
  const f = await completed();
  try {
    const created = await createReview(f.deps, { taskId });
    reviewWorker(f, "review-pass");
    const launch = f.deps.launch;
    f.deps.launch = (input, ...rest) => launch({ ...input, identity: { ...input.identity, sessionId: f.first.attempt!.sessionId! } }, ...rest);
    const outcome = await dispatchOnce(f.deps, { taskId: created.task!.id });
    assert.equal(outcome.reason, "held", JSON.stringify(outcome));
    assert.equal(outcome.worker!.status, "not_started");
    assert.match(outcome.worker!.reason!, /separate worker session/);
    assert.equal((await f.runtime.discover(f.deps.contextId)).length, 1);
    assert.equal(f.deps.attempts.findForTask(taskId, 1)!.entries.some(entry => entry.kind === "review_recorded"), false);
  } finally { f.tasks.close(); }
});

test("dispatch refuses when the reviewed output changes after review task creation", async () => {
  const f = await completed();
  try {
    const created = await createReview(f.deps, { taskId });
    f.run(["commit", "--allow-empty", "--no-gpg-sign", "-m", "Changed accepted output"], f.source.allocation!.workspace);
    const commit = f.run(["rev-parse", "HEAD"], f.source.allocation!.workspace);
    await f.deps.attempts.appendConfirmed(f.source, "output_accepted", { commit }, { fact: "output_accepted", scope: { commit } });
    const outcome = await dispatchOnce(f.deps, { taskId: created.task!.id });
    assert.equal(outcome.reason, "refused", JSON.stringify(outcome));
    assert.match(outcome.detail!, /exact recorded target/);
    assert.equal(f.deps.attempts.findForTask(created.task!.id), undefined);
    assert.equal(f.deps.attempts.findForTask(taskId, 1)!.entries.some(entry => entry.kind === "review_recorded"), false);
  } finally { f.tasks.close(); }
});

test("review findings and task outcome roll back together, and finish refuses an unrecorded verdict", async () => {
  const f = await completed(true);
  try {
    const created = await createReview(f.deps, { taskId });
    const reviewId = created.task!.id;
    reviewWorker(f, "review-pass");
    await f.tasks.database.transaction(() => f.tasks.database.run(`CREATE TRIGGER fail_review_outcome BEFORE INSERT ON attempt_entries
      WHEN NEW.task = '${reviewId}' AND json_extract(NEW.entry, '$.kind') = 'task_recorded'
      BEGIN SELECT RAISE(ABORT, 'Injected outcome failure'); END`));
    const outcome = await dispatchOnce(f.deps, { taskId: reviewId });
    assert.equal(outcome.reason, "stopped", JSON.stringify(outcome));
    assert.equal((await f.tasks.read(reviewId))!.state, "in_flight");
    assert.equal(f.deps.attempts.findForTask(taskId, 1)!.entries.some(entry => entry.kind === "review_recorded"), false);
    assert.equal(f.tasks.database.all("SELECT * FROM supervisor_events WHERE kind = 'review_recorded'").length, 0, "The event rolls back with its source and the review outcome");
    await f.tasks.database.transaction(() => f.tasks.database.run("DROP TRIGGER fail_review_outcome"));
    const review = f.deps.attempts.findForTask(reviewId, 1)!;
    const runtime = (await f.runtime.discover(f.deps.contextId, { leaseId: review.allocation!.leaseId }))[0]!;
    writeFileSync(runtime.binding.resultPath, "Changed after validation");
    const finished = await finish(f.deps, { leaseId: review.allocation!.leaseId, noProcesses: false });
    assert.equal(finished.reason, "refused", JSON.stringify(finished));
    assert.match(finished.detail!, /without a recorded verdict; use discard/);
    assert.equal(f.deps.attempts.findForTask(taskId, 1)!.entries.filter(entry => entry.kind === "review_recorded").length, 0);
    assert.equal(f.tasks.database.all("SELECT * FROM supervisor_events WHERE kind = 'review_recorded'").length, 0);
    const discarded = await discard(f.deps, { leaseId: review.allocation!.leaseId, noProcesses: true, confirm: true });
    assert.equal(discarded.reason, "discarded", JSON.stringify(discarded));
    assert.match((await f.tasks.read(reviewId))!.holdReason!, /without a recorded verdict/);
  } finally { f.tasks.close(); }
});

test("a changed recorded output during review cannot receive findings for the old commit", async () => {
  const f = await completed();
  try {
    const created = await createReview(f.deps, { taskId });
    reviewWorker(f, "review-pass");
    const launch = f.deps.launch;
    f.deps.launch = async (input, ...rest) => {
      const report = await launch(input, ...rest);
      f.run(["commit", "--allow-empty", "--no-gpg-sign", "-m", "Changed accepted output"], f.source.allocation!.workspace);
      const commit = f.run(["rev-parse", "HEAD"], f.source.allocation!.workspace);
      await f.deps.attempts.appendConfirmed(f.source, "output_accepted", { commit }, { fact: "output_accepted", scope: { commit } });
      return report;
    };
    const outcome = await dispatchOnce(f.deps, { taskId: created.task!.id });
    assert.equal(outcome.reason, "stopped", JSON.stringify(outcome));
    assert.match(outcome.detail!, /exact output commit/);
    assert.equal(f.deps.attempts.findForTask(taskId, 1)!.entries.some(entry => entry.kind === "review_recorded"), false);
  } finally { f.tasks.close(); }
});

async function recordedReview(verdict: "pass" | "fail", withObjective = false) {
  const f = await completed(withObjective);
  f.deps.delivery.byTaskKind.review = f.deps.delivery.default;
  f.deps.policy = { git: "git", environment: f.environment, repository: f.deps.repository, baseRef: "main", globalFile: resolve(f.dir, "no-policy.json"), context: { kind: "local-merge", targetBranch: "main" } };
  const created = await createReview(f.deps, { taskId });
  reviewWorker(f, `review-commit-${verdict}`);
  const outcome = await dispatchOnce(f.deps, { taskId: created.task!.id });
  assert.equal(outcome.reason, "held", JSON.stringify(outcome));
  assert.equal(outcome.retention?.retained, true, JSON.stringify(outcome));
  const review = f.deps.attempts.findForTask(created.task!.id, 1)!;
  assert.equal(f.deps.attempts.reviewAttempt(review)!.recorded, true);
  return { ...f, review, leaseId: review.allocation!.leaseId };
}

for (const verdict of ["pass", "fail"] as const) test(`finish ends a ${verdict} review without accepting or integrating its commit`, async () => {
  const f = await recordedReview(verdict);
  try {
    const main = f.run(["rev-parse", "main"]);
    const branch = f.review.allocation!.outputBranch;
    const commit = f.run(["rev-parse", branch]);
    const before = f.deps.attempts.read(f.review);
    for (const noProcesses of [false, true]) {
      const plan = await finish(f.deps, { leaseId: f.leaseId, noProcesses, dryRun: true });
      assert.equal(plan.reason, "planned", JSON.stringify(plan));
      assert.match(plan.detail!, /record the review task as done without accepting or integrating/);
      assert.match(plan.detail!, noProcesses ? /return lease.*delete the review output branch/ : /retain lease/);
      assert.doesNotMatch(plan.detail!, /fast-forward|rebase|accept output commit/);
      assert.deepEqual(f.deps.attempts.read(f.review), before);
      assert.equal(f.run(["rev-parse", branch]), commit);
    }
    for (const flag of ["acceptOutput", "rebase"] as const) {
      for (const dryRun of [false, true]) {
        const refused = await finish(f.deps, { leaseId: f.leaseId, noProcesses: false, [flag]: true, dryRun });
        assert.equal(refused.reason, "refused");
        assert.match(refused.detail!, /Review output is evidence.*--accept-output and --rebase/);
      }
    }
    const finished = await finish(f.deps, { leaseId: f.leaseId, noProcesses: false });
    assert.equal(finished.reason, "finished", JSON.stringify(finished));
    assert.equal(finished.lease, "preserved");
    assert.equal((await f.tasks.read(f.review.taskId))!.state, "done");
    assert.equal(f.run(["rev-parse", branch]), commit);
    const returned = await finish(f.deps, { leaseId: f.leaseId, noProcesses: true });
    assert.equal(returned.reason, "finished", JSON.stringify(returned));
    assert.equal(returned.lease, "none");
    assert.equal(f.run(["branch", "--list", branch]), "");
    assert.equal(f.run(["rev-parse", "main"]), main);
    assert.equal(f.deps.attempts.read(f.review).entries.some(e => ["output_accepted", "integration_started", "integrated", "rebase_started", "output_rebased"].includes(e.kind)), false);
    assert.equal(f.deps.attempts.read(f.source).entries.filter(e => e.kind === "review_recorded").length, 1);
  } finally { f.tasks.close(); }
});

for (const verdict of ["pass", "fail"] as const) test(`discard completes a recorded ${verdict} review and keeps its verdict`, async () => {
  const f = await recordedReview(verdict);
  try {
    const before = f.deps.attempts.read(f.review);
    const source = f.deps.attempts.read(f.source);
    const plan = await discard(f.deps, { leaseId: f.leaseId, noProcesses: true, confirm: true, dryRun: true });
    assert.equal(plan.reason, "planned");
    assert.match(plan.detail!, /record the review task as done.*discarded/);
    assert.doesNotMatch(plan.detail!, /hold the task/);
    assert.deepEqual(f.deps.attempts.read(f.review), before);
    const discarded = await discard(f.deps, { leaseId: f.leaseId, noProcesses: true, confirm: true });
    assert.equal(discarded.reason, "discarded", JSON.stringify(discarded));
    assert.equal(discarded.lease, "none");
    assert.equal((await f.tasks.read(f.review.taskId))!.state, "done");
    assert.match(String([...f.deps.attempts.read(f.review).entries].reverse().find(e => e.kind === "task_recorded")!.data.reason), /Review recorded; attempt 1 discarded/);
    assert.equal(f.run(["branch", "--list", f.review.allocation!.outputBranch]), "");
    assert.deepEqual(f.deps.attempts.read(f.source), source);
  } finally { f.tasks.close(); }
});

for (const scenario of ["missing-result", "review-wrong-commit", "nonzero-exit", "startup-exit"] as const) test(`a review ending with ${scenario} is held for a decision, never ready`, async () => {
  const f = await completed(true);
  try {
    const created = await createReview(f.deps, { taskId });
    const reviewId = created.task!.id;
    reviewWorker(f, scenario);
    await dispatchOnce(f.deps, { taskId: reviewId });
    const review = f.deps.attempts.findForTask(reviewId, 1)!;
    const leaseId = review.allocation!.leaseId;
    const held = (await f.tasks.read(reviewId))!;
    assert.equal(held.state, "queued");
    assert.equal(held.held, true);
    assert.match(held.holdReason!, new RegExp(`without a recorded verdict for ${taskId} attempt 1`));
    assert.equal((await f.tasks.ready()).includes(reviewId), false);
    const view = await status(f.deps);
    assert.equal(view.ready.includes(reviewId), false);
    assert.equal(view.attempts.find(a => a.attempt.taskId === reviewId)!.state, "held");
    assert.match(describeStatus(view), /held: Review ended without a recorded verdict/);
    const brief = await briefing(f.deps, "goal");
    const shown = brief.tasks.find(t => t.id === reviewId)!;
    assert.equal(shown.held, true);
    assert.equal(shown.attempts[0]!.status, "held");
    assert.equal(shown.attempts[0]!.assessment!.nextAction.code, "inspect_attempt");
    assert.equal((await dispatchOnce(f.deps, {})).reason, "no_ready_work");
    for (const dryRun of [false, true]) {
      const refused = await finish(f.deps, { leaseId, noProcesses: false, dryRun });
      assert.equal(refused.reason, "refused");
      assert.match(refused.detail!, /use discard/);
    }
    const plan = await discard(f.deps, { leaseId, noProcesses: true, confirm: true, dryRun: true });
    assert.equal(plan.reason, "planned");
    assert.deepEqual(await f.tasks.read(reviewId), held);
    const discarded = await discard(f.deps, { leaseId, noProcesses: true, confirm: true });
    assert.equal(discarded.reason, "discarded", JSON.stringify(discarded));
    assert.equal((await f.tasks.read(reviewId))!.holdReason, held.holdReason);
    assert.equal((await f.tasks.read(reviewId))!.held, true);
    const fresh = await createReview(f.deps, { taskId });
    assert.equal(fresh.reason, "review_created", JSON.stringify(fresh));
    assert.notEqual(fresh.task!.id, reviewId);
    assert.equal((await f.tasks.ready()).includes(fresh.task!.id), true);
  } finally { f.tasks.close(); }
});

test("a supervisor finishes a recorded review with completeTasks alone, but cannot return its lease", async () => {
  const f = await recordedReview("fail", true);
  try {
    const objectives = new ObjectiveStore(f.tasks.database, f.deps.caller);
    await objectives.update("goal", { permissions: Object.fromEntries(Object.keys(defaultPermissions).map(key => [key, key === "completeTasks"])) as typeof defaultPermissions });
    const caller = { kind: "supervisor" as const, objectiveId: "goal" };
    const deps = { ...f.deps, caller, attempts: new AttemptStore(f.tasks.database, f.deps.contextId, caller) };
    const refused = await finish(deps, { leaseId: f.leaseId, noProcesses: true });
    assert.equal(refused.reason, "refused");
    assert.match(refused.detail!, /cannot.*return a lease/);
    const planned = await finish(deps, { leaseId: f.leaseId, noProcesses: false, dryRun: true });
    assert.equal(planned.reason, "planned", JSON.stringify(planned));
    const finished = await finish(deps, { leaseId: f.leaseId, noProcesses: false });
    assert.equal(finished.reason, "finished", JSON.stringify(finished));
    assert.equal(finished.lease, "preserved");
    const done = [...f.deps.attempts.read(f.review).entries].reverse().find(e => e.kind === "task_recorded")!;
    assert.equal(done.askedBy, "supervisor:goal");
    await objectives.update("goal", { permissions: { ...defaultPermissions, completeTasks: false } });
    assert.match((await finish(deps, { leaseId: f.leaseId, noProcesses: false })).detail!, /does not permit completeTasks/);
  } finally { f.tasks.close(); }
});
