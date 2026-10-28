import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckResult } from "../../src/attempts/checks.ts";
import type { ReviewRecord } from "../../src/attempts/reviews.ts";
import type { AttemptFacts } from "../../src/dispatch/assess.ts";
import { checkAcceptanceEvidence, checkCanAcceptOutput, checkCanConfirmLeaseReturned, checkCanConfirmStopped, checkCanControl, checkCanDiscard, checkCanDispatch, checkCanFinish, checkCanIntegrate, checkCanPrune, checkCanRedispatch, checkCanReturnLease, checkCanRebase, type Permission } from "../../src/dispatch/safety.ts";

const facts = (overrides: Partial<AttemptFacts> = {}): AttemptFacts => ({
  unknown: [], hasRecord: true, possiblyRunning: false, dispatcherRunning: false, blocksDispatch: false, leaseHeld: true, leaseInOtherPool: false,
  open: false, unfinished: false, task: { state: "queued", held: true, holdReason: "review" }, recordedOutcome: true,
  matchingHold: true, outcomeCategory: "review_required", completedOutcomePending: false, acceptedOutput: false, discarded: false,
  lastRecordedAt: "2026-01-01T00:00:00.000Z", taskLeaseHeld: false, taskWorkerMayBeRunning: false, leaseReturnedConfirmed: false, ...overrides,
});
const done = { state: "done", held: false, holdReason: null };
const cutoff = Date.parse("2026-02-01T00:00:00.000Z");
const integration = { accepting: false, retained: true, fastForward: true };
const returning = { by: "finish" as const, noProcesses: true, retained: true, confirmedDiscard: false };
const rebase = { head: "output", original: "output", branch: "branch", workspaceBranch: "branch", workspaceHead: "output", clean: true, upstream: "start", advanced: true, merges: 0 };
const refusal = (permission: Permission, reason: string) => {
  assert.equal(permission.allowed, false);
  if (permission.allowed) return;
  assert.equal(permission.reason, reason);
  assert.ok(permission.detail && permission.nextAction);
  assert.notEqual(permission.evidence, undefined);
};

type Check = { name: string; run: (facts: AttemptFacts) => Permission; base?: Partial<AttemptFacts>; needsRecord?: boolean; needsStopped?: boolean; needsLease?: boolean };
const checks: Check[] = [
  { name: "dispatch", run: checkCanDispatch },
  { name: "redispatch", run: f => checkCanRedispatch(f, "task-a1") },
  { name: "finish", run: f => checkCanFinish(f, false), needsRecord: true, needsStopped: true, needsLease: true },
  { name: "accept output", run: f => checkCanAcceptOutput(f, true), needsRecord: true, needsStopped: true, needsLease: true },
  { name: "integrate", run: f => checkCanIntegrate(f, integration), needsRecord: true, needsStopped: true, needsLease: true },
  { name: "rebase", run: f => checkCanRebase(f, rebase), needsRecord: true, needsStopped: true, needsLease: true },
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

test("dispatch blocks the whole context only for unsupervised workers; redispatch still blocks the task", () => {
  const unsupervised = facts({ possiblyRunning: true, blocksDispatch: true });
  refusal(checkCanDispatch(unsupervised), "possibly_running");
  for (const dispatcherRunning of [false, true]) {
    // A pending launch without a runtime row also blocks only its task, despite having no heartbeat.
    const input = facts({ possiblyRunning: true, dispatcherRunning, blocksDispatch: false });
    assert.deepEqual(checkCanDispatch(input), { allowed: true });
    const check = checkCanRedispatch(input, "task-a1");
    refusal(check, "possibly_running");
    if (!check.allowed) assert.equal(check.nextAction, "choose_another_task");
  }
  assert.deepEqual(checkCanDispatch(facts({ hasRecord: false, task: "missing" })), { allowed: true });
});

test("a stopped attempt blocks its own task only for an unknown pool lease or its latest unfinished dispatch", () => {
  refusal(checkCanRedispatch(facts({ leaseInOtherPool: true }), "task-a1"), "lease_in_other_pool");
  refusal(checkCanRedispatch(facts({ unfinished: true }), "task-a1"), "unfinished");
  assert.deepEqual(checkCanRedispatch(facts({ open: true, unfinished: false }), "task-a1"), { allowed: true });
});

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

test("acceptance evidence needs every configured check and a passed review of the exact commit", () => {
  const commit = "a".repeat(40);
  const later = "b".repeat(40);
  const configured = [{ name: "types" }, { name: "tests" }];
  const check: CheckResult = { name: "types", commit, status: "passed", exitCode: 0, timedOut: false, durationMs: 1, stdout: "", stderr: "" };
  const checks = [check, { ...check, name: "tests" }];
  const review: ReviewRecord = { taskId: "review-a1", attempt: 1, commit, verdict: "passed", findings: [] };
  const before = structuredClone({ configured, checks, review });
  refusal(checkAcceptanceEvidence(undefined, [], [], []), "output_not_recorded");
  refusal(checkAcceptanceEvidence(commit, [], [], []), "review_missing");
  assert.deepEqual(checkAcceptanceEvidence(commit, [], [], [review]), { allowed: true }, "No configured checks need no check results, but still need review");
  refusal(checkAcceptanceEvidence(commit, configured, [check], [review]), "check_missing");
  for (const status of ["failed", "not_run"] as const) {
    refusal(checkAcceptanceEvidence(commit, configured, [check, { ...check, name: "tests", status }], [review]), "check_not_passed");
  }
  refusal(checkAcceptanceEvidence(commit, configured, checks, []), "review_missing");
  refusal(checkAcceptanceEvidence(commit, configured, checks, [{ ...review, verdict: "failed" }]), "review_not_passed");
  assert.deepEqual(checkAcceptanceEvidence(commit, configured, checks, [review]), { allowed: true });
  refusal(checkAcceptanceEvidence(later, configured, checks, [review]), "check_missing");
  refusal(checkAcceptanceEvidence(later, configured, checks.map(check => ({ ...check, commit: later })), [review]), "review_missing");
  refusal(checkAcceptanceEvidence(commit, configured, [...checks, { ...check, status: "failed" }], [review]), "check_not_passed");
  refusal(checkAcceptanceEvidence(commit, configured, checks, [review, { ...review, verdict: "failed" }]), "review_not_passed");
  assert.deepEqual({ configured, checks, review }, before, "The evidence check must not change its inputs");
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

test("rebasing needs the exact, clean output and only non-merge commits after its recorded upstream", () => {
  refusal(checkCanRebase(facts(), { ...rebase, head: "later" }), "rebase_other_commits");
  refusal(checkCanRebase(facts(), { ...rebase, head: undefined }), "rebase_other_commits");
  refusal(checkCanRebase(facts(), { ...rebase, clean: false }), "rebase_dirty");
  refusal(checkCanRebase(facts(), { ...rebase, workspaceBranch: undefined }), "rebase_workspace_mismatch");
  refusal(checkCanRebase(facts(), { ...rebase, workspaceHead: "later" }), "rebase_workspace_mismatch");
  refusal(checkCanRebase(facts(), { ...rebase, upstream: undefined }), "rebase_other_commits");
  refusal(checkCanRebase(facts(), { ...rebase, advanced: false }), "rebase_other_commits");
  refusal(checkCanRebase(facts(), { ...rebase, merges: 1 }), "rebase_merge_commits");
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
