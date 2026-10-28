import { resolvedBy } from "./attempt.ts";
import type { Dependencies } from "./dependencies.ts";
import { observeAttempt, type AttemptSelector } from "./observe.ts";
import { assessAttempt } from "./assess.ts";
import { checkCanConfirmLeaseReturned, checkCanConfirmStopped } from "./safety.ts";
import { result, type DispatchResult } from "./result.ts";

const operator = `operator:${process.env.USER ?? process.env.USERNAME ?? "unknown"}`;

/** Operator-only stop confirmation. It never changes the task or returns a lease. */
export async function resolveStopped(
  deps: Dependencies, options: { leaseId: string; confirmed: boolean; note?: string },
): Promise<DispatchResult> {
  const observation = await observeAttempt(deps, { leaseId: options.leaseId });
  if (!observation) return result({ ok: false, reason: "refused", stage: "resolve", lease: "none", observed: { leaseId: options.leaseId }, detail: "No attempt or runtime record in this context has this lease ID", nextAction: "inspect_attempt" });
  const assessment = assessAttempt(observation);
  const runtime = observation.runtime.known ? observation.runtime.value : undefined;
  const attempt = observation.record.known ? observation.record.value : undefined;
  const observed = { runtime: runtime?.child.status ?? "no runtime record", leaseHeld: assessment.leaseHeld, task: assessment.task };
  const common = { stage: "resolve" as const, attempt: assessment.attempt, lease: assessment.leaseHeld ? "preserved" as const : "none" as const, observed };
  const permission = checkCanConfirmStopped(assessment.facts, options.confirmed);
  if (!permission.allowed) return result({ ...common, ok: false, reason: "refused", detail: permission.detail, nextAction: permission.nextAction, observed: { ...observed, refusal: permission } });
  if (!attempt) return result({ ...common, ok: false, reason: "refused", detail: "The runtime has no attempt to record this confirmation against; restore or import its attempt records first", nextAction: "inspect_attempt" });

  // The immutable launch row prevents a pending launch after this confirmation.
  if (!runtime && attempt.entries.some(e => e.kind === "launched") && !await deps.runtime.fence(deps.contextId, options.leaseId)) {
    return result({ ...common, ok: false, reason: "refused", detail: "The dispatcher is starting this worker now; follow the attempt with watch or request a stop", nextAction: "watch_attempt" });
  }
  const current = await observeAttempt(deps, { leaseId: options.leaseId });
  const rechecked = current && checkCanConfirmStopped(assessAttempt(current).facts, options.confirmed);
  if (!rechecked || !rechecked.allowed) return result({ ...common, ok: false, reason: "refused", detail: rechecked ? rechecked.detail : "The attempt disappeared", nextAction: rechecked ? rechecked.nextAction : "inspect_attempt" });
  await deps.attempts.appendConfirmed(attempt, "operator_resolved", { action: "worker_stopped", ...(options.note ? { note: options.note } : {}) },
    { fact: "worker_stopped", scope: { leaseId: options.leaseId, ...(assessment.attempt.sessionId ? { sessionId: assessment.attempt.sessionId } : {}) } }, operator, current?.record.known ? current.record.value : undefined);
  return result({ ...common, ok: true, reason: "resolved", nextAction: "apply_task_outcome" });
}

/** Confirms a lease the provider cannot observe was returned. It never returns a lease itself. */
export async function resolveLeaseReturned(
  deps: Dependencies,
  options: ({ leaseId: string; taskId?: never; attempt?: never } | { taskId: string; attempt?: number; leaseId?: never }) & { note?: string },
): Promise<DispatchResult> {
  const selector: AttemptSelector = options.taskId !== undefined ? { taskId: options.taskId, ...(options.attempt === undefined ? {} : { attempt: options.attempt }) } : { leaseId: options.leaseId };
  const observation = await observeAttempt(deps, selector);
  if (!observation) return result({ ok: false, reason: "refused", stage: "resolve", lease: "none", observed: options, detail: "No attempt in this context matches the given lease or task and attempt", nextAction: "inspect_attempt" });
  const assessment = assessAttempt(observation);
  const attempt = observation.record.known ? observation.record.value : undefined;
  const summary = assessment.attempt;
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
  const rechecked = assessAttempt(current);
  const currentListed = current.leases.known && current.leases.value.some(l => l.leaseId === summary.leaseId || (l.holder === summary.taskId && l.branch === outputBranch));
  const fresh = checkCanConfirmLeaseReturned({ ...rechecked.facts, leaseHeld: currentListed });
  if (!fresh.allowed) return result({ ...common, ok: false, reason: "refused", detail: fresh.detail, nextAction: fresh.nextAction });
  await deps.attempts.appendConfirmed(attempt, "operator_resolved", { action: "lease_returned", ...(options.note ? { note: options.note } : {}) },
    { fact: "lease_returned", scope: { outputBranch, ...(summary.leaseId ? { leaseId: summary.leaseId } : {}) } }, operator, current.record.known ? current.record.value : undefined);
  return result({ ...common, ok: true, reason: "resolved", nextAction: "dispatch_again" });
}
