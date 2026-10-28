import { describeChecks, type CheckResult } from "../attempts/checks.ts";
import type { AcceptanceEvidence } from "./safety.ts";
import type { CriteriaReport } from "../runtime/contracts.ts";
import { describeCriteriaReport } from "../runtime/criteria-report.ts";
import type { ContractSpec } from "./dispatch.ts";
import type { RetentionResult } from "../workspaces/retention.ts";

/**
 * Stable reason codes for every dispatch, status and resolve result (Phase 1 PRD, structured results). Each code is
 * a category of behaviour; `stage` says where it happened and `detail` explains the specific cause in prose, which is
 * not part of the stable interface. Renaming or removing a code is a breaking change for callers, including a future
 * supervisor.
 */
export const reasons = {
  answered: "The answer was recorded. Delivery outcomes are shown below; a finished worker is never restarted.",
  review_created: "A review task was created for the exact recorded output commit. No worker was launched.",
  dry_run: "A ready task and its delivery contract were selected. Nothing was changed or launched.",
  no_ready_work: "No task is ready in the configured repository.",
  done: "The worker's result satisfied the completion contract and the task is recorded as done.",
  held: "The attempt finished and the task is recorded as held. Its hold reason and the next action say why.",
  refused: "Nothing was changed. The detail says why the request could not go ahead.",
  stopped: "The attempt stopped after changing some state, which is preserved. The detail says where and why.",
  owner_read_retryable: "An owner read failed before any effect was attempted. The read can be tried again.",
  reconciliation_required: "An owner read failed after an effect or its intent. Reconciliation is required before any further effect.",
  task_definition_changed: "The task definition changed during acquisition. The attempt is held without launching and its lease is retained.",
  request_input_mismatch: "The request ID has already been used with different explicit inputs. Nothing was changed or launched.",
  reserved: "A new attempt was reserved from an earlier attempt's retained output. No workspace was acquired or worker launched.",
  existing_request: "An attempt with this request ID already exists; its current state is reported instead.",
  resolved: "The caller's confirmation was recorded. The attempt no longer blocks dispatch.",
  delivered: "The dispatcher that owns the worker took the request. The detail says what happened to it, if known.",
  undelivered: "No running dispatcher took the request in time, so it was withdrawn. It will never be forwarded.",
  finished: "The attempt was finished under the context's finalisation policy: its task is recorded as done.",
  discarded: "The attempt's work was discarded and its lease returned. Its task stays done if already done; otherwise it is held.",
  planned: "Nothing was changed. The detail lists what the command would do.",
  pruned: "Eligible finished attempts were archived and their records removed.",
  output_branches_cleaned: "Output-branch cleanup completed. Each deleted or kept branch is listed below.",
} as const;
export type Reason = keyof typeof reasons;

/** Where a result was decided, matching the Phase 1 PRD dispatch sequence. */
export type Stage = "preflight" | "select" | "acquire" | "start" | "launch" | "finalise" | "resolve" | "control" | "finish" | "prune";

export const nextActions = {
  none: "Nothing further is needed.",
  dispatch_again: "Run dispatch again when there is ready work.",
  inspect_attempt: "Inspect the attempt's task, lease and runtime records, resolve them, then dispatch again.",
  review_objective_budget: "Inspect objective show <id>. Ask its creator to raise its budget, extend its deadline, or confirm unknown finished usage with objective confirm-budget <id> --note <reason> before dispatching again.",
  retry_owner_read: "Repair the owner's availability if needed, then run the same command again to read it again.",
  reconcile_owner: "Inspect the owner and reconcile the recorded intent and outcome with resolve --lease <lease-id> --read-failure <sequence> --effect-outcome happened|not_happened --note <evidence>. For an acquisition in an unlisted pool with no known lease ID, return its lease by path, then use resolve --task <task-id> --lease-returned. Never repeat an effect whose outcome is uncertain.",
  stop_worker: "Confirm the worker has stopped, then run `switchboard resolve --lease <lease-id> --worker-stopped`.",
  confirm_lease_returned: "The lease is in a workspace pool the provider no longer lists, for example because the repository's origin remote was added or changed. Inspect the workspace at its recorded path and return the lease through Treehouse by that path, then run `switchboard resolve --lease <lease-id> --lease-returned`. If no lease ID was learned, use `switchboard resolve --task <task-id> --lease-returned` instead, with `--attempt <n>` if it is not the task's latest attempt.",
  confirm_attempt_stopped: "An earlier attempt for this task has not finished, and Switchboard cannot tell whether its dispatcher is still working on it. If it is, wait for it to finish. If it has stopped, return any lease it acquired through Treehouse, then run `switchboard resolve --task <task-id> --lease-returned`.",
  confirm_worker_stopped: "Check that no process from this worker is still running, for example with `lsof +D <workspace>` on macOS or Linux, or Resource Monitor on Windows, then run resolve again with --worker-stopped.",
  apply_task_outcome: "Read the task and the workspace, record the task outcome in the task store, and return the lease once the work is retained.",
  return_unused_lease: "Return the unused lease through Treehouse, check the task, then dispatch again.",
  fix_configuration: "Check the configuration and that the task store, Treehouse and runtime are reachable.",
  choose_another_task: "Choose a ready task without an earlier lease, or resolve the earlier attempt first.",
  watch_attempt: "Follow the attempt with `switchboard watch --lease <lease-id>`.",
  review_then_finish: "Review the output branch, then run `switchboard finish --lease <lease-id>` to integrate it and record the task as done. Add --no-processes to return the lease once no worker process remains.",
  finish_attempt: "The task is done with its lease retained. Run `switchboard finish --lease <lease-id> --no-processes` to return the lease once no worker process remains.",
  fix_or_discard: "The work is not retained. Fix the output branch or artefacts, then run `switchboard finish --lease <lease-id>`, or discard the work with `switchboard discard --lease <lease-id> --confirm --no-processes`.",
  confirm_no_processes: "Check that no process from the attempt's worker is still running in its workspace, for example with `lsof +D <workspace>` on macOS or Linux, then run the command again with --no-processes.",
  rebase_or_discard: "The target branch has commits the output branch does not. Review the output, then run `switchboard finish --lease <lease-id> --rebase` to rebase it onto the target branch, or discard the work with `switchboard discard --lease <lease-id> --confirm --no-processes`.",
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
  summary: string;
  stage?: Stage;
  attempt?: AttemptSummary;
  /** Read-only dispatch selection, before an attempt or workspace exists. */
  selection?: { taskId: string; contract: ContractSpec & { name: string } };
  worker?: { status: string; outcome?: string; summary?: string; reason?: string; nextAction?: string };
  task?: { id: string; state: string; held: boolean; holdReason: string | null };
  retention?: RetentionResult;
  resultDiscrepancy?: string;
  criteriaReport?: CriteriaReport;
  checks?: CheckResult[];
  acceptanceEvidence?: AcceptanceEvidence;
  /** A lease is absent, preserved, or unknown when its current state could not be checked. */
  lease: "none" | "preserved" | "unknown";
  /** Owner state the decision was based on, including anything that was unknown. */
  observed: Record<string, unknown>;
  detail?: string;
  nextAction: { code: NextAction; description: string };
};

export function result(fields: Omit<DispatchResult, "version" | "summary" | "nextAction"> & { nextAction: NextAction }): DispatchResult {
  const leaseSummary = { none: "Its lease was returned.", preserved: "Its lease is retained.", unknown: "Its lease state is unknown." };
  const summary = reasons[fields.reason] + (fields.reason === "finished" ? ` ${leaseSummary[fields.lease]}` : "");
  return { ...fields, version: 1, summary, nextAction: { code: fields.nextAction, description: nextActions[fields.nextAction] } };
}

export function describeAcceptanceEvidence(evidence: AcceptanceEvidence): string {
  return `Acceptance evidence${evidence.commit ? ` for ${evidence.commit}` : ""}: ${evidence.permission.allowed ? "sufficient" : `NOT sufficient – ${evidence.permission.detail}`}`;
}

export function describe(value: DispatchResult): string {
  const lines = [`${value.ok ? "OK" : "NOT OK"}: ${value.reason}${value.stage ? ` at ${value.stage}` : ""} – ${value.summary}`];
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
  if (value.acceptanceEvidence) lines.push(describeAcceptanceEvidence(value.acceptanceEvidence));
  lines.push(...describeChecks(value.checks));
  lines.push(...describeCriteriaReport(value.criteriaReport));
  if (value.task) lines.push(`Task state: ${value.task.state}${value.task.held ? `, held: ${value.task.holdReason}` : ""}`);
  if (value.retention) {
    lines.push(`Retention: ${value.retention.retained ? "retained" : "NOT retained"}`);
    for (const finding of value.retention.findings) lines.push(`  - ${finding}`);
    for (const note of value.retention.notes) lines.push(`  note: ${note}`);
  }
  lines.push(`Lease: ${value.lease}`);
  if (value.resultDiscrepancy) lines.push(`Result discrepancy: ${value.resultDiscrepancy}`);
  if (value.detail) lines.push(`Detail: ${value.detail}`);
  const cleanup = value.observed.startingPointCleanup;
  for (const entry of Array.isArray(cleanup) ? cleanup : [cleanup]) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.detail === "string") lines.push(`Starting-point cleanup: ${entry.detail}`);
    else if (entry.status === "planned" && typeof entry.branch === "string") lines.push(`Would remove starting-point branch ${entry.branch}`);
  }
  lines.push(`Next: ${value.nextAction.description}`);
  return lines.join("\n");
}
