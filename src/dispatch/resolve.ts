import { inspect, summarise, type Dependencies } from "./dispatch.ts";
import { result, type DispatchResult } from "./result.ts";

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
  if (!options.confirmed) return result({ ok: false, reason: "refused", ...common, detail: "Resolving needs the operator's confirmation that the worker has stopped", nextAction: "confirm_worker_stopped" });

  if (runtime?.child.status === "unknown") await deps.runtime.recordOperatorStop(runtime, options.note);
  if (attempt) {
    const kinds = attempt.entries.map(e => e.kind);
    if (kinds.includes("launched") && !kinds.includes("worker_finished") && !kinds.includes("operator_resolved")) {
      await deps.attempts.append(attempt, "operator_resolved", { action: "worker_stopped", ...(options.note ? { note: options.note } : {}) });
    }
  }
  return result({ ok: true, reason: "resolved", ...common, nextAction: "apply_task_outcome" });
}
