import type { AttemptFacts } from "./assess.ts";
import type { NextAction } from "./result.ts";

export type Permission = { allowed: true } | { allowed: false; reason: string; detail: string; nextAction: NextAction; evidence: unknown };
const permit: Permission = { allowed: true };
const refuse = (reason: string, detail: string, nextAction: NextAction, evidence: unknown): Permission =>
  ({ allowed: false, reason, detail, nextAction, evidence });

function known(facts: AttemptFacts): Permission {
  if (facts.unknown.length) return refuse("unknown", facts.unknown.join("; "), "inspect_attempt", facts.unknown);
  if (!facts.hasRecord || typeof facts.task !== "object") return refuse("unknown", "The attempt or its task is missing", "inspect_attempt", { hasRecord: facts.hasRecord, task: facts.task });
  return permit;
}

function stopped(facts: AttemptFacts): Permission {
  const check = known(facts);
  if (!check.allowed) return check;
  if (facts.possiblyRunning) return refuse("possibly_running", "The attempt's worker may still be running", facts.dispatcherRunning ? "watch_attempt" : "stop_worker", { possiblyRunning: true, dispatcherRunning: facts.dispatcherRunning });
  return permit;
}

function listedLease(facts: AttemptFacts): Permission {
  const check = stopped(facts);
  if (!check.allowed) return check;
  if (facts.leaseInOtherPool) return refuse("lease_in_other_pool", "The attempt's lease is in a pool no longer listed", "confirm_lease_returned", { leaseInOtherPool: true });
  if (!facts.leaseHeld) return refuse("no_lease", "The attempt has no listed lease", facts.unfinished ? "confirm_attempt_stopped" : "none", { leaseHeld: false });
  return permit;
}

/** A possibly running worker blocks the whole context, even with a fresh dispatcher heartbeat. */
export function checkCanDispatch(facts: AttemptFacts): Permission {
  if (facts.unknown.length) return refuse("unknown", facts.unknown.join("; "), "fix_configuration", facts.unknown);
  return facts.possiblyRunning ? refuse("possibly_running", "An earlier attempt's worker may still be running", "stop_worker", { possiblyRunning: true }) : permit;
}

/** A stopped attempt can still block its own task until its lease or unfinished dispatch is reconciled. */
export function checkCanRedispatch(facts: AttemptFacts, taskId: string): Permission {
  if (facts.leaseInOtherPool) return refuse("lease_in_other_pool", `Task ${taskId} has a lease from an earlier attempt in a workspace pool that is no longer listed, so whether it is still held is unknown`, "confirm_lease_returned", { leaseInOtherPool: true });
  if (facts.unfinished) return refuse("unfinished", `Task ${taskId} has an earlier attempt that has not finished, and its dispatcher may still be working on it`, "confirm_attempt_stopped", { unfinished: true });
  return permit;
}

export function checkCanFinish(facts: AttemptFacts, accepting: boolean): Permission {
  const check = listedLease(facts);
  if (!check.allowed) return check;
  if (typeof facts.task === "object" && (facts.task.state === "done" && facts.recordedOutcome ||
    facts.matchingHold && (facts.outcomeCategory === "review_required" || facts.outcomeCategory === "not_retained") ||
    facts.completedOutcomePending || accepting && facts.recordedOutcome && facts.task.held)) return permit;
  return refuse("no_completed_output", "Only an attempt awaiting review or finish, not retained, awaiting its outcome transaction, or held with --accept-output, can be finished", "inspect_attempt",
    { task: facts.task, recordedOutcome: facts.recordedOutcome, outcomeCategory: facts.outcomeCategory, completedOutcomePending: facts.completedOutcomePending, accepting });
}

export function checkCanAcceptOutput(facts: AttemptFacts, advanced: boolean): Permission {
  const check = checkCanFinish(facts, true);
  if (!check.allowed) return check;
  return advanced ? permit : refuse("output_not_advanced", "The output branch must exist and have commits beyond the attempt's starting commit", "inspect_attempt", { advanced });
}

export function checkCanIntegrate(facts: AttemptFacts, options: { accepting: boolean; retained: boolean; policyRefusal?: string | undefined; fastForward: boolean }): Permission {
  const check = checkCanFinish(facts, options.accepting);
  if (!check.allowed) return check;
  if (options.policyRefusal) return refuse("policy_refused", options.policyRefusal, "fix_configuration", { policyRefusal: options.policyRefusal });
  if (!options.retained) return refuse("not_retained", "The work is not retained", "inspect_attempt", { retained: false });
  return options.fastForward ? permit : refuse("not_fast_forward", "The target cannot be fast-forwarded to the output commit", "inspect_attempt", { fastForward: false });
}

export function checkCanDiscard(facts: AttemptFacts, confirmed: boolean): Permission {
  const check = listedLease(facts);
  if (!check.allowed) return check;
  return confirmed ? permit : refuse("confirmation_required", "Discarding the attempt's work needs your explicit confirmation (--confirm)", "confirm_discard", { confirmed });
}

export function checkCanReturnLease(facts: AttemptFacts, options: { by: "finish" | "discard"; noProcesses: boolean; retained: boolean; confirmedDiscard: boolean }): Permission {
  const check = listedLease(facts);
  if (!check.allowed) return check;
  if (!options.noProcesses) return refuse("process_confirmation_required", "Returning the lease needs your confirmation that no worker process remains (--no-processes)", "confirm_no_processes", { noProcesses: false });
  if (options.by === "discard") return checkCanDiscard(facts, options.confirmedDiscard);
  if (typeof facts.task !== "object" || facts.task.state !== "done" || !facts.recordedOutcome) {
    return refuse("outcome_not_done", "The task must be recorded as done before returning its lease", "finish_attempt", { task: facts.task, recordedOutcome: facts.recordedOutcome });
  }
  return options.retained ? permit : refuse("not_retained", "The work is no longer retained", "inspect_attempt", { retained: false });
}

export function checkCanPrune(facts: AttemptFacts, cutoff: number): Permission {
  const check = stopped(facts);
  if (!check.allowed) return check;
  if (facts.open) return refuse("unfinished", "The attempt is unfinished", "confirm_attempt_stopped", { open: true });
  if (facts.leaseInOtherPool) return refuse("lease_in_other_pool", "The attempt's lease may still be held in another pool", "confirm_lease_returned", { leaseInOtherPool: true });
  if (facts.leaseHeld || facts.taskLeaseHeld) return refuse("lease_held", "A lease is still held for this task", "inspect_attempt", { leaseHeld: facts.leaseHeld, taskLeaseHeld: facts.taskLeaseHeld });
  if (facts.taskWorkerMayBeRunning) return refuse("possibly_running", "A worker for this task may still be running", "stop_worker", { taskWorkerMayBeRunning: true });
  if (typeof facts.task === "object" && facts.task.state === "in_flight") return refuse("task_in_flight", "The task is still in flight", "inspect_attempt", { task: facts.task });
  if (!facts.lastRecordedAt || !Number.isFinite(Date.parse(facts.lastRecordedAt)) || Date.parse(facts.lastRecordedAt) >= cutoff) {
    return refuse("too_recent", "The attempt is not older than the cutoff", "none", { lastRecordedAt: facts.lastRecordedAt, cutoff });
  }
  return permit;
}

export function checkCanControl(facts: AttemptFacts): Permission {
  // Control requests can address an orphan runtime. No task or lease change is authorised by sending a request.
  if (facts.unknown.length) return refuse("unknown", facts.unknown.join("; "), "inspect_attempt", facts.unknown);
  return facts.possiblyRunning ? permit : refuse("not_running", "The worker is not running", "none", { possiblyRunning: false });
}

export function checkCanConfirmStopped(facts: AttemptFacts, confirmed: boolean): Permission {
  const check = known(facts);
  if (!check.allowed) return check;
  if (!facts.possiblyRunning) return refuse("not_running", "No worker for this lease is waiting for confirmation that it has stopped", "none", { possiblyRunning: false });
  if (facts.dispatcherRunning) return refuse("dispatcher_running", "The owning dispatcher appears to be running; follow the attempt with watch or request a stop", "watch_attempt", { dispatcherRunning: true });
  return confirmed ? permit : refuse("confirmation_required", "Resolving needs the operator's confirmation that the worker has stopped", "confirm_worker_stopped", { confirmed });
}

export function checkCanConfirmLeaseReturned(facts: AttemptFacts): Permission {
  const check = known(facts);
  if (!check.allowed) return check;
  if (facts.leaseReturnedConfirmed) return refuse("already_confirmed", "The operator has already confirmed this lease was returned", "none", { leaseReturnedConfirmed: true });
  if (facts.leaseInOtherPool) return permit;
  if (!facts.open) return refuse("listed_pool", "This lease is in the workspace pool Switchboard currently lists, so its state is read from the provider and needs no confirmation", "none", { open: false });
  if (facts.possiblyRunning) return refuse("possibly_running", "This attempt's worker may still be running; confirm it stopped first", "stop_worker", { possiblyRunning: true });
  if (facts.leaseHeld) return refuse("lease_held", "The attempt's lease is still listed; return it through Treehouse first", "return_unused_lease", { leaseHeld: true });
  return permit;
}
