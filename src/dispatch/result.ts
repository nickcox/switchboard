import type { ContractSpec } from "./dispatch.ts";
import type { RetentionResult } from "../workspaces/retention.ts";

/**
 * Stable reason codes for every dispatch, status and resolve result (Phase 1 PRD, structured results). Each code is
 * a category of behaviour; `stage` says where it happened and `detail` explains the specific cause in prose, which is
 * not part of the stable interface. Renaming or removing a code is a breaking change for callers, including a future
 * supervisor.
 */
export const reasons = {
  dry_run: "A ready task and its delivery contract were selected. Nothing was changed or launched.",
  no_ready_work: "No task is ready in the configured repository.",
  done: "The worker's result satisfied the completion contract and the task is recorded as done.",
  held: "The attempt finished and the task is recorded as held. Its hold reason and the next action say why.",
  refused: "Nothing was changed. The detail says why the request could not go ahead.",
  stopped: "The attempt stopped after changing some state, which is preserved. The detail says where and why.",
  existing_request: "An attempt with this request ID already exists; its current state is reported instead.",
  resolved: "The operator's confirmation was recorded. The attempt no longer blocks dispatch.",
  delivered: "The dispatcher that owns the worker took the request. The detail says what happened to it, if known.",
  undelivered: "No running dispatcher took the request in time, so it was withdrawn. It will never be forwarded.",
  finished: "The attempt was finished under the context's finalisation policy: its task is recorded as done and its lease returned.",
  discarded: "The attempt's work was discarded and its lease returned. Its task stays done if already done; otherwise it is held.",
  planned: "Nothing was changed. The detail lists what the command would do.",
  pruned: "Eligible finished attempts were archived and their records removed.",
} as const;
export type Reason = keyof typeof reasons;

/** Where a result was decided, matching the Phase 1 PRD dispatch sequence. */
export type Stage = "preflight" | "select" | "acquire" | "start" | "launch" | "finalise" | "resolve" | "control" | "finish" | "prune";

export const nextActions = {
  none: "Nothing further is needed.",
  dispatch_again: "Run dispatch again when there is ready work.",
  review_branch: "Review the output branch, integrate it, then record the task as done in the task store. Return the lease after confirming the retention check.",
  inspect_attempt: "Inspect the attempt's task, lease and runtime records, resolve them, then dispatch again.",
  stop_worker: "Confirm the worker has stopped, then run `switchboard resolve --lease <lease-id> --worker-stopped`.",
  confirm_lease_returned: "The lease is in a workspace pool the provider no longer lists, for example because the repository's origin remote was added or changed. Inspect the workspace at its recorded path and return the lease through Treehouse by that path, then run `switchboard resolve --lease <lease-id> --lease-returned`. If no lease ID was learned, use `switchboard resolve --task <task-id> --lease-returned` instead, with `--attempt <n>` if it is not the task's latest attempt.",
  confirm_attempt_stopped: "An earlier attempt for this task has not finished, and Switchboard cannot tell whether its dispatcher is still working on it. If it is, wait for it to finish. If it has stopped, return any lease it acquired through Treehouse, then run `switchboard resolve --task <task-id> --lease-returned`.",
  confirm_worker_stopped: "Check that no process from this worker is still running, for example with `lsof +D <workspace>` on macOS or Linux, or Resource Monitor on Windows, then run resolve again with --worker-stopped.",
  apply_task_outcome: "Read the task and the workspace, record the task outcome in the task store, and return the lease once the work is retained.",
  return_unused_lease: "Return the unused lease through Treehouse, check the task, then dispatch again.",
  return_lease: "The task is done. Return the lease through Treehouse once the retention check is confirmed and the workspace is no longer needed.",
  fix_configuration: "Check the configuration and that the task store, Treehouse and runtime are reachable.",
  choose_another_task: "Choose a ready task without an earlier lease, or resolve the earlier attempt first.",
  complete_task_update: "Read the task in the task store and apply the outcome recorded in the attempt log.",
  watch_attempt: "Follow the attempt with `switchboard watch --lease <lease-id>`.",
  review_then_finish: "Review the output branch. To integrate it, record the task as done and return the lease, run `switchboard finish --lease <lease-id> --no-processes` once no worker process remains.",
  finish_attempt: "The task is done. Run `switchboard finish --lease <lease-id> --no-processes` to return the lease once no worker process remains.",
  fix_or_discard: "The work is not retained. Fix the output branch or artefacts, then run `switchboard finish --lease <lease-id> --no-processes`, or discard the work with `switchboard discard --lease <lease-id> --confirm --no-processes`.",
  confirm_no_processes: "Check that no process from the attempt's worker is still running in its workspace, for example with `lsof +D <workspace>` on macOS or Linux, then run the command again with --no-processes.",
  confirm_discard: "Discarding returns the lease and removes the workspace's contents, including uncommitted changes. If that is intended, run the command again with --confirm.",
  no_dispatcher: "No running dispatcher owns this worker. If it may still be running, stop it another way, then run `switchboard resolve --lease <lease-id> --worker-stopped`.",
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
  version: 1;
  ok: boolean;
  reason: Reason;
  stage?: Stage;
  attempt?: AttemptSummary;
  /** Read-only dispatch selection, before an attempt or workspace exists. */
  selection?: { taskId: string; contract: ContractSpec & { name: string } };
  worker?: { status: string; outcome?: string; summary?: string; reason?: string; nextAction?: string };
  task?: { id: string; state: string; held: boolean; holdReason: string | null };
  retention?: RetentionResult;
  /** Phase 1 never returns a lease, so a lease is absent, preserved, or unknown when leases could not be listed. */
  lease: "none" | "preserved" | "unknown";
  /** Owner state the decision was based on, including anything that was unknown. */
  observed: Record<string, unknown>;
  detail?: string;
  nextAction: { code: NextAction; description: string };
};

export function result(fields: Omit<DispatchResult, "version" | "nextAction"> & { nextAction: NextAction }): DispatchResult {
  return { ...fields, version: 1, nextAction: { code: fields.nextAction, description: nextActions[fields.nextAction] } };
}

export function describe(value: DispatchResult): string {
  const lines = [`${value.ok ? "OK" : "NOT OK"}: ${value.reason}${value.stage ? ` at ${value.stage}` : ""} – ${reasons[value.reason]}`];
  if (value.selection) lines.push(`Task ${value.selection.taskId}, delivery contract ${value.selection.contract.name}`);
  const a = value.attempt;
  if (a) {
    lines.push(`Task ${a.taskId}, attempt ${a.attempt}${a.requestId ? ` (request ${a.requestId})` : ""}`);
    if (a.leaseId) {
      lines.push(`Lease ${a.leaseId}${a.workspace ? ` at ${a.workspace}` : ""}${a.outputBranch ? ` on ${a.outputBranch}` : ""}${a.startingCommit ? ` from ${a.startingCommit}` : ""}`);
    }
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
