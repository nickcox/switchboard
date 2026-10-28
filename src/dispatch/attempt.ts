import type { AttemptRecord } from "../attempts/log.ts";
import type { AttemptSummary } from "./result.ts";

/** An attempt is open until it records a task outcome, halts, or is resolved by the operator. */
export function isOpen(attempt: AttemptRecord): boolean {
  return !attempt.entries.some(e => e.kind === "task_recorded" || e.kind === "halted" || e.kind === "operator_resolved");
}

/**
 * The pool in which this attempt may hold a lease. A logged lease records its pool. Without one, the attempt may still
 * have acquired a lease in the pool recorded when it was requested, for example if its dispatcher was killed before
 * logging the lease, unless the provider refused the acquisition outright.
 */
export function possibleLeasePool(attempt: AttemptRecord): string | undefined {
  const leased = attempt.entries.find(e => e.kind === "leased")?.data.pool;
  if (typeof leased === "string") return leased;
  if (attempt.entries.some(e => e.kind === "leased")) return undefined;
  const refused = attempt.entries.some(e => e.kind === "halted" && e.data.stage === "acquire" && e.data.reason !== "outcome_unknown");
  const requested = attempt.entries[0]?.data.pool;
  return !refused && typeof requested === "string" ? requested : undefined;
}

/** Whether the attempt's lease is known to be returned: by `finish` or `discard`, or as confirmed by the operator. */
export function leaseReturned(attempt: AttemptRecord): boolean {
  return attempt.entries.some(e => e.kind === "lease_returned") || resolvedBy(attempt, "lease_returned");
}

/** Whether the operator recorded this confirmation for the attempt with `resolve`. */
export function resolvedBy(attempt: AttemptRecord, action: "worker_stopped" | "lease_returned"): boolean {
  const summary = summarise(attempt);
  return (attempt.confirmations ?? []).some(c => {
    if (c.fact === "worker_stopped" && action === "worker_stopped") return c.scope.leaseId === summary.leaseId &&
      (c.scope.sessionId === undefined || c.scope.sessionId === summary.sessionId);
    if (c.fact === "lease_returned" && action === "lease_returned") return (summary.leaseId === undefined || c.scope.leaseId === summary.leaseId) &&
      (summary.outputBranch === undefined || c.scope.outputBranch === summary.outputBranch);
    return false;
  });
}

export function summarise(attempt: AttemptRecord): AttemptSummary {
  const summary: AttemptSummary = { contextId: attempt.contextId, taskId: attempt.taskId, attempt: attempt.attempt };
  for (const entry of attempt.entries) {
    const d = entry.data as Record<string, string | undefined>;
    if (entry.kind === "requested" && d.requestId) summary.requestId = d.requestId;
    if (entry.kind === "leased") Object.assign(summary, { leaseId: d.leaseId, workspace: d.workspace, outputBranch: d.outputBranch, startingCommit: d.startingCommit });
    if (entry.kind === "halted" && d.leaseId) Object.assign(summary, { leaseId: d.leaseId, workspace: d.workspace, outputBranch: d.outputBranch });
    if (entry.kind === "launched" && d.sessionId) summary.sessionId = d.sessionId;
    if (entry.kind === "worker_finished" && d.resultCommit) summary.resultCommit = d.resultCommit;
  }
  return summary;
}

