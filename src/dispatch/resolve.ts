import { inspect, isOpen, resolvedBy, summarise, type Dependencies } from "./dispatch.ts";
import { result, type DispatchResult } from "./result.ts";
import { dispatcherRunning } from "../runtime/heartbeat.ts";

/**
 * Operator-only: records that a worker with no observed exit has stopped, so its attempt stops blocking dispatch.
 * Without `confirmed` it only reports what each owner holds. It never changes the task or the lease; the operator
 * applies the task outcome afterwards (Phase 1 PRD, operator recovery).
 */
export async function resolveStopped(
  deps: Dependencies, options: { leaseId: string; confirmed: boolean; note?: string },
): Promise<DispatchResult> {
  const state = await inspect(deps);
  if ("failed" in state) return state.failed;
  const runtime = state.runtime.find(r => r.binding.input.identity.leaseId === options.leaseId);
  const attempt = state.attempts.find(a => a.entries.some(e => e.kind === "leased" && e.data.leaseId === options.leaseId));
  const taskId = attempt?.taskId ?? runtime?.binding.input.identity.taskId;
  if (!taskId) {
    return result({ ok: false, reason: "refused", stage: "resolve", lease: "none", observed: { leaseId: options.leaseId }, detail: "No attempt or runtime record in this context has this lease ID", nextAction: "inspect_attempt" });
  }
  const task = await deps.tasks.read(taskId).catch(() => undefined);
  const leaseHeld = state.leases.some(l => l.leaseId === options.leaseId);
  const summary = attempt ? summarise(attempt) : { contextId: deps.contextId, taskId, attempt: 0, leaseId: options.leaseId, ...(runtime ? { sessionId: runtime.binding.input.identity.sessionId } : {}) };
  const observed = { runtime: runtime?.child.status ?? "no runtime record", leaseHeld, task: task ? { state: task.state, held: task.held } : "unreadable" };
  const common = { stage: "resolve" as const, attempt: summary, lease: leaseHeld ? "preserved" as const : "none" as const, observed };

  if (!state.possiblyRunning.some(p => p.leaseId === options.leaseId)) {
    return result({ ok: false, reason: "refused", ...common, detail: "No worker for this lease is waiting for confirmation that it has stopped", nextAction: "none" });
  }
  if (runtime && await dispatcherRunning(runtime.directory)) {
    return result({ ok: false, reason: "refused", ...common, detail: "The owning dispatcher appears to be running; follow the attempt with watch or request a stop", nextAction: "watch_attempt" });
  }
  if (!options.confirmed) return result({ ok: false, reason: "refused", ...common, detail: "Resolving needs the operator's confirmation that the worker has stopped", nextAction: "confirm_worker_stopped" });

  // A launch logged without runtime records may still be about to start its worker. Claim its runtime directory
  // first: the dispatcher reserves that directory exclusively before starting a worker, so it can then no longer start
  // one. If the directory already exists, the dispatcher is starting the worker now.
  if (!runtime && attempt?.entries.some(e => e.kind === "launched") && !await deps.runtime.fence(deps.contextId, options.leaseId)) {
    return result({ ok: false, reason: "refused", ...common, detail: "The dispatcher is starting this worker now; follow the attempt with watch or request a stop", nextAction: "watch_attempt" });
  }
  if (runtime?.child.status === "unknown") await deps.runtime.recordOperatorStop(runtime, options.note);
  if (attempt) {
    const kinds = attempt.entries.map(e => e.kind);
    if (kinds.includes("launched") && !kinds.includes("worker_finished") && !resolvedBy(attempt, "worker_stopped")) {
      await deps.attempts.append(attempt, "operator_resolved", { action: "worker_stopped", ...(options.note ? { note: options.note } : {}) });
    }
  }
  return result({ ok: true, reason: "resolved", ...common, nextAction: "apply_task_outcome" });
}

/**
 * Operator-only: records that any lease an attempt holds has been returned, so it stops blocking its task. It applies
 * to a lease in a workspace pool the provider no longer lists, and to an unfinished attempt whose dispatcher has
 * stopped without logging a lease. Switchboard cannot see either lease, so this is the operator's confirmation, not an
 * observation. It never changes the task or the lease.
 */
export async function resolveLeaseReturned(
  deps: Dependencies,
  options: ({ leaseId: string; taskId?: never; attempt?: never } | { taskId: string; attempt?: number; leaseId?: never }) & { note?: string },
): Promise<DispatchResult> {
  const state = await inspect(deps);
  if ("failed" in state) return state.failed;
  const candidates = state.attempts.filter(a => a.taskId === options.taskId);
  const attempt = options.taskId !== undefined
    ? options.attempt !== undefined ? candidates.find(a => a.attempt === options.attempt) : candidates.sort((a, b) => b.attempt - a.attempt)[0]
    : state.attempts.find(a => summarise(a).leaseId === options.leaseId);
  if (!attempt) {
    return result({ ok: false, reason: "refused", stage: "resolve", lease: "none", observed: options, detail: "No attempt in this context matches the given lease or task and attempt", nextAction: "inspect_attempt" });
  }
  const leaseId = summarise(attempt).leaseId;
  if (resolvedBy(attempt, "lease_returned")) {
    return result({ ok: false, reason: "refused", stage: "resolve", attempt: summarise(attempt), lease: "unknown", observed: { leaseId }, detail: "The operator has already confirmed this lease was returned", nextAction: "none" });
  }
  const other = state.leasesInOtherPools.find(a => a.taskId === attempt.taskId && a.attempt === attempt.attempt);
  const observed = { leaseId, pool: state.pool, ...(other ? { leasePool: other.pool } : {}) };
  const common = { stage: "resolve" as const, attempt: summarise(attempt), observed };
  if (!other && isOpen(attempt)) {
    if (state.possiblyRunning.some(p => p.taskId === attempt.taskId && p.attempt === attempt.attempt)) {
      return result({ ok: false, reason: "refused", ...common, lease: "unknown", detail: "This attempt's worker may still be running; confirm it stopped first", nextAction: "stop_worker" });
    }
    // An unfinished attempt may hold a lease it never logged; look for one by its holder and output branch.
    const outputBranch = summarise(attempt).outputBranch ?? `${deps.delivery.branchPrefix}${attempt.taskId}/attempt-${attempt.attempt}`;
    const listed = state.leases.find(l => l.leaseId === leaseId || (l.holder === attempt.taskId && l.branch === outputBranch));
    if (listed) {
      return result({ ok: false, reason: "refused", ...common, observed: { ...observed, leaseId: listed.leaseId }, lease: "preserved", detail: `Lease ${listed.leaseId} for this attempt is still listed; return it through Treehouse first`, nextAction: "return_unused_lease" });
    }
  } else if (!other) {
    const held = state.leases.some(l => l.leaseId === leaseId);
    return result({ ok: false, reason: "refused", ...common, lease: held ? "preserved" : "none", detail: "This lease is in the workspace pool Switchboard currently lists, so its state is read from the provider and needs no confirmation", nextAction: "none" });
  }
  await deps.attempts.append(attempt, "operator_resolved", { action: "lease_returned", ...(options.note ? { note: options.note } : {}) });
  return result({ ok: true, reason: "resolved", ...common, lease: "unknown", nextAction: "dispatch_again" });
}
