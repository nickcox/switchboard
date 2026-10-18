import { awaitDelivery, submitRequest, type ControlRequest } from "../runtime/requests.ts";
import { inspect, summarise, type Dependencies } from "./dispatch.ts";
import { result, type DispatchResult } from "./result.ts";

/**
 * Asks the dispatcher that owns a running worker to stop it or pass it a message (Phase 1 PRD, watching and
 * controlling a running attempt). Never writes to the worker directly. A request no dispatcher takes within
 * `waitMs` is withdrawn and reported as undelivered.
 */
export async function requestControl(
  deps: Dependencies, options: { leaseId: string; kind: ControlRequest["kind"]; message?: string; sender: string; waitMs: number },
): Promise<DispatchResult> {
  const state = await inspect(deps);
  if ("failed" in state) return state.failed;
  const record = state.runtime.find(r => r.binding.input.identity.leaseId === options.leaseId);
  const base = { stage: "control" as const, lease: "preserved" as const, observed: { leaseId: options.leaseId } };
  if (!record) {
    return result({ ...base, ok: false, reason: "refused", lease: "none", detail: "No worker in this context has this lease ID", nextAction: "inspect_attempt" });
  }
  const { contextId, taskId, leaseId, sessionId } = record.binding.input.identity;
  const logged = state.attempts.find(a => a.entries.some(e => e.kind === "leased" && e.data.leaseId === leaseId));
  const attempt = logged ? { ...summarise(logged), sessionId } : { contextId, taskId, attempt: 0, leaseId, sessionId };
  if (record.child.status !== "unknown") {
    return result({ ...base, ok: false, reason: "refused", attempt, detail: "The worker is not running", nextAction: "none" });
  }
  const request = await submitRequest(record, { kind: options.kind, sender: options.sender, ...(options.message ? { message: options.message } : {}) });
  const delivery = await awaitDelivery(record, request.id, options.waitMs);
  const observed = { ...base.observed, requestId: request.id };
  if (delivery.state === "undelivered") {
    return result({ ...base, ok: false, reason: "undelivered", attempt, observed, detail: `Request ${request.id} was withdrawn`, nextAction: "no_dispatcher" });
  }
  if (delivery.state === "claimed") {
    return result({ ...base, ok: false, reason: "delivered", attempt, observed, detail: "The dispatcher took the request but has not reported what happened. It will not be forwarded again.", nextAction: "watch_attempt" });
  }
  const failed = delivery.result.outcome === "failed";
  return result({
    ...base, ok: !failed, reason: "delivered", attempt, observed,
    detail: options.kind === "stop" ? "The dispatcher is stopping the worker; the task will be held as interrupted once its exit is observed"
      : `Pi's response: ${delivery.result.outcome}${delivery.result.error ? ` – ${delivery.result.error}` : ""}`,
    nextAction: "watch_attempt",
  });
}
