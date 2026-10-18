import type { RetentionResult } from "../workspaces/retention.ts";

/**
 * Stable reason codes for every dispatch and status result (Phase 1 PRD, structured results). Renaming or removing a
 * code is a breaking change for callers, including a future supervisor.
 */
export const reasons = {
  no_ready_work: "No task is ready in the configured repository.",
  done: "The worker's result satisfied the completion contract and the task is recorded as done.",
  existing_request: "An attempt with this request ID already exists; its current state is reported instead.",
  task_not_ready: "The requested task is not ready.",
  task_has_lease: "The task already has a workspace lease from an earlier attempt.",
  task_in_flight: "The task is already in flight.",
  attempt_may_be_running: "An earlier attempt's worker may still be running, so no new attempt is started.",
  attempt_conflict: "Another invocation created an attempt for this task first.",
  store_unreadable: "The task store could not be read.",
  workspace_unreadable: "Workspace leases could not be listed.",
  runtime_unreadable: "Runtime records could not be read.",
  attempt_log_unreadable: "The attempt log could not be read.",
  lease_refused: "The workspace provider refused to create a lease. The task is unchanged.",
  lease_outcome_unknown: "The workspace provider did not confirm whether a lease was created.",
  lease_unexpected: "A lease was created but does not match the request.",
  readiness_changed: "The task stopped being ready after the lease was acquired. No worker was started.",
  start_refused: "The task store refused to mark the task in flight. No worker was started.",
  start_outcome_unknown: "The task store did not confirm the task is in flight. No worker was started.",
  worker_unresolved: "The worker's process exit was not observed, so it may still be running.",
  held_review_required: "The worker completed, and the task is held for review or integration.",
  held_worker_hold: "The worker asked for the task to be held.",
  held_worker_failed: "The worker failed or produced no valid result, and the task is held.",
  held_interrupted: "The operator interrupted the worker, and the task is held.",
  held_not_retained: "The worker reported completion but its work is not retained, so the task is held.",
  task_update_failed: "The final task update could not be confirmed.",
} as const;
export type Reason = keyof typeof reasons;

export const nextActions = {
  none: "Nothing further is needed.",
  dispatch_again: "Run dispatch again when there is ready work.",
  review_branch: "Review the output branch, integrate it, then record the task as done in the task store. Return the lease after confirming the retention check.",
  inspect_attempt: "Inspect the attempt's task, lease and runtime records, resolve them, then dispatch again.",
  stop_worker: "Confirm the worker has stopped, then record the task outcome and resolve the lease.",
  return_unused_lease: "Return the unused lease through Treehouse, check the task, then dispatch again.",
  fix_configuration: "Check the configuration and that the task store, Treehouse and runtime are reachable.",
  choose_another_task: "Choose a ready task without an earlier lease, or resolve the earlier attempt first.",
  complete_task_update: "Read the task in the task store and apply the outcome recorded in the attempt log.",
} as const;
export type NextAction = keyof typeof nextActions;

export type AttemptSummary = {
  contextId: string;
  taskId: string;
  attempt: number;
  requestId?: string;
  leaseId?: string;
  workspace?: string;
  outputBranch?: string;
  startingCommit?: string;
  sessionId?: string;
  resultCommit?: string;
};

export type DispatchResult = {
  ok: boolean;
  reason: Reason;
  attempt?: AttemptSummary;
  worker?: { status: string; outcome?: string; summary?: string; reason?: string; nextAction?: string };
  task?: { id: string; state: string; held: boolean; holdReason: string | null };
  retention?: RetentionResult;
  /** Phase 1 never returns a lease, so a lease is either absent or preserved. */
  lease: "none" | "preserved";
  /** Owner state the decision was based on, including anything that was unknown. */
  observed: Record<string, unknown>;
  detail?: string;
  nextAction: { code: NextAction; description: string };
};

export function result(fields: Omit<DispatchResult, "nextAction"> & { nextAction: NextAction }): DispatchResult {
  return { ...fields, nextAction: { code: fields.nextAction, description: nextActions[fields.nextAction] } };
}

export function describe(value: DispatchResult): string {
  const lines = [`${value.ok ? "OK" : "NOT OK"}: ${value.reason} – ${reasons[value.reason]}`];
  const a = value.attempt;
  if (a) {
    lines.push(`Task ${a.taskId}, attempt ${a.attempt}${a.requestId ? ` (request ${a.requestId})` : ""}`);
    if (a.leaseId) lines.push(`Lease ${a.leaseId} at ${a.workspace} on ${a.outputBranch} from ${a.startingCommit}`);
    if (a.sessionId) lines.push(`Session ${a.sessionId}`);
    if (a.resultCommit) lines.push(`Result commit ${a.resultCommit}`);
  }
  if (value.worker) {
    const w = value.worker;
    lines.push(`Worker: ${w.status}${w.outcome ? `, outcome ${w.outcome}` : ""}${w.reason ? ` – ${w.reason}` : ""}`);
    if (w.summary) lines.push(`Summary: ${w.summary}`);
  }
  if (value.task) lines.push(`Task state: ${value.task.state}${value.task.held ? `, held: ${value.task.holdReason}` : ""}`);
  if (value.retention) {
    lines.push(`Retention: ${value.retention.retained ? "retained" : "NOT retained"}`);
    for (const finding of value.retention.findings) lines.push(`  - ${finding}`);
    for (const note of value.retention.notes) lines.push(`  note: ${note}`);
  }
  lines.push(`Lease: ${value.lease}`);
  if (value.detail) lines.push(`Detail: ${value.detail}`);
  lines.push(`Next: ${value.nextAction.description}`);
  return lines.join("\n");
}
