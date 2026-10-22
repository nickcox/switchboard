import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttemptFacts } from "../../src/dispatch/assess.ts";
import { checkCanAcceptOutput, checkCanConfirmLeaseReturned, checkCanConfirmStopped, checkCanControl, checkCanDiscard, checkCanFinish, checkCanIntegrate, checkCanPrune, checkCanReturnLease, type Permission } from "../../src/dispatch/safety.ts";

const facts = (overrides: Partial<AttemptFacts> = {}): AttemptFacts => ({
  unknown: [], hasRecord: true, possiblyRunning: false, dispatcherRunning: false, leaseHeld: true, leaseInOtherPool: false,
  open: false, unfinished: false, task: { state: "queued", held: true, holdReason: "review" }, recordedOutcome: true,
  matchingHold: true, outcomeCategory: "review_required", completedOutcomePending: false, acceptedOutput: false, discarded: false,
  lastRecordedAt: "2026-01-01T00:00:00.000Z", taskLeaseHeld: false, taskWorkerMayBeRunning: false, leaseReturnedConfirmed: false, ...overrides,
});
const done = { state: "done", held: false, holdReason: null };
const cutoff = Date.parse("2026-02-01T00:00:00.000Z");
const integration = { accepting: false, retained: true, fastForward: true };
const returning = { by: "finish" as const, noProcesses: true, retained: true, confirmedDiscard: false };
const refusal = (permission: Permission, reason: string) => {
  assert.equal(permission.allowed, false);
  if (permission.allowed) return;
  assert.equal(permission.reason, reason);
  assert.ok(permission.detail && permission.nextAction);
  assert.notEqual(permission.evidence, undefined);
};

type Check = { name: string; run: (facts: AttemptFacts) => Permission; base?: Partial<AttemptFacts>; needsRecord?: boolean; needsStopped?: boolean; needsLease?: boolean };
const checks: Check[] = [
  { name: "finish", run: f => checkCanFinish(f, false), needsRecord: true, needsStopped: true, needsLease: true },
  { name: "accept output", run: f => checkCanAcceptOutput(f, true), needsRecord: true, needsStopped: true, needsLease: true },
  { name: "integrate", run: f => checkCanIntegrate(f, integration), needsRecord: true, needsStopped: true, needsLease: true },
  { name: "discard", run: f => checkCanDiscard(f, true), needsRecord: true, needsStopped: true, needsLease: true },
  { name: "return lease", run: f => checkCanReturnLease(f, returning), base: { task: done }, needsRecord: true, needsStopped: true, needsLease: true },
  { name: "prune", run: f => checkCanPrune(f, cutoff), base: { leaseHeld: false, task: done }, needsRecord: true, needsStopped: true },
  { name: "control", run: checkCanControl, base: { possiblyRunning: true } },
  { name: "confirm stopped", run: f => checkCanConfirmStopped(f, true), base: { possiblyRunning: true }, needsRecord: true },
  { name: "confirm lease returned", run: checkCanConfirmLeaseReturned, base: { leaseHeld: false, open: true }, needsRecord: true },
];

for (const check of checks) {
  test(`${check.name} permits its prerequisites and refuses unknown owner evidence`, () => {
    const input = facts(check.base);
    const before = structuredClone(input);
    assert.deepEqual(check.run(input), { allowed: true });
    assert.deepEqual(input, before, "the check must not change its facts");
    refusal(check.run({ ...input, unknown: ["Workspace leases could not be read: offline"] }), "unknown");
  });
  if (check.needsRecord) test(`${check.name} refuses a missing attempt or task`, () => {
    refusal(check.run(facts({ ...check.base, hasRecord: false })), "unknown");
    for (const task of ["missing", "unreadable"] as const) refusal(check.run(facts({ ...check.base, task })), "unknown");
  });
  if (check.needsStopped) test(`${check.name} refuses both a live worker and one that may still be running`, () => {
    for (const dispatcherRunning of [false, true]) {
      const permission = check.run(facts({ ...check.base, possiblyRunning: true, dispatcherRunning }));
      refusal(permission, "possibly_running");
      if (!permission.allowed) assert.equal(permission.nextAction, dispatcherRunning ? "watch_attempt" : "stop_worker");
    }
  });
  if (check.needsLease) test(`${check.name} refuses an unlisted lease and an unobservable pool`, () => {
    refusal(check.run(facts({ ...check.base, leaseHeld: false })), "no_lease");
    refusal(check.run(facts({ ...check.base, leaseHeld: false, unfinished: true })), "no_lease");
    refusal(check.run(facts({ ...check.base, leaseInOtherPool: true })), "lease_in_other_pool");
  });
}

test("finishing uses outcome facts, never state labels or an editable hold's wording", () => {
  assert.deepEqual(checkCanFinish(facts({ task: done }), false), { allowed: true });
  assert.deepEqual(checkCanFinish(facts({ outcomeCategory: "not_retained" }), false), { allowed: true });
  assert.deepEqual(checkCanFinish(facts({ recordedOutcome: false, matchingHold: false, completedOutcomePending: true }), false), { allowed: true });
  assert.deepEqual(checkCanFinish(facts({ matchingHold: false, outcomeCategory: "failed" }), true), { allowed: true });
  refusal(checkCanFinish(facts({ matchingHold: false }), false), "no_completed_output");
  refusal(checkCanFinish(facts({ outcomeCategory: "failed" }), false), "no_completed_output");
  refusal(checkCanFinish(facts({ recordedOutcome: false, matchingHold: false }), true), "no_completed_output");
  refusal(checkCanFinish(facts({ task: { state: "in_flight", held: false, holdReason: null }, recordedOutcome: false, matchingHold: false }), true), "no_completed_output");
});

test("accepting output requires a strict descendant of the attempt's starting commit", () => {
  refusal(checkCanAcceptOutput(facts(), false), "output_not_advanced");
  refusal(checkCanAcceptOutput(facts({ recordedOutcome: false, matchingHold: false }), true), "no_completed_output");
});

test("integration requires retained output, a permitted policy and a fast-forward", () => {
  refusal(checkCanIntegrate(facts(), { ...integration, retained: false }), "not_retained");
  refusal(checkCanIntegrate(facts(), { ...integration, policyRefusal: "protected branch" }), "policy_refused");
  refusal(checkCanIntegrate(facts(), { ...integration, fastForward: false }), "not_fast_forward");
  refusal(checkCanIntegrate(facts({ matchingHold: false }), integration), "no_completed_output");
});

test("discard and lease return require explicit, operation-specific confirmations", () => {
  refusal(checkCanDiscard(facts(), false), "confirmation_required");
  refusal(checkCanReturnLease(facts({ task: done }), { ...returning, noProcesses: false }), "process_confirmation_required");
  refusal(checkCanReturnLease(facts(), returning), "outcome_not_done");
  refusal(checkCanReturnLease(facts({ task: done, recordedOutcome: false }), returning), "outcome_not_done");
  refusal(checkCanReturnLease(facts({ task: done }), { ...returning, retained: false }), "not_retained");
  refusal(checkCanReturnLease(facts(), { ...returning, by: "discard" }), "confirmation_required");
  assert.deepEqual(checkCanReturnLease(facts(), { ...returning, by: "discard", confirmedDiscard: true, retained: false }), { allowed: true });
});

test("pruning preserves open, leased, running, in-flight and recent records", () => {
  const settled = facts({ task: done, leaseHeld: false });
  refusal(checkCanPrune({ ...settled, open: true }, cutoff), "unfinished");
  refusal(checkCanPrune({ ...settled, leaseInOtherPool: true }, cutoff), "lease_in_other_pool");
  refusal(checkCanPrune({ ...settled, leaseHeld: true }, cutoff), "lease_held");
  refusal(checkCanPrune({ ...settled, taskLeaseHeld: true }, cutoff), "lease_held");
  refusal(checkCanPrune({ ...settled, taskWorkerMayBeRunning: true }, cutoff), "possibly_running");
  refusal(checkCanPrune({ ...settled, task: { ...done, state: "in_flight" } }, cutoff), "task_in_flight");
  for (const lastRecordedAt of [undefined, "invalid", new Date(cutoff).toISOString(), new Date(cutoff + 1).toISOString()]) {
    refusal(checkCanPrune({ ...settled, lastRecordedAt }, cutoff), "too_recent");
  }
});

test("control requests can address an orphan runtime but not a stopped worker", () => {
  assert.deepEqual(checkCanControl(facts({ hasRecord: false, task: "missing", possiblyRunning: true })), { allowed: true });
  refusal(checkCanControl(facts()), "not_running");
});

test("stop confirmation needs a possibly running worker, no fresh dispatcher and operator confirmation", () => {
  refusal(checkCanConfirmStopped(facts(), true), "not_running");
  refusal(checkCanConfirmStopped(facts({ possiblyRunning: true, dispatcherRunning: true }), true), "dispatcher_running");
  refusal(checkCanConfirmStopped(facts({ possiblyRunning: true }), false), "confirmation_required");
});

test("lease-return confirmation is only for unobservable leases, once, after the worker stops", () => {
  const unlisted = facts({ leaseHeld: false, open: true });
  assert.deepEqual(checkCanConfirmLeaseReturned({ ...unlisted, leaseInOtherPool: true }), { allowed: true });
  refusal(checkCanConfirmLeaseReturned({ ...unlisted, leaseReturnedConfirmed: true }), "already_confirmed");
  refusal(checkCanConfirmLeaseReturned({ ...unlisted, open: false }), "listed_pool");
  refusal(checkCanConfirmLeaseReturned({ ...unlisted, possiblyRunning: true }), "possibly_running");
  refusal(checkCanConfirmLeaseReturned({ ...unlisted, leaseHeld: true }), "lease_held");
});
