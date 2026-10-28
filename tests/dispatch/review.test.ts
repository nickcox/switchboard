import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { createReview } from "../../src/dispatch/review.ts";
import { describeStatus, status } from "../../src/dispatch/status.ts";
import { workerInput } from "../../src/attempts/specification.ts";
import { PiWorker } from "../../src/runtime/pi/worker.ts";
import { fixture, task } from "./fixture.ts";

const taskId = "review-a1";
const reviewContract = { kind: "artefact" as const, acceptance: "independent_deliverable" as const, requiredEvidence: [], requiredDeliverables: ["report"] };
const criteria = ["Keep the output", "Cover the edge case"];

async function completed() {
  const f = await fixture({ tasks: [task(taskId)], scenario: "commit-result", byTaskKind: { review: reviewContract } });
  await f.tasks.update(taskId, { acceptanceCriteria: criteria });
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
  const f = await completed();
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
    const specification = f.deps.attempts.findForTask(reviewId, 1)!.specification!;
    const allocation = f.deps.attempts.findForTask(reviewId, 1)!.allocation!;
    assert.equal(f.run(["branch", "--list", `switchboard-starting-points/*`]), "");
    assert.throws(() => workerInput(specification as Parameters<typeof workerInput>[0], allocation, f.first.attempt!.sessionId!), /allocation does not match/);
    assert.throws(() => workerInput(specification as Parameters<typeof workerInput>[0], { ...allocation, startingCommit: "c".repeat(40) }, randomUUID()), /allocation does not match/);
    assert.equal((await dispatchOnce(f.deps, { taskId: reviewId, requestId: "review-request" })).reason, "existing_request");
    assert.equal(f.deps.attempts.findForTask(taskId, 1)!.entries.filter(entry => entry.kind === "review_recorded").length, 1);
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

test("dispatch refuses when the reviewed output changes after review task creation", async () => {
  const f = await completed();
  try {
    const created = await createReview(f.deps, { taskId });
    f.run(["commit", "--allow-empty", "--no-gpg-sign", "-m", "Changed accepted output"], f.source.allocation!.workspace);
    const commit = f.run(["rev-parse", "HEAD"], f.source.allocation!.workspace);
    await f.deps.attempts.appendConfirmed(f.source, "output_accepted", { commit }, { fact: "output_accepted", scope: { commit } }, "operator:fixture");
    const outcome = await dispatchOnce(f.deps, { taskId: created.task!.id });
    assert.equal(outcome.reason, "refused", JSON.stringify(outcome));
    assert.match(outcome.detail!, /exact recorded target/);
    assert.equal(f.deps.attempts.findForTask(created.task!.id), undefined);
    assert.equal(f.deps.attempts.findForTask(taskId, 1)!.entries.some(entry => entry.kind === "review_recorded"), false);
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
      await f.deps.attempts.appendConfirmed(f.source, "output_accepted", { commit }, { fact: "output_accepted", scope: { commit } }, "operator:fixture");
      return report;
    };
    const outcome = await dispatchOnce(f.deps, { taskId: created.task!.id });
    assert.equal(outcome.reason, "stopped", JSON.stringify(outcome));
    assert.match(outcome.detail!, /exact output commit/);
    assert.equal(f.deps.attempts.findForTask(taskId, 1)!.entries.some(entry => entry.kind === "review_recorded"), false);
  } finally { f.tasks.close(); }
});
