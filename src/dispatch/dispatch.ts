import { randomUUID } from "node:crypto";
import { AttemptConflict, type AttemptLog, type AttemptRecord, type AttemptRef } from "../attempts/log.ts";
import type { DeliveryContract, WorkerInput, WorkerResult } from "../runtime/contracts.ts";
import type { PiRunReport, WorkerHooks } from "../runtime/pi/worker.ts";
import type { RuntimeRecord, RuntimeRecords } from "../runtime/records.ts";
import { TaskStoreError, type Task, type TaskStore } from "../tasks/store.ts";
import { WorkspaceError, type Allocation, type Lease, type WorkspaceProvider } from "../workspaces/provider.ts";
import type { RetentionRequest, RetentionResult } from "../workspaces/retention.ts";
import { result, type AttemptSummary, type DispatchResult, type NextAction, type Stage } from "./result.ts";

/** The parts of a delivery contract chosen per task; the base, branch and starting commit are added per attempt. */
export type ContractSpec = Pick<DeliveryContract, "kind" | "acceptance" | "requiredEvidence" | "requiredDeliverables">;
export type DeliveryConfiguration = {
  baseRef: string;
  branchPrefix: string;
  /** Used for a task with no kind. */
  default: ContractSpec;
  /** Contracts selected by task kind. A task whose kind is not listed is refused before any change. */
  byTaskKind: Record<string, ContractSpec>;
};

export type Dependencies = {
  contextId: string;
  tasks: TaskStore;
  workspaces: WorkspaceProvider;
  attempts: AttemptLog;
  runtime: RuntimeRecords;
  launch: (input: WorkerInput, signal?: AbortSignal, onRequest?: WorkerHooks["onRequest"]) => Promise<PiRunReport>;
  retention: (request: RetentionRequest) => Promise<RetentionResult>;
  /** The repository whose refs the workspaces share, for retention checks. */
  repository: string;
  delivery: DeliveryConfiguration;
  /** A possibly running worker with no activity for this long is flagged in status. Default 20 minutes. */
  staleMs?: number;
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
  /** The workspace pool the provider currently lists. */
  pool: string;
  /**
   * Attempts whose lease was acquired in a different pool, so the provider no longer lists it and whether it is still
   * held is unknown. Each blocks its own task until the operator confirms the lease was returned.
   */
  leasesInOtherPools: (AttemptSummary & { pool: string })[];
};

type Failure = { failed: DispatchResult };
const isFailure = (value: unknown): value is Failure => typeof value === "object" && value !== null && "failed" in value;

/** Phase 1 PRD dispatch step 1: read every owner. Unreadable owner state refuses dispatch. */
export async function inspect(deps: Dependencies): Promise<Inspection | Failure> {
  const read = async <T>(what: string, load: () => Promise<T>): Promise<T | Failure> => {
    try { return await load(); }
    catch (error) { return { failed: refusal("preflight", "fix_configuration", `${what} could not be read: ${message(error)}`) }; }
  };
  const attempts = await read("The attempt log", () => deps.attempts.list());
  if (isFailure(attempts)) return attempts;
  const runtime = await read("Runtime records", () => deps.runtime.discover(deps.contextId));
  if (isFailure(runtime)) return runtime;
  const leases = await read("Workspace leases", () => deps.workspaces.leases());
  if (isFailure(leases)) return leases;
  const pool = await read("The workspace pool", () => deps.workspaces.pool());
  if (isFailure(pool)) return pool;
  const inFlight = await read("The task store", () => deps.tasks.inFlight());
  if (isFailure(inFlight)) return inFlight;
  const ready = await read("The task store", () => deps.tasks.ready());
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
    if (kinds.includes("launched") && !kinds.includes("worker_finished") && !resolvedBy(attempt, "worker_stopped") &&
      !possiblyRunning.some(p => p.taskId === attempt.taskId && p.attempt === attempt.attempt)) {
      possiblyRunning.push(summarise(attempt));
    }
  }
  const leasesInOtherPools: Inspection["leasesInOtherPools"] = [];
  for (const attempt of attempts) {
    const leased = attempt.entries.find(e => e.kind === "leased")?.data.pool;
    if (typeof leased === "string" && leased !== pool && !resolvedBy(attempt, "lease_returned")) {
      leasesInOtherPools.push({ ...summarise(attempt), pool: leased });
    }
  }
  return { attempts, runtime, leases, inFlight, ready, possiblyRunning, pool, leasesInOtherPools };
}

/** Runs one dispatch: steps 1–8 of the Phase 1 PRD dispatch sequence. Never starts a second task. */
export async function dispatchOnce(
  deps: Dependencies, options: { taskId?: string; requestId?: string; signal?: AbortSignal; dryRun?: boolean } = {},
): Promise<DispatchResult> {
  if (options.requestId !== undefined) {
    const existing = await deps.attempts.findByRequest(options.requestId).catch(() => undefined);
    if (existing) return existingRequest(deps, existing);
  }
  const state = await inspect(deps);
  if (isFailure(state)) return state.failed;
  const observed = { ready: state.ready, inFlight: state.inFlight, leases: state.leases.length };
  if (state.possiblyRunning.length > 0) {
    return refusal("preflight", "stop_worker", "An earlier attempt's worker may still be running", { ...observed, possiblyRunning: state.possiblyRunning });
  }

  try { await deps.runtime.probeExclusiveCreation(); }
  catch (error) {
    return refusal("preflight", "fix_configuration", `Runtime storage exclusive-creation check failed: ${message(error)}. Configure a writable runtime directory that enforces exclusive creation`, observed);
  }

  // Step 2: select one ready task with no lease and no in-flight state.
  const unknownLease = (id: string) => state.leasesInOtherPools.some(a => a.taskId === id);
  const blocked = (id: string) => state.leases.some(l => l.holder === id) || unknownLease(id) || state.inFlight.includes(id);
  let taskId = options.taskId;
  if (taskId !== undefined) {
    if (state.leases.some(l => l.holder === taskId)) return refusal("select", "choose_another_task", `Task ${taskId} already has a workspace lease from an earlier attempt`, observed);
    if (unknownLease(taskId)) {
      return refusal("select", "confirm_lease_returned", `Task ${taskId} has a lease from an earlier attempt in a workspace pool that is no longer listed, so whether it is still held is unknown`, observed);
    }
    if (state.inFlight.includes(taskId)) return refusal("select", "choose_another_task", `Task ${taskId} is already in flight`, observed);
    if (!state.ready.includes(taskId)) return refusal("select", "choose_another_task", `Task ${taskId} is not ready`, observed);
  } else {
    taskId = state.ready.find(id => !blocked(id));
    if (taskId === undefined) return result({ ok: true, reason: "no_ready_work", stage: "select", lease: "none", observed, nextAction: "dispatch_again" });
  }
  // Resolve the delivery contract before any change; a task whose contract cannot be resolved is refused.
  let selected: Task | undefined;
  try { selected = await deps.tasks.read(taskId); }
  catch (error) { return refusal("select", "fix_configuration", `The task store could not be read: ${message(error)}`, observed); }
  if (!selected) return refusal("select", "choose_another_task", `Task ${taskId} no longer exists`, observed);
  const contractName = selected.kind ?? "default";
  const contract = selected.kind === null ? deps.delivery.default : deps.delivery.byTaskKind[selected.kind];
  if (!contract) {
    return refusal("select", "fix_configuration", `Task ${taskId} has kind "${selected.kind}", which has no delivery contract in the configuration`, observed);
  }

  if (options.dryRun) {
    return result({
      ok: true, reason: "dry_run", stage: "select", lease: "none", observed,
      selection: { taskId, contract: { name: contractName, ...contract } }, nextAction: "none",
    });
  }

  const previous = state.attempts.filter(a => a.taskId === taskId).map(a => a.attempt).at(-1) ?? 0;
  let ref: AttemptRef;
  try {
    ref = await deps.attempts.create(taskId, {
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }), contract: { name: contractName, ...contract },
    }, previous);
  } catch (error) {
    if (error instanceof AttemptConflict) return refusal("select", "inspect_attempt", `Another invocation created an attempt for task ${taskId} first`, observed);
    return refusal("select", "fix_configuration", `The attempt log could not be written: ${message(error)}`, observed);
  }
  const summary: AttemptSummary = { contextId: deps.contextId, taskId, attempt: ref.attempt, ...(options.requestId ? { requestId: options.requestId } : {}) };
  deps.progress?.(`Task ${taskId}, attempt ${ref.attempt}`);
  // Stopped after a change: record why in the attempt log and preserve whatever exists.
  const halt = async (stage: Stage, nextAction: NextAction, detail: string) => {
    await deps.attempts.append(ref, "halted", { stage, reason: "stopped", detail: detail.slice(0, 4000) }).catch(() => {});
    return result({ ok: false, reason: "stopped", stage, lease: summary.leaseId ? "preserved" : "none", observed, attempt: summary, detail, nextAction });
  };

  // Step 3: acquire a lease for the exact task ID on a unique output branch.
  const outputBranch = `${deps.delivery.branchPrefix}${taskId}/attempt-${ref.attempt}`;
  let allocation: Allocation;
  try {
    allocation = await deps.workspaces.acquire({ holder: taskId, baseRef: deps.delivery.baseRef, branch: outputBranch });
  } catch (error) {
    if (error instanceof WorkspaceError && error.reason === "rejected") return halt("acquire", "fix_configuration", `The workspace provider refused the lease: ${message(error)}`);
    // Inspect by holder and branch instead of acquiring again, and report whatever lease exists.
    const found = await deps.workspaces.leases().then(all => all.filter(l => l.holder === taskId && l.branch === outputBranch), () => undefined);
    const lease = found === undefined ? "unknown" : found.length > 0 ? "preserved" : "none";
    if (found?.[0]) Object.assign(summary, { leaseId: found[0].leaseId, workspace: found[0].path, outputBranch });
    const stopped = await halt("acquire", "inspect_attempt", `The lease outcome is unknown or unexpected: ${message(error)}`);
    return { ...stopped, lease, attempt: summary };
  }
  Object.assign(summary, { leaseId: allocation.leaseId, workspace: allocation.path, outputBranch, startingCommit: allocation.startingCommit });
  await deps.attempts.append(ref, "leased", {
    leaseId: allocation.leaseId, workspace: allocation.path, baseRef: deps.delivery.baseRef, outputBranch, startingCommit: allocation.startingCommit,
    pool: allocation.pool,
  });
  deps.progress?.(`Lease ${allocation.leaseId} at ${allocation.path}`);

  // Steps 4–5: re-read readiness, then mark in flight and confirm it before launching.
  let task: Task | undefined;
  try {
    if (!(await deps.tasks.ready()).includes(taskId)) return halt("start", "return_unused_lease", "The task stopped being ready after the lease was acquired");
    task = await deps.tasks.start(taskId);
  } catch (error) {
    if (error instanceof TaskStoreError && error.reason === "rejected") return halt("start", "return_unused_lease", `The task store refused to mark the task in flight: ${message(error)}`);
    // Read back: the change may have applied even though it was not confirmed.
    task = await deps.tasks.read(taskId).catch(() => undefined);
    if (task?.state !== "in_flight") return halt("start", "inspect_attempt", `The task store did not confirm the task is in flight: ${message(error)}`);
  }
  await deps.attempts.append(ref, "task_started", {});

  // Steps 6–7: launch exactly one worker and observe it until its direct child exits.
  const delivery: DeliveryContract = {
    baseRef: deps.delivery.baseRef, startingCommit: allocation.startingCommit, outputBranch, kind: contract.kind,
    acceptance: contract.acceptance, requiredEvidence: contract.requiredEvidence, requiredDeliverables: contract.requiredDeliverables,
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
  // Each stop request or operator message the worker forwards is recorded with its sender (ADR-0005).
  let requests = Promise.resolve();
  const onRequest: WorkerHooks["onRequest"] = (request, outcome) => {
    requests = requests.then(() => deps.attempts.append(ref, "operator_request", {
      id: request.id, kind: request.kind, sender: request.sender, outcome: outcome.outcome,
      ...(request.message ? { message: request.message.slice(0, 4000) } : {}), ...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}),
    })).catch(() => {});
  };
  try { report = await deps.launch(input, options.signal, onRequest); }
  catch (error) {
    // The runtime refused before starting a worker; nothing was launched.
    await deps.attempts.append(ref, "worker_finished", { status: "not_started", runtimeDirectory: "-", reason: message(error).slice(0, 500) });
    return finalise(deps, ref, summary, observed, task, delivery, undefined, `Worker not started: ${message(error)}`);
  }
  await requests;
  const resultCommit = codeCommit(report.result, outputBranch);
  if (resultCommit) summary.resultCommit = resultCommit;
  await deps.attempts.append(ref, "worker_finished", {
    status: report.status, runtimeDirectory: report.directory,
    ...(report.reason ? { reason: report.reason } : {}), ...(report.result ? { outcome: report.result.outcome } : {}),
    ...(resultCommit ? { resultCommit } : {}),
  });
  if (report.status === "unresolved") {
    return result({ ok: false, reason: "stopped", stage: "launch", lease: "preserved", observed, attempt: summary, worker: { status: report.status }, detail: "The worker's exit was not observed, so it may still be running", nextAction: "stop_worker" });
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
    // For a non-code deliverable the workspace is scratch; only the artefacts must be retained.
    ...(delivery.kind === "artefact" ? { scratchWorkspace: true } : {}),
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
      return result({ ok: false, reason: "stopped", stage: "finalise", lease: "preserved", observed, attempt: summary, worker, retention, detail: `The final task update could not be confirmed: ${message(error)}`, nextAction: "complete_task_update" });
    }
    recorded = now!;
  }
  await deps.attempts.append(ref, "task_recorded", { outcome: outcome.done ? "done" : "hold", reason: outcome.done ? "done" : holdReason });
  return result({
    ok: outcome.done, reason: outcome.done ? "done" : "held", stage: "finalise", lease: "preserved", observed, attempt: summary, worker, retention,
    task: { id: recorded.id, state: recorded.state, held: recorded.held, holdReason: recorded.holdReason },
    ...(outcome.done ? {} : { detail: holdReason }),
    nextAction: outcome.done ? "return_lease" : outcome.review ? "review_branch" : "inspect_attempt",
  });
}

/** The outcome table in the Phase 1 PRD. Only a valid, retained completion with an independent contract is done. */
function decide(report: PiRunReport | undefined, delivery: DeliveryContract, retention: RetentionResult): { done: boolean; review: boolean; label: string } {
  const hold = (label: string, review = false) => ({ done: false, review, label });
  if (!report || report.status === "failed") return hold("failed");
  if (report.status === "interrupted") return hold(report.reason === "over_budget" ? "over budget" : "interrupted");
  const outcome = report.result?.outcome;
  if (outcome === "hold") return hold("held by worker");
  if (outcome !== "completed") return hold("failed");
  if (!retention.retained) return hold("not retained");
  if (delivery.acceptance === "review_or_integration") return hold("review required", true);
  return { done: true, review: false, label: "done" };
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

/** Whether the operator recorded this confirmation for the attempt with `resolve`. */
export function resolvedBy(attempt: AttemptRecord, action: "worker_stopped" | "lease_returned"): boolean {
  return attempt.entries.some(e => e.kind === "operator_resolved" && e.data.action === action);
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

/** Refused before any change: nothing to preserve or undo. */
function refusal(stage: Stage, nextAction: NextAction, detail: string, observed: Record<string, unknown> = {}): DispatchResult {
  return result({ ok: false, reason: "refused", stage, lease: "none", observed, detail, nextAction });
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
