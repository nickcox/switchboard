import assert from "node:assert/strict";
import type { Attempt, Outcome, RefusalCode, Request, ScenarioDriver, WorkerResult } from "./contract.ts";
import { validResult } from "./contract.ts";
import type { FakeOwners } from "./owners.ts";

export function assertRefused(outcome: Outcome, code: RefusalCode): void {
  assert.equal(outcome.status, "refused");
  if (outcome.status !== "refused") return;
  assert.equal(outcome.code, code);
  assert.ok(outcome.nextAction.trim(), "A refusal must name an operator action");
}

export async function findAttempt(driver: ScenarioDriver, requestId: string): Promise<Attempt> {
  const matches = (await driver.inspect()).attempts.filter(attempt => attempt.request.requestId === requestId);
  assert.equal(matches.length, 1, "A stable request ID reserves exactly one attempt");
  return matches[0]!;
}

export async function assertSafe(driver: ScenarioDriver, owners: FakeOwners): Promise<void> {
  const snapshot = await driver.inspect();
  assert.ok(snapshot.active >= 0 && snapshot.active <= snapshot.maxAttempts, "Domain capacity is never exceeded");
  assert.equal(new Set(snapshot.attempts.map(attempt => attempt.id)).size, snapshot.attempts.length);
  assert.equal(new Set(snapshot.attempts.map(attempt => attempt.request.requestId)).size, snapshot.attempts.length);
  const records = await owners.records();
  // Count even effects whose acknowledgement/attempt is absent from host state.
  for (const attemptId of new Set(records.map(record => record.attemptId))) {
    const counters = await owners.counters(attemptId);
    for (const effect of ["acquire", "launch", "prompt", "return", "merge", "cancel"] as const) {
      assert.ok(counters[effect] <= 1, `${attemptId}: ${effect} happened more than once`);
    }
    assert.ok(counters.prompt <= counters.launch, "A prompt requires a launch");
    assert.ok(counters.launch <= counters.acquire, "A launch requires a workspace");
    if (counters.return) {
      assert.equal(counters.worker_exit, 1, "Return requires positive worker exit evidence, not absence of liveness");
      const attempt = snapshot.attempts.find(value => value.id === attemptId);
      assert.ok(attempt?.done && attempt.accepted && attempt.result, "Return requires recorded acceptance and task completion");
      assert.ok(validResult(attempt.result, attempt));
    }
  }
}

export async function assertSuccessful(driver: ScenarioDriver, owners: FakeOwners, request: Request, outcome: Outcome): Promise<void> {
  assert.equal(outcome.status, "completed");
  const attempt = await findAttempt(driver, request.requestId);
  assert.equal(outcome.attemptId, attempt.id);
  assert.deepEqual(attempt.request, request);
  assert.ok(attempt.started && attempt.launched && attempt.prompted && attempt.reviewAccepted && attempt.accepted && attempt.done && attempt.returned);
  assert.ok(attempt.result && validResult(attempt.result, attempt));
  const counters = await owners.counters(attempt.id);
  assert.equal(counters.acquire, 1);
  assert.equal(counters.launch, 1);
  assert.equal(counters.prompt, 1);
  assert.equal(counters.worker_exit, 1);
  assert.equal(counters.return, 1);
  const records = await owners.forAttempt(attempt.id);
  for (const effect of ["acquire", "launch", "prompt", "return"] as const) {
    assert.deepEqual(records.find(record => record.effect === effect)?.identity, attempt.identity);
  }
  assert.ok(records.some(record => record.effect === (request.delivery.acceptance === "review" ? "review" : "merge") &&
    record.commit === attempt.result!.commit && record.decision !== "rejected"));
  await assertSafe(driver, owners);
}

export async function assertRetained(driver: ScenarioDriver, owners: FakeOwners, requestId: string): Promise<void> {
  const attempt = await findAttempt(driver, requestId);
  const counters = await owners.counters(attempt.id);
  assert.equal(counters.return, 0, "An unresolved attempt must retain its lease");
  assert.equal(attempt.returned, false);
  await assertSafe(driver, owners);
}

// Test-owned result construction is separate from the execution design and worker fake.
export function completedResult(attempt: Attempt): WorkerResult {
  assert.ok(attempt.identity);
  return {
    identity: structuredClone(attempt.identity), outcome: "completed", commit: "a".repeat(40),
    branch: attempt.request.delivery.outputBranch,
    evidence: [...attempt.request.delivery.requiredEvidence], deliverables: [...attempt.request.delivery.requiredDeliverables],
  };
}
