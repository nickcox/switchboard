import assert from "node:assert/strict";
import test from "node:test";
import { assertRefused, assertRetained, assertSafe, assertSuccessful, completedResult, findAttempt } from "./assertions.ts";
import type { Interrupt, Request, ScenarioDriver } from "./contract.ts";
import type { FakeOwners } from "./owners.ts";

export type Fixture = { driver: ScenarioDriver; owners: FakeOwners; now: number; close(): Promise<void> };
export type CreateFixture = (options?: { maxAttempts?: number; interrupt?: Interrupt }) => Promise<Fixture>;
export function sampleRequest(id = "request-1", acceptance: Request["delivery"]["acceptance"] = "review"): Request {
  return {
    requestId: id, taskId: `task-${id}`,
    delivery: { outputBranch: `output/${id}`, requiredEvidence: ["tests"], requiredDeliverables: ["code"], acceptance },
  };
}

export async function finishWorker(fixture: Fixture, request: Request): Promise<void> {
  const attempt = await findAttempt(fixture.driver, request.requestId);
  const result = completedResult(attempt);
  await fixture.owners.exit(result);
  const controls = await fixture.owners.controls();
  await fixture.owners.setControls({
    ...controls, retainedCommit: result.commit,
    approvals: [{ id: "operator-approval", by: "operator", attemptId: attempt.id, leaseId: attempt.identity!.leaseId,
      commit: result.commit, expiresAt: fixture.now + 10_000, accept: true, noProcesses: true }],
  });
}

export async function acceptReview(fixture: Fixture, request: Request): Promise<void> {
  const attempt = await findAttempt(fixture.driver, request.requestId);
  if (request.delivery.acceptance === "review") await fixture.owners.review(attempt.id, "a".repeat(40), "accepted");
  else await fixture.owners.merge(attempt.id, "a".repeat(40));
}

// Register this exact suite against A and B later. It imports neither execution implementation.
// The process-restart/concurrency matrix needs an additional host fixture in step 5.
export function defineCommonTests(name: string, create: CreateFixture): void {
  const check = (title: string, run: (fixture: Fixture) => Promise<void>) => {
    test(`${name}: ${title}`, async t => {
      const fixture = await create();
      t.after(() => fixture.close());
      await run(fixture);
    });
  };

  for (const acceptance of ["review", "forge_merge"] as const) {
    check(`six steps with ${acceptance} and a lost client response`, async fixture => {
      const request = sampleRequest("happy", acceptance);
      const submitted = await fixture.driver.submit(request);
      assert.equal(submitted.status, "waiting");
      assert.deepEqual(await fixture.driver.submit(structuredClone(request)), submitted);
      const attempt = await findAttempt(fixture.driver, request.requestId);
      assert.equal(attempt.result, null, "Worker completion is not inferred from a host checkpoint");
      await assertRetained(fixture.driver, fixture.owners, request.requestId);
      await finishWorker(fixture, request);
      const waiting = await fixture.driver.advance(request.requestId);
      assert.equal(waiting.status, "waiting");
      if (waiting.status === "waiting") assert.equal(waiting.waitingFor, "review");
      assert.equal((await findAttempt(fixture.driver, request.requestId)).accepted, false);
      await acceptReview(fixture, request);
      const outcome = await fixture.driver.advance(request.requestId);
      await assertSuccessful(fixture.driver, fixture.owners, request, outcome);
      assert.deepEqual(await fixture.driver.submit(request), outcome);
      assert.deepEqual(await fixture.driver.advance(request.requestId), outcome);
      await assertSuccessful(fixture.driver, fixture.owners, request, outcome);
    });
  }

  check("a caller cannot reuse a request ID with changed inputs", async fixture => {
    const request = sampleRequest();
    await fixture.driver.submit(request);
    assertRefused(await fixture.driver.submit({ ...request, taskId: "different-task" }), "request_conflict");
    assert.equal((await fixture.driver.inspect()).attempts.length, 1);
    await assertSafe(fixture.driver, fixture.owners);
  });

  check("readiness refusal has no external effects or attempt", async fixture => {
    await fixture.owners.setControls({ ...await fixture.owners.controls(), ready: false });
    assertRefused(await fixture.driver.submit(sampleRequest()), "not_ready");
    assert.deepEqual(await fixture.owners.records(), []);
    assert.equal((await fixture.driver.inspect()).attempts.length, 0);
  });

  check("concurrent in-process submissions respect domain capacity", async fixture => {
    const outcomes = await Promise.all([fixture.driver.submit(sampleRequest("one")), fixture.driver.submit(sampleRequest("two"))]);
    assert.equal(outcomes.filter(outcome => outcome.status === "waiting").length, 1);
    assertRefused(outcomes.find(outcome => outcome.status === "refused")!, "capacity");
    assert.equal((await fixture.driver.inspect()).attempts.length, 1);
    await assertSafe(fixture.driver, fixture.owners);
  });

  check("a live or unobserved worker cannot be finalised", async fixture => {
    const request = sampleRequest();
    await fixture.driver.submit(request);
    const outcome = await fixture.driver.advance(request.requestId);
    assert.equal(outcome.status, "waiting");
    if (outcome.status === "waiting") assert.equal(outcome.waitingFor, "worker");
    await assertRetained(fixture.driver, fixture.owners, request.requestId);
  });

  for (const invalid of ["identity", "evidence", "deliverables", "branch", "outcome", "malformed"] as const) {
    check(`result validation refuses ${invalid}`, async fixture => {
      const request = sampleRequest();
      await fixture.driver.submit(request);
      const result = completedResult(await findAttempt(fixture.driver, request.requestId));
      if (invalid === "identity") result.identity.sessionId = "wrong-session";
      if (invalid === "evidence") result.evidence = [];
      if (invalid === "deliverables") result.deliverables = [];
      if (invalid === "branch") result.branch = "wrong-branch";
      if (invalid === "outcome") result.outcome = "hold";
      if (invalid === "malformed") Object.assign(result, { evidence: null });
      await fixture.owners.exit(result);
      assertRefused(await fixture.driver.advance(request.requestId), "invalid_result");
      await assertRetained(fixture.driver, fixture.owners, request.requestId);
    });
  }

  check("duplicate review signals produce one accepted transition", async fixture => {
    const request = sampleRequest();
    await fixture.driver.submit(request);
    await finishWorker(fixture, request);
    await acceptReview(fixture, request);
    await acceptReview(fixture, request);
    await assertSuccessful(fixture.driver, fixture.owners, request, await fixture.driver.advance(request.requestId));
    const attempt = await findAttempt(fixture.driver, request.requestId);
    assert.equal((await fixture.owners.counters(attempt.id)).review, 2, "The independent owner must preserve duplicate signals");
  });

  check("review rejection retains the lease", async fixture => {
    const request = sampleRequest();
    await fixture.driver.submit(request);
    await finishWorker(fixture, request);
    const attempt = await findAttempt(fixture.driver, request.requestId);
    await fixture.owners.review(attempt.id, "a".repeat(40), "rejected");
    assertRefused(await fixture.driver.advance(request.requestId), "review_rejected");
    await assertRetained(fixture.driver, fixture.owners, request.requestId);
  });

  for (const failure of ["missing", "expired", "scope", "model", "retention", "dirty", "processes", "unknown"] as const) {
    check(`finalisation refuses ${failure}`, async fixture => {
      const request = sampleRequest();
      await fixture.driver.submit(request);
      await finishWorker(fixture, request);
      await acceptReview(fixture, request);
      const controls = await fixture.owners.controls();
      const approval = controls.approvals[0]!;
      if (failure === "missing") controls.approvals = [];
      if (failure === "expired") approval.expiresAt = fixture.now;
      if (failure === "scope") approval.leaseId = "different-lease";
      // Deliberately inject untrusted owner data as well as model-controlled request arguments below.
      if (failure === "model") Object.assign(approval, { by: "model" });
      if (failure === "retention") controls.retainedCommit = "b".repeat(40);
      if (failure === "dirty") controls.clean = false;
      if (failure === "processes") approval.noProcesses = false;
      if (failure === "unknown") controls.unknown = true;
      await fixture.owners.setControls(controls);
      const code = failure === "retention" || failure === "dirty" ? "not_retained" : failure === "processes"
        ? "process_confirmation_required" : failure === "unknown" ? "owner_unknown" : "approval_required";
      assertRefused(await fixture.driver.advance(request.requestId), code);
      await assertRetained(fixture.driver, fixture.owners, request.requestId);
    });
  }

  check("model-controlled request arguments cannot grant approval", async fixture => {
    const request = { ...sampleRequest(), approval: { by: "operator", accept: true, noProcesses: true } };
    await fixture.driver.submit(request);
    await finishWorker(fixture, request);
    await acceptReview(fixture, request);
    await fixture.owners.setControls({ ...await fixture.owners.controls(), approvals: [] });
    assertRefused(await fixture.driver.advance(request.requestId), "approval_required");
    await assertRetained(fixture.driver, fixture.owners, request.requestId);
  });

  check("cancellation is not termination evidence or permission to return", async fixture => {
    const request = sampleRequest();
    await fixture.driver.submit(request);
    assertRefused(await fixture.driver.cancel(request.requestId), "cancelled");
    assertRefused(await fixture.driver.advance(request.requestId), "cancelled");
    assertRefused(await fixture.driver.cancel(request.requestId), "cancelled");
    const attempt = await findAttempt(fixture.driver, request.requestId);
    const counters = await fixture.owners.counters(attempt.id);
    assert.equal(counters.cancel, 1);
    assert.equal(counters.worker_exit, 0);
    await assertRetained(fixture.driver, fixture.owners, request.requestId);
  });
}
