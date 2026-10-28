import { TaskStoreError } from "../tasks/store.ts";
import { resolvedBy } from "./attempt.ts";
import type { Dependencies } from "./dependencies.ts";
import { observeAttempt, type AttemptSelector } from "./observe.ts";
import { assessAttempt } from "./assess.ts";
import { checkCanConfirmLeaseReturned, checkCanConfirmStopped, requireOperationAuthority } from "./safety.ts";
import { OwnerReadError, type ReadFailure } from "./failure.ts";
import { effectBefore, OwnerReads, pendingReturn, readRefusal, unsettledReads } from "./owner-reads.ts";
import { result, type DispatchResult } from "./result.ts";


/** Scoped stop confirmation. It never changes the task or returns a lease. */
export async function resolveStopped(
  deps: Dependencies, options: { leaseId: string; confirmed: boolean; note?: string },
): Promise<DispatchResult> {
  const reads = new OwnerReads(deps, "resolve", options.leaseId);
  return confirmStopped(deps, options, reads).catch(error => readRefusal(error) ?? unexpected(error));
}

async function confirmStopped(deps: Dependencies, options: { leaseId: string; confirmed: boolean; note?: string }, reads: OwnerReads): Promise<DispatchResult> {
  requireOperationAuthority(deps, ["stopWorkers"], options);
  const observation = await observeAttempt(deps, { leaseId: options.leaseId });
  if (!observation) return result({ ok: false, reason: "refused", stage: "resolve", lease: "none", observed: { leaseId: options.leaseId }, detail: "No attempt or runtime record in this context has this lease ID", nextAction: "inspect_attempt" });
  await reads.attempt(observation, "inspect worker confirmation");
  const assessment = assessAttempt(observation);
  const runtime = observation.runtime.known ? observation.runtime.value : undefined;
  const attempt = observation.record.known ? observation.record.value : undefined;
  const observed = { runtime: runtime?.child.status ?? "no runtime record", leaseHeld: assessment.leaseHeld, task: assessment.task };
  const common = { stage: "resolve" as const, attempt: assessment.attempt, lease: assessment.leaseHeld ? "preserved" as const : "none" as const, observed };
  const permission = checkCanConfirmStopped(assessment.facts, options.confirmed);
  if (!permission.allowed) return result({ ...common, ok: false, reason: "refused", detail: permission.detail, nextAction: permission.nextAction, observed: { ...observed, refusal: permission } });
  if (!attempt) return result({ ...common, ok: false, reason: "refused", detail: "The runtime has no attempt to record this confirmation against; restore or import its attempt records first", nextAction: "inspect_attempt" });

  // The immutable launch row prevents a pending launch after this confirmation.
  if (!runtime && attempt.entries.some(e => e.kind === "launched")) reads.effectAttempted = true;
  if (!runtime && attempt.entries.some(e => e.kind === "launched") && !await deps.runtime.fence(deps.contextId, options.leaseId)) {
    return result({ ...common, ok: false, reason: "refused", detail: "The dispatcher is starting this worker now; follow the attempt with watch or request a stop", nextAction: "watch_attempt" });
  }
  const current = await observeAttempt(deps, { leaseId: options.leaseId });
  if (current) await reads.attempt(current, "recheck worker confirmation");
  const rechecked = current && checkCanConfirmStopped(assessAttempt(current).facts, options.confirmed);
  if (!rechecked || !rechecked.allowed) return result({ ...common, ok: false, reason: "refused", detail: rechecked ? rechecked.detail : "The attempt disappeared", nextAction: rechecked ? rechecked.nextAction : "inspect_attempt" });
  reads.effectAttempted = true;
  await deps.attempts.appendConfirmed(attempt, "operator_resolved", { action: "worker_stopped", ...(options.note ? { note: options.note } : {}) },
    { fact: "worker_stopped", scope: { leaseId: options.leaseId, ...(assessment.attempt.sessionId ? { sessionId: assessment.attempt.sessionId } : {}) } }, current?.record.known ? current.record.value : undefined);
  const confirmed = await observeAttempt(deps, { leaseId: options.leaseId });
  if (confirmed) await reads.attempt(confirmed, "read back worker confirmation");
  return result({ ...common, ok: true, reason: "resolved", nextAction: "apply_task_outcome" });
}

/** Confirms a lease the provider cannot observe was returned. It never returns a lease itself. */
export async function resolveLeaseReturned(
  deps: Dependencies,
  options: ({ leaseId: string; taskId?: never; attempt?: never } | { taskId: string; attempt?: number; leaseId?: never }) & { note?: string },
): Promise<DispatchResult> {
  const reads = new OwnerReads(deps, "resolve", options.leaseId);
  return confirmLeaseReturned(deps, options, reads).catch(error => readRefusal(error) ?? unexpected(error));
}

async function confirmLeaseReturned(deps: Dependencies, options: ({ leaseId: string; taskId?: never; attempt?: never } | { taskId: string; attempt?: number; leaseId?: never }) & { note?: string }, reads: OwnerReads): Promise<DispatchResult> {
  requireOperationAuthority(deps, ["returnLease"], options);
  const selector: AttemptSelector = options.taskId !== undefined ? { taskId: options.taskId, ...(options.attempt === undefined ? {} : { attempt: options.attempt }) } : { leaseId: options.leaseId };
  const observation = await observeAttempt(deps, selector);
  if (!observation) return result({ ok: false, reason: "refused", stage: "resolve", lease: "none", observed: options, detail: "No attempt in this context matches the given lease or task and attempt", nextAction: "inspect_attempt" });
  await reads.attempt(observation, "inspect lease confirmation");
  const assessment = assessAttempt(observation);
  const attempt = observation.record.known ? observation.record.value : undefined;
  const summary = assessment.attempt;
  const uncertainReturn = attempt && pendingReturn(attempt) && unsettledReads(attempt)[0];
  if (uncertainReturn && assessment.leaseInOtherPool) throw new OwnerReadError(uncertainReturn.data as ReadFailure);
  // An unfinished attempt may have acquired a lease without recording its ID.
  const outputBranch = summary.outputBranch ?? `${deps.delivery.branchPrefix}${summary.taskId}/attempt-${summary.attempt}`;
  const listed = observation.leases.known ? observation.leases.value.find(l => l.leaseId === summary.leaseId || (l.holder === summary.taskId && l.branch === outputBranch)) : undefined;
  const facts = { ...assessment.facts, leaseHeld: listed !== undefined, leaseReturnedConfirmed: attempt !== undefined && resolvedBy(attempt, "lease_returned") };
  const observed = { leaseId: listed?.leaseId ?? summary.leaseId, pool: observation.pool.known ? observation.pool.value : "unknown", ...(assessment.leaseInOtherPool ? { leasePool: assessment.leaseInOtherPool } : {}) };
  const common = { stage: "resolve" as const, attempt: summary, observed, lease: listed ? "preserved" as const : "unknown" as const };
  const permission = checkCanConfirmLeaseReturned(facts);
  if (!permission.allowed) return result({ ...common, ok: false, reason: "refused", detail: permission.detail, nextAction: permission.nextAction, observed: { ...observed, refusal: permission } });
  if (!attempt) return result({ ...common, ok: false, reason: "refused", detail: "The attempt could not be read", nextAction: "inspect_attempt" });
  const current = await observeAttempt(deps, selector);
  if (!current) return result({ ...common, ok: false, reason: "refused", detail: "The attempt disappeared", nextAction: "inspect_attempt" });
  await reads.attempt(current, "recheck lease confirmation");
  const rechecked = assessAttempt(current);
  if (uncertainReturn && rechecked.leaseInOtherPool) throw new OwnerReadError(uncertainReturn.data as ReadFailure);
  const currentListed = current.leases.known && current.leases.value.some(l => l.leaseId === summary.leaseId || (l.holder === summary.taskId && l.branch === outputBranch));
  const fresh = checkCanConfirmLeaseReturned({ ...rechecked.facts, leaseHeld: currentListed });
  if (!fresh.allowed) return result({ ...common, ok: false, reason: "refused", detail: fresh.detail, nextAction: fresh.nextAction });
  reads.effectAttempted = true;
  await deps.attempts.appendConfirmed(attempt, "operator_resolved", { action: "lease_returned", ...(options.note ? { note: options.note } : {}) },
    { fact: "lease_returned", scope: { outputBranch, ...(summary.leaseId ? { leaseId: summary.leaseId } : {}) } }, current.record.known ? current.record.value : undefined);
  const confirmed = await observeAttempt(deps, selector);
  if (confirmed) await reads.attempt(confirmed, "read back lease confirmation");
  return result({ ...common, ok: true, reason: "resolved", nextAction: "dispatch_again" });
}

const unexpected = (error: unknown) => result({ ok: false, reason: error instanceof TaskStoreError ? "refused" : "stopped", stage: "resolve", lease: "unknown", observed: {},
  detail: `Resolution stopped: ${error instanceof Error ? error.message : String(error)}`, nextAction: "inspect_attempt" });

/** Records what the caller established about one failure. It never performs the uncertain effect. */
export async function resolveReadFailure(deps: Dependencies, options: AttemptSelector & {
  failureSequence: number; outcome: "happened" | "not_happened"; note: string;
}): Promise<DispatchResult> {
  const reads = new OwnerReads(deps, "resolve", "leaseId" in options ? options.leaseId : undefined);
  try {
    requireOperationAuthority(deps, ["integrate"], options);
    if (deps.caller.kind === "supervisor") {
      const selected = "taskId" in options ? deps.attempts.findForTask(options.taskId, options.attempt) : await deps.attempts.findByLease(options.leaseId);
      if (selected && effectBefore(selected, options.failureSequence)?.kind === "lease_return_started") requireOperationAuthority(deps, ["returnLease"], options);
      if (selected && effectBefore(selected, options.failureSequence)?.kind === "rebase_started") requireOperationAuthority(deps, ["rebase"], options);
    }
    const observation = await observeAttempt(deps, options);
    const refuse = (detail: string) => result({ ok: false, reason: "refused", stage: "resolve", lease: "unknown", observed: {}, detail, nextAction: "inspect_attempt" });
    if (!observation) return refuse("No attempt matches this reconciliation");
    await reads.attempt(observation, "inspect read reconciliation");
    const assessment = assessAttempt(observation);
    if (assessment.facts.possiblyRunning || assessment.facts.dispatcherRunning || observation.taskWorkerMayBeRunning) return refuse("The attempt's worker or dispatcher may still be running; confirm it stopped first");
    if (!Number.isSafeInteger(options.failureSequence) || !options.note.trim() || !["happened", "not_happened"].includes(options.outcome)) return refuse("Reconciliation needs a failure sequence, an established outcome and a note");
    const record = observation.record.known ? observation.record.value : undefined;
    const failure = record && unsettledReads(record).find(e => e.sequence === options.failureSequence);
    if (!record || !failure) return refuse("The sequence does not name an unsettled uncertain read failure in this attempt");
    const effect = effectBefore(record, failure.sequence);
    const intent = effect?.kind === "lease_return_started" ? effect : undefined;
    if (intent) requireOperationAuthority(deps, ["returnLease"], options);
    if (effect?.kind === "rebase_started") requireOperationAuthority(deps, ["rebase"], options);
    // A claimed return cannot overrule a lease that Treehouse still lists or cannot observe.
    if (intent && options.outcome === "happened" && (assessment.leaseHeld || assessment.leaseInOtherPool || assessment.facts.unknown.length)) return refuse("Treehouse must confirm the lease is absent before recording that the return happened");
    const current = await observeAttempt(deps, options);
    if (!current) return refuse("The attempt disappeared");
    await reads.attempt(current, "recheck read reconciliation");
    const fresh = assessAttempt(current);
    const currentRecord = current.record.known ? current.record.value : undefined;
    if (!currentRecord || !unsettledReads(currentRecord).some(e => e.sequence === options.failureSequence)) return refuse("This failure was already reconciled");
    if (fresh.facts.possiblyRunning || fresh.facts.dispatcherRunning || current.taskWorkerMayBeRunning ||
      intent && options.outcome === "happened" && (fresh.leaseHeld || fresh.leaseInOtherPool || fresh.facts.unknown.length)) return refuse("The worker or lease changed while reconciling; inspect the owners again");
    await deps.attempts.appendConfirmed(record, "operator_resolved", { action: "owner_read_reconciled", note: options.note },
      { fact: "owner_read_reconciled", scope: { failureSequence: options.failureSequence, outcome: options.outcome, ...(intent ? { returnId: intent.data.returnId as string } : {}) } },
      current.record.known ? current.record.value : undefined);
    return result({ ok: true, reason: "resolved", stage: "resolve", lease: fresh.leaseHeld ? "preserved" : "none", attempt: fresh.attempt,
      observed: { failureSequence: options.failureSequence, outcome: options.outcome }, nextAction: "inspect_attempt" });
  } catch (error) { return readRefusal(error) ?? unexpected(error); }
}
