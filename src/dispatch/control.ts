import { awaitDelivery, submitRequest, type ControlRequest } from "../runtime/requests.ts";
import type { Dependencies } from "./dispatch.ts";
import { observeAttempt } from "./observe.ts";
import { assessAttempt } from "./assess.ts";
import { checkCanControl } from "./safety.ts";
import { result, type DispatchResult } from "./result.ts";

/**
 * Asks the dispatcher that owns a running worker to stop it or pass it a message (Phase 1 PRD, watching and
 * controlling a running attempt). Never writes to the worker directly. A request no dispatcher takes within
 * `waitMs` is withdrawn and reported as undelivered.
 */
export async function requestControl(
  deps: Dependencies, options: { leaseId: string; kind: ControlRequest["kind"]; message?: string; sender: string; waitMs: number },
): Promise<DispatchResult> {
  const observation = await observeAttempt(deps, { leaseId: options.leaseId });
  const record = observation?.runtime.known ? observation.runtime.value : undefined;
  const base = { stage: "control" as const, lease: "preserved" as const, observed: { leaseId: options.leaseId } };
  if (!record) {
    return result({ ...base, ok: false, reason: "refused", lease: "none", detail: "No worker in this context has this lease ID", nextAction: "inspect_attempt" });
  }
  const assessment = assessAttempt(observation!);
  const attempt = { ...assessment.attempt, sessionId: record.binding.input.identity.sessionId };
  const permission = checkCanControl(assessment.facts);
  if (!permission.allowed) return result({ ...base, ok: false, reason: "refused", attempt, detail: permission.detail, nextAction: permission.nextAction, observed: { ...base.observed, refusal: permission } });
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
