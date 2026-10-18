import { randomUUID } from "node:crypto";
import { AttemptConflict, type AttemptLog, type AttemptRecord, type AttemptRef } from "../attempts/log.ts";
import type { DeliveryContract, WorkerInput, WorkerResult } from "../runtime/contracts.ts";
import type { PiRunReport } from "../runtime/pi/worker.ts";
import type { RuntimeRecord, RuntimeRecords } from "../runtime/records.ts";
import { TaskStoreError, type Task, type TaskStore } from "../tasks/store.ts";
import { WorkspaceError, type Allocation, type Lease, type WorkspaceProvider } from "../workspaces/provider.ts";
import type { RetentionRequest, RetentionResult } from "../workspaces/retention.ts";
import { result, type AttemptSummary, type DispatchResult, type NextAction, type Reason } from "./result.ts";

export type DeliveryDefaults = Omit<DeliveryContract, "startingCommit" | "outputBranch"> & { branchPrefix: string };

export type Dependencies = {
  contextId: string;
  tasks: TaskStore;
  workspaces: WorkspaceProvider;
  attempts: AttemptLog;
  runtime: RuntimeRecords;
  launch: (input: WorkerInput, signal?: AbortSignal) => Promise<PiRunReport>;
  retention: (request: RetentionRequest) => Promise<RetentionResult>;
  /** The repository whose refs the workspaces share, for retention checks. */
  repository: string;
  delivery: DeliveryDefaults;
  progress?: (message: string) => void;
};

/** Owner state read before dispatch. Every field comes from its owner, not from memory. */
export type Inspection = {
  attempts: AttemptRecord[];
  runtime: RuntimeRecord[];
  leases: Lease[];
  inFlight: string[];
  ready: string[];
  /** Attempts whose worker may still be running: no observed child exit, or launched without a recorded finish. */
  possiblyRunning: AttemptSummary[];
};

type Failure = { failed: DispatchResult };
const isFailure = (value: unknown): value is Failure => typeof value === "object" && value !== null && "failed" in value;

/** Phase 1 PRD dispatch step 1: read every owner. Unreadable owner state refuses dispatch. */
export async function inspect(deps: Dependencies): Promise<Inspection | Failure> {
  const read = async <T>(reason: Reason, load: () => Promise<T>): Promise<T | Failure> => {
    try { return await load(); }
    catch (error) {
      return { failed: result({ ok: false, reason, lease: "none", observed: {}, detail: message(error), nextAction: "fix_configuration" }) };
    }
  };
  const attempts = await read("attempt_log_unreadable", () => deps.attempts.list());
  if (isFailure(attempts)) return attempts;
  const runtime = await read("runtime_unreadable", () => deps.runtime.discover(deps.contextId));
  if (isFailure(runtime)) return runtime;
  const leases = await read("workspace_unreadable", () => deps.workspaces.leases());
  if (isFailure(leases)) return leases;
  const inFlight = await read("store_unreadable", () => deps.tasks.inFlight());
  if (isFailure(inFlight)) return inFlight;
  const ready = await read("store_unreadable", () => deps.tasks.ready());
  if (isFailure(ready)) return ready;

  const possiblyRunning: AttemptSummary[] = [];
  for (const record of runtime) {
    if (record.child.status !== "unknown") continue;
    const { contextId, taskId, leaseId, sessionId } = record.binding.input.identity;
    const attempt = attempts.find(a => a.taskId === taskId && a.entries.some(e => e.kind === "leased" && e.data.leaseId === leaseId));
    possiblyRunning.push({ contextId, taskId, attempt: attempt?.attempt ?? 0, leaseId, sessionId });
  }
  for (const attempt of attempts) {
    const kinds = attempt.entries.map(e => e.kind);
    if (kinds.includes("launched") && !kinds.includes("worker_finished") &&
      !possiblyRunning.some(p => p.taskId === attempt.taskId && p.attempt === attempt.attempt)) {
      possiblyRunning.push(summarise(attempt));
    }
  }
  return { attempts, runtime, leases, inFlight, ready, possiblyRunning };
}

/** Runs one dispatch: steps 1–8 of the Phase 1 PRD dispatch sequence. Never starts a second task. */
export async function dispatchOnce(
  deps: Dependencies, options: { taskId?: string; requestId?: string; signal?: AbortSignal } = {},
): Promise<DispatchResult> {
  if (options.requestId !== undefined) {
    const existing = await deps.attempts.findByRequest(options.requestId).catch(() => undefined);
    if (existing) return existingRequest(deps, existing);
  }
  const state = await inspect(deps);
  if (isFailure(state)) return state.failed;
  const observed = { ready: state.ready, inFlight: state.inFlight, leases: state.leases.length };
  if (state.possiblyRunning.length > 0) {
    return result({ ok: false, reason: "attempt_may_be_running", lease: "none", observed: { ...observed, possiblyRunning: state.possiblyRunning }, nextAction: "stop_worker" });
  }

  // Step 2: select one ready task with no lease and no in-flight state.
  const blocked = (id: string) => state.leases.some(l => l.holder === id) || state.inFlight.includes(id);
  let taskId = options.taskId;
  if (taskId !== undefined) {
    if (state.leases.some(l => l.holder === taskId)) return refuse("task_has_lease", observed, "choose_another_task", taskId);
    if (state.inFlight.includes(taskId)) return refuse("task_in_flight", observed, "choose_another_task", taskId);
    if (!state.ready.includes(taskId)) return refuse("task_not_ready", observed, "choose_another_task", taskId);
  } else {
    taskId = state.ready.find(id => !blocked(id));
    if (taskId === undefined) return result({ ok: true, reason: "no_ready_work", lease: "none", observed, nextAction: "dispatch_again" });
  }
  const previous = state.attempts.filter(a => a.taskId === taskId).map(a => a.attempt).at(-1) ?? 0;
  let ref: AttemptRef;
  try {
    ref = await deps.attempts.create(taskId, options.requestId === undefined ? {} : { requestId: options.requestId }, previous);
  } catch (error) {
    if (error instanceof AttemptConflict) return refuse("attempt_conflict", observed, "inspect_attempt", taskId);
    return result({ ok: false, reason: "attempt_log_unreadable", lease: "none", observed, detail: message(error), nextAction: "fix_configuration" });
  }
  const summary: AttemptSummary = { contextId: deps.contextId, taskId, attempt: ref.attempt, ...(options.requestId ? { requestId: options.requestId } : {}) };
  deps.progress?.(`Task ${taskId}, attempt ${ref.attempt}`);
  const halt = async (reason: Reason, stage: string, nextAction: NextAction, extra: { detail?: string } = {}) => {
    const detail = extra.detail;
    await deps.attempts.append(ref, "halted", { stage, reason, ...(detail ? { detail: detail.slice(0, 4000) } : {}) }).catch(() => {});
    return result({ ok: false, reason, lease: summary.leaseId ? "preserved" : "none", observed, attempt: summary, nextAction, ...(detail ? { detail } : {}) });
  };

  // Step 3: acquire a lease for the exact task ID on a unique output branch.
  const outputBranch = `${deps.delivery.branchPrefix}${taskId}/attempt-${ref.attempt}`;
  let allocation: Allocation;
  try {
    allocation = await deps.workspaces.acquire({ holder: taskId, baseRef: deps.delivery.baseRef, branch: outputBranch });
  } catch (error) {
    const reason: Reason = error instanceof WorkspaceError
      ? ({ rejected: "lease_refused", outcome_unknown: "lease_outcome_unknown", unexpected_state: "lease_unexpected", unreadable: "workspace_unreadable" } as const)[error.reason]
      : "lease_outcome_unknown";
    return halt(reason, "acquire", reason === "lease_refused" ? "fix_configuration" : "inspect_attempt", { detail: message(error) });
  }
  Object.assign(summary, { leaseId: allocation.leaseId, workspace: allocation.path, outputBranch, startingCommit: allocation.startingCommit });
  await deps.attempts.append(ref, "leased", {
    leaseId: allocation.leaseId, workspace: allocation.path, baseRef: deps.delivery.baseRef, outputBranch, startingCommit: allocation.startingCommit,
  });
  deps.progress?.(`Lease ${allocation.leaseId} at ${allocation.path}`);

  // Steps 4–5: re-read readiness, then mark in flight and confirm it before launching.
  let task: Task | undefined;
  try {
    if (!(await deps.tasks.ready()).includes(taskId)) return halt("readiness_changed", "start", "return_unused_lease");
    task = await deps.tasks.start(taskId);
  } catch (error) {
    if (error instanceof TaskStoreError && error.reason === "rejected") return halt("start_refused", "start", "return_unused_lease", { detail: message(error) });
    task = await deps.tasks.read(taskId).catch(() => undefined);
    if (task?.state !== "in_flight") return halt("start_outcome_unknown", "start", "inspect_attempt", { detail: message(error) });
  }
  await deps.attempts.append(ref, "task_started", {});

  // Steps 6–7: launch exactly one worker and observe it until its direct child exits.
  const delivery: DeliveryContract = {
    baseRef: deps.delivery.baseRef, startingCommit: allocation.startingCommit, outputBranch, kind: deps.delivery.kind,
    acceptance: deps.delivery.acceptance, requiredEvidence: deps.delivery.requiredEvidence, requiredDeliverables: deps.delivery.requiredDeliverables,
  };
  const sessionId = randomUUID();
  summary.sessionId = sessionId;
  await deps.attempts.append(ref, "launched", { sessionId });
  deps.progress?.(`Session ${sessionId}`);
  const input: WorkerInput = {
    identity: { contextId: deps.contextId, taskId, leaseId: allocation.leaseId, sessionId },
    workspace: allocation.path, instructions: task.body.trim() === "" ? task.title : task.body, acceptanceCriteria: [], delivery,
  };
  let report: PiRunReport;
  try { report = await deps.launch(input, options.signal); }
  catch (error) {
    // The runtime refused before starting a worker; nothing was launched.
    await deps.attempts.append(ref, "worker_finished", { status: "not_started", runtimeDirectory: "-", reason: message(error).slice(0, 500) });
    return finalise(deps, ref, summary, observed, task, delivery, undefined, `Worker not started: ${message(error)}`);
  }
  const resultCommit = codeCommit(report.result, outputBranch);
  if (resultCommit) summary.resultCommit = resultCommit;
  await deps.attempts.append(ref, "worker_finished", {
    status: report.status, runtimeDirectory: report.directory,
    ...(report.reason ? { reason: report.reason } : {}), ...(report.result ? { outcome: report.result.outcome } : {}),
    ...(resultCommit ? { resultCommit } : {}),
  });
  if (report.status === "unresolved") {
    return result({ ok: false, reason: "worker_unresolved", lease: "preserved", observed, attempt: summary, worker: { status: report.status }, nextAction: "stop_worker" });
  }
  return finalise(deps, ref, summary, observed, task, delivery, report);
}

/** Step 8: decide the task outcome, check retention, record it and read it back. The lease is always preserved. */
async function finalise(
  deps: Dependencies, ref: AttemptRef, summary: AttemptSummary, observed: Record<string, unknown>,
  task: Task, delivery: DeliveryContract, report: PiRunReport | undefined, notStarted?: string,
): Promise<DispatchResult> {
  const worker = workerView(report, notStarted);
  const retention = await deps.retention({
    repository: deps.repository, workspace: summary.workspace!, outputBranch: delivery.outputBranch,
    ...(summary.resultCommit ? { resultCommit: summary.resultCommit } : {}),
    artefacts: (report?.result?.workReferences ?? []).flatMap(w => (w.kind === "artefact" ? [w.path] : [])),
  });
  await deps.attempts.append(ref, "retention_checked", retention);

  const outcome = decide(report, delivery, retention);
  const record = {
    attempt: summary, worker, retention,
    evidence: report?.result?.validationEvidence ?? [], workReferences: report?.result?.workReferences ?? [],
  };
  const holdReason = `Switchboard attempt ${ref.attempt} ${outcome.label}`;
  let recorded: Task | undefined;
  try {
    recorded = outcome.done
      ? await deps.tasks.recordDone(task.id, JSON.stringify(record))
      : await deps.tasks.recordHold(task.id, { reason: holdReason, body: `${task.body}\n\n## Switchboard attempt ${ref.attempt}\n\n${JSON.stringify(record, null, 2)}` });
  } catch (error) {
    // Read back before deciding: the update may have applied even though it was not confirmed.
    const now = await deps.tasks.read(task.id).catch(() => undefined);
    const applied = outcome.done ? now?.state === "done" : now?.held === true && now.holdReason === holdReason && now.state === "queued";
    if (!applied) {
      await deps.attempts.append(ref, "halted", { stage: "finalise", reason: "task_update_failed", detail: message(error).slice(0, 4000) }).catch(() => {});
      return result({ ok: false, reason: "task_update_failed", lease: "preserved", observed, attempt: summary, worker, retention, detail: message(error), nextAction: "complete_task_update" });
    }
    recorded = now!;
  }
  await deps.attempts.append(ref, "task_recorded", { outcome: outcome.done ? "done" : "hold", reason: outcome.done ? "done" : holdReason });
  return result({
    ok: outcome.done, reason: outcome.reason, lease: "preserved", observed, attempt: summary, worker, retention,
    task: { id: recorded.id, state: recorded.state, held: recorded.held, holdReason: recorded.holdReason },
    nextAction: outcome.done ? "none" : outcome.reason === "held_review_required" ? "review_branch" : "inspect_attempt",
  });
}

/** The outcome table in the Phase 1 PRD. Only a valid, retained completion with an independent contract is done. */
function decide(report: PiRunReport | undefined, delivery: DeliveryContract, retention: RetentionResult): { done: boolean; reason: Reason; label: string } {
  if (!report || report.status === "failed") return { done: false, reason: "held_worker_failed", label: "failed" };
  if (report.status === "interrupted") return { done: false, reason: "held_interrupted", label: "interrupted" };
  const outcome = report.result?.outcome;
  if (outcome === "hold") return { done: false, reason: "held_worker_hold", label: "held by worker" };
  if (outcome !== "completed") return { done: false, reason: "held_worker_failed", label: "failed" };
  if (!retention.retained) return { done: false, reason: "held_not_retained", label: "not retained" };
  if (delivery.acceptance === "review_or_integration") return { done: false, reason: "held_review_required", label: "review required" };
  return { done: true, reason: "done", label: "done" };
}

async function existingRequest(deps: Dependencies, attempt: AttemptRecord): Promise<DispatchResult> {
  const summary = summarise(attempt);
  const task = await deps.tasks.read(attempt.taskId).catch(() => undefined);
  const leased = summary.leaseId !== undefined;
  return result({
    ok: false, reason: "existing_request", attempt: summary, lease: leased ? "preserved" : "none",
    observed: { lastEntry: attempt.entries.at(-1)?.kind, ...(task ? {} : { task: "unreadable" }) },
    ...(task ? { task: { id: task.id, state: task.state, held: task.held, holdReason: task.holdReason } } : {}),
    nextAction: "inspect_attempt",
  });
}

export function summarise(attempt: AttemptRecord): AttemptSummary {
  const summary: AttemptSummary = { contextId: attempt.contextId, taskId: attempt.taskId, attempt: attempt.attempt };
  for (const entry of attempt.entries) {
    const d = entry.data as Record<string, string | undefined>;
    if (entry.kind === "requested" && d.requestId) summary.requestId = d.requestId;
    if (entry.kind === "leased") Object.assign(summary, { leaseId: d.leaseId, workspace: d.workspace, outputBranch: d.outputBranch, startingCommit: d.startingCommit });
    if (entry.kind === "launched" && d.sessionId) summary.sessionId = d.sessionId;
    if (entry.kind === "worker_finished" && d.resultCommit) summary.resultCommit = d.resultCommit;
  }
  return summary;
}

function refuse(reason: Reason, observed: Record<string, unknown>, nextAction: NextAction, taskId: string): DispatchResult {
  return result({ ok: false, reason, lease: "none", observed: { ...observed, taskId }, nextAction });
}

function workerView(report: PiRunReport | undefined, notStarted?: string): NonNullable<DispatchResult["worker"]> {
  if (!report) return { status: "not_started", ...(notStarted ? { reason: notStarted } : {}) };
  const r = report.result;
  const reason = r && r.outcome !== "completed" ? r.reason : report.detail ?? report.reason;
  return {
    status: report.status, ...(r ? { outcome: r.outcome, summary: r.summary } : {}),
    ...(reason ? { reason } : {}), ...(r && r.outcome !== "completed" ? { nextAction: r.nextAction } : {}),
  };
}

function codeCommit(value: WorkerResult | undefined, branch: string): string | undefined {
  const ref = value?.workReferences.find(w => w.kind === "git" && w.branch === branch);
  return ref?.kind === "git" ? ref.commit : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? `${error.message}${"detail" in error && typeof error.detail === "string" ? ` ${error.detail}` : ""}` : String(error);
}
