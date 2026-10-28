import { randomUUID } from "node:crypto";
import { type AttemptRecord, type AttemptRef, holdLabels, type OutcomeCategory } from "../attempts/log.ts";
import { AttemptStore, AttemptStoreError, type ArchivedRequest } from "../attempts/store.ts";
import { attemptSpecificationSchema, workerInput, type RuntimeSettings } from "../attempts/specification.ts";
import type { DeliveryContract, WorkerInput, WorkerResult } from "../runtime/contracts.ts";
import type { PiRunReport, WorkerHooks } from "../runtime/pi/worker.ts";
import type { RuntimeRecord, RuntimeRecords } from "../runtime/records.ts";
import { TaskStoreError, type Task, type TaskStore } from "../tasks/store.ts";
import { WorkspaceError, type Allocation, type Lease, type WorkspaceProvider } from "../workspaces/provider.ts";
import type { RetentionRequest, RetentionResult } from "../workspaces/retention.ts";
import type { PolicySources } from "./policy.ts";
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
  attempts: AttemptStore;
  maxAttempts?: number;
  runtime: RuntimeRecords;
  launch: (input: WorkerInput, signal?: AbortSignal, onRequest?: WorkerHooks["onRequest"], settings?: RuntimeSettings) => Promise<PiRunReport>;
  runtimeSettings: RuntimeSettings;
  configurationProvenance: Record<string, string>;
  retention: (request: RetentionRequest) => Promise<RetentionResult>;
  /** The repository whose refs the workspaces share, for retention checks. */
  repository: string;
  delivery: DeliveryConfiguration;
  /** A possibly running worker with no activity for this long is flagged in status. Default 20 minutes. */
  staleMs?: number;
  /** Where the finalisation policy's layers are found (Phase 2 PRD). Without it the policy is `manual`. */
  policy?: PolicySources;
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
  /**
   * Tasks whose latest attempt is open: it has recorded no task outcome, has not halted and has not been resolved by
   * the operator. Its dispatcher may still be working on it, so the task is not dispatched again until it finishes or
   * the operator resolves it.
   */
  openTasks: string[];
};

type Failure = { failed: DispatchResult };
const isFailure = (value: unknown): value is Failure => typeof value === "object" && value !== null && "failed" in value;

/** Phase 1 PRD dispatch step 1: read every owner. Unreadable owner state refuses dispatch. */
export async function inspect(deps: Dependencies): Promise<Inspection | Failure> {
  const read = async <T>(what: string, load: () => Promise<T>): Promise<T | Failure> => {
    try { return await load(); }
    catch (error) { return { failed: refusal("preflight", "fix_configuration", `${what} could not be read: ${message(error)}`) }; }
  };
  const attempts = await read("The attempt log", async () => deps.attempts.list());
  if (isFailure(attempts)) return attempts;
  const runtime = await read("Runtime records", () => deps.runtime.discover(deps.contextId));
  if (isFailure(runtime)) return runtime;
  for (const record of runtime) {
    if (record.child.status !== "unknown") continue;
    const identity = record.binding.input.identity;
    const attempt = attempts.find(a => a.taskId === identity.taskId && summarise(a).leaseId === identity.leaseId);
    const confirmed = attempt && deps.attempts.confirmations(attempt).find(c => c.fact === "worker_stopped" && c.scope.leaseId === identity.leaseId &&
      (c.scope.sessionId === undefined || c.scope.sessionId === identity.sessionId));
    if (confirmed) record.child = { status: "operator_confirmed_stopped", confirmedAt: confirmed.confirmedAt };
  }
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
    // The runtime owns liveness: an observed or confirmed exit settles it even if the log never recorded the finish.
    const leaseId = summarise(attempt).leaseId;
    const settled = runtime.some(r => r.binding.input.identity.leaseId === leaseId && r.child.status !== "unknown");
    if (kinds.includes("launched") && !kinds.includes("worker_finished") && !resolvedBy(attempt, "worker_stopped") && !settled &&
      !possiblyRunning.some(p => p.taskId === attempt.taskId && p.attempt === attempt.attempt)) {
      possiblyRunning.push(summarise(attempt));
    }
  }
  const leasesInOtherPools: Inspection["leasesInOtherPools"] = [];
  for (const attempt of attempts) {
    const leasePool = possibleLeasePool(attempt);
    if (leasePool !== undefined && leasePool !== pool && !leaseReturned(attempt)) {
      leasesInOtherPools.push({ ...summarise(attempt), pool: leasePool });
    }
  }
  const latest = new Map<string, AttemptRecord>();
  for (const attempt of attempts) {
    if ((latest.get(attempt.taskId)?.attempt ?? 0) < attempt.attempt) latest.set(attempt.taskId, attempt);
  }
  const openTasks = [...latest.values()].filter(isOpen).map(a => a.taskId);
  return { attempts, runtime, leases, inFlight, ready, possiblyRunning, pool, leasesInOtherPools, openTasks };
}

/** Runs one dispatch: steps 1–8 of the Phase 1 PRD dispatch sequence. Never starts a second task. */
export async function dispatchOnce(
  deps: Dependencies, options: { taskId?: string; requestId?: string; signal?: AbortSignal; dryRun?: boolean } = {},
): Promise<DispatchResult> {
  try {
    const roots = await deps.workspaces.recyclableRoots();
    await deps.runtime.checkStorage(roots);
    await deps.attempts.checkStorage(roots);
  } catch (error) {
    return refusal("preflight", "fix_configuration", `Runtime storage is not retained: ${message(error)}`);
  }
  if (options.requestId !== undefined) {
    try {
      const existing = await deps.attempts.findByRequest(options.requestId, { ...(options.taskId === undefined ? {} : { taskId: options.taskId }) });
      if (existing) return existingRequest(deps, existing, options.requestId);
    } catch (error) {
      if (error instanceof AttemptStoreError && error.reason === "request_input_mismatch") return result({
        ok: false, reason: "request_input_mismatch", stage: "preflight", lease: "none", observed: {}, detail: error.message, nextAction: "inspect_attempt",
      });
      return refusal("preflight", "fix_configuration", `Request records could not be read: ${message(error)}`,
        error instanceof AttemptStoreError ? { reason: error.reason } : {});
    }
  }
  const state = await inspect(deps);
  if (isFailure(state)) return state.failed;
  const observed: Record<string, unknown> = { ready: state.ready, inFlight: state.inFlight, leases: state.leases.length };
  if (state.possiblyRunning.length > 0) {
    return refusal("preflight", "stop_worker", "An earlier attempt's worker may still be running", { ...observed, possiblyRunning: state.possiblyRunning });
  }

  try { await deps.runtime.probeExclusiveCreation(); }
  catch (error) {
    return refusal("preflight", "fix_configuration", `Runtime storage exclusive-creation check failed: ${message(error)}. Configure a writable runtime directory that enforces exclusive creation`, observed);
  }

  // Step 2: select one ready task with no lease and no in-flight state.
  const unknownLease = (id: string) => state.leasesInOtherPools.some(a => a.taskId === id);
  const open = (id: string) => state.openTasks.includes(id);
  const blocked = (id: string) => state.leases.some(l => l.holder === id) || unknownLease(id) || state.inFlight.includes(id) || open(id);
  let taskId = options.taskId;
  if (taskId !== undefined) {
    if (state.leases.some(l => l.holder === taskId)) return refusal("select", "choose_another_task", `Task ${taskId} already has a workspace lease from an earlier attempt`, observed);
    if (unknownLease(taskId)) {
      return refusal("select", "confirm_lease_returned", `Task ${taskId} has a lease from an earlier attempt in a workspace pool that is no longer listed, so whether it is still held is unknown`, observed);
    }
    if (state.inFlight.includes(taskId)) return refusal("select", "choose_another_task", `Task ${taskId} is already in flight`, observed);
    if (!state.ready.includes(taskId)) return refusal("select", "choose_another_task", `Task ${taskId} is not ready`, observed);
    if (open(taskId)) {
      return refusal("select", "confirm_attempt_stopped", `Task ${taskId} has an earlier attempt that has not finished, and its dispatcher may still be working on it`, observed);
    }
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
    if (deps.attempts.activeCount() >= (deps.maxAttempts ?? 1)) return refusal("select", "inspect_attempt", "The context's attempt maximum has been reached", { ...observed, reason: "capacity" });
    return result({
      ok: true, reason: "dry_run", stage: "select", lease: "none", observed,
      selection: { taskId, contract: { name: contractName, ...contract } }, nextAction: "none",
    });
  }

  // Copy configuration before reservation; neither later edits nor acquisition may change this attempt's inputs.
  const configuration = structuredClone({ delivery: deps.delivery, runtime: deps.runtimeSettings, repository: deps.repository, provenance: deps.configurationProvenance });
  const resolvedContract = structuredClone(contract);
  let ref: AttemptRef;
  try {
    const reservation = await deps.attempts.reserveAttempt({ taskId, requestInputs: { ...(options.taskId === undefined ? {} : { taskId: options.taskId }) }, maximum: deps.maxAttempts ?? 1, repo: selected.repo, definitionRevision: selected.definitionRevision,
      specification: (task, ref) => ({
        version: 1, taskId: task.id, contextId: ref.contextId, definitionRevision: task.definitionRevision,
        title: task.title, instructions: task.body.trim() === "" ? task.title : task.body, acceptanceCriteria: [], repository: task.repo, kind: task.kind,
        backingRepository: configuration.repository, baseRef: configuration.delivery.baseRef,
        outputBranch: `${configuration.delivery.branchPrefix}${task.id}/attempt-${ref.attempt}`,
        delivery: resolvedContract, runtime: configuration.runtime, provenance: {
          ...configuration.provenance,
          definitionRevision: `task:${task.id}.definitionRevision`, title: `task:${task.id}.title`,
          instructions: `task:${task.id}.${task.body.trim() === "" ? "title" : "body"}`, kind: `task:${task.id}.kind`,
          ...Object.fromEntries(Object.keys(resolvedContract).map(key => [`delivery.${key}`,
            configuration.provenance[`delivery.${task.kind === null ? "default" : `byTaskKind.${task.kind}`}.${key}`] ?? "unknown"])),
        },
      }), requested: {
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }), contract: { name: contractName, ...contract }, pool: state.pool,
    } });
    ref = reservation.ref;
    if (!reservation.created) {
      const existing = await deps.attempts.findByRequest(options.requestId!);
      if (!existing) throw new Error("The reserved request record is missing");
      return existingRequest(deps, existing, options.requestId);
    }
  } catch (error) {
    if (error instanceof AttemptStoreError && error.reason === "request_input_mismatch") return result({
      ok: false, reason: "request_input_mismatch", stage: "select", lease: "none", observed, detail: error.message, nextAction: "inspect_attempt",
    });
    if (error instanceof AttemptStoreError || error instanceof TaskStoreError) return refusal("select", "inspect_attempt", error.message, { ...observed, reason: error.reason });
    return refusal("select", "fix_configuration", `The attempt store could not be written: ${message(error)}`, observed);
  }
  const summary: AttemptSummary = { contextId: deps.contextId, taskId, attempt: ref.attempt, ...(options.requestId ? { requestId: options.requestId } : {}) };
  deps.progress?.(`Task ${taskId}, attempt ${ref.attempt}`);
  // Stopped after a change: record why in the attempt log and preserve whatever exists.
  const halt = async (stage: Stage, nextAction: NextAction, detail: string, reason = "stopped") => {
    await deps.attempts.append(ref, "halted", {
      stage, reason, detail: detail.slice(0, 4000),
      ...(summary.leaseId ? { leaseId: summary.leaseId, workspace: summary.workspace, outputBranch: summary.outputBranch } : {}),
    }).catch(() => {});
    return result({ ok: false, reason: "stopped", stage, lease: summary.leaseId ? "preserved" : "none", observed, attempt: summary, detail, nextAction });
  };

  // A failure after the attempt exists, such as an attempt-log write failing, still produces a structured result that
  // names the stage and preserves whatever exists.
  let stage: Stage = "acquire";
  try {
    // The operator may have resolved this attempt while it was waiting; never acquire for a resolved attempt.
    if (resolvedBy(await deps.attempts.read(ref), "lease_returned")) {
      return halt("acquire", "inspect_attempt", "The operator resolved this attempt before its lease was acquired");
    }

    stage = "acquire";
    // Step 3: acquire a lease for the exact task ID on a unique output branch.
    const specification = attemptSpecificationSchema.parse(deps.attempts.read(ref).specification);
    const outputBranch = specification.outputBranch;
    let allocation: Allocation;
    try {
      allocation = await deps.workspaces.acquire({ holder: specification.taskId, baseRef: specification.baseRef, branch: outputBranch });
    } catch (error) {
      if (error instanceof WorkspaceError && error.reason === "rejected") return halt("acquire", "fix_configuration", `The workspace provider refused the lease: ${message(error)}`);
      // Inspect by holder and branch instead of acquiring again, and report whatever lease exists.
      const found = await deps.workspaces.leases().then(all => all.filter(l => l.holder === taskId && l.branch === outputBranch), () => undefined);
      const lease = found === undefined ? "unknown" : found.length > 0 ? "preserved" : "none";
      if (found?.[0]) Object.assign(summary, { leaseId: found[0].leaseId, workspace: found[0].path, outputBranch });
      const stopped = await halt("acquire", "inspect_attempt", `The lease outcome is unknown or unexpected: ${message(error)}`, "outcome_unknown");
      return { ...stopped, lease, attempt: summary };
    }
    Object.assign(summary, { leaseId: allocation.leaseId, workspace: allocation.path, outputBranch, startingCommit: allocation.startingCommit });
    await deps.attempts.append(ref, "leased", {
      leaseId: allocation.leaseId, workspace: allocation.path, baseRef: specification.baseRef, outputBranch: allocation.branch, startingCommit: allocation.startingCommit,
      pool: allocation.pool, backingRepository: allocation.backingRepository,
    });
    deps.progress?.(`Lease ${allocation.leaseId} at ${allocation.path}`);

    stage = "start";
    // Steps 4–5: readiness, task start and its entry are one transaction, after acquiring the lease.
    try { await deps.attempts.startReservedTask(ref); }
    catch (error) {
      if (error instanceof AttemptStoreError && error.reason === "task_definition_changed") {
        return result({ ok: false, reason: "task_definition_changed", stage: "start", lease: "preserved", observed, attempt: summary,
          detail: error.message, nextAction: "return_unused_lease" });
      }
      return halt("start", "return_unused_lease", `The task could not be started: ${message(error)}`);
    }

    stage = "launch";
    // Steps 6–7: launch exactly one worker and observe it until its direct child exits.
    const stored = deps.attempts.read(ref);
    const input = workerInput(attemptSpecificationSchema.parse(stored.specification), stored.allocation!, randomUUID());
    const delivery = input.delivery;
    const sessionId = input.identity.sessionId;
    summary.sessionId = sessionId;
    await deps.attempts.append(ref, "launched", { sessionId });
    deps.progress?.(`Session ${sessionId}`);
    let report: PiRunReport;
    // Each stop request or operator message the worker forwards is recorded with its sender (ADR-0005).
    let requests = Promise.resolve();
    const onRequest: WorkerHooks["onRequest"] = (request, outcome) => {
      requests = requests.then(() => deps.attempts.append(ref, "operator_request", {
        id: request.id, kind: request.kind, sender: request.sender, outcome: outcome.outcome,
        ...(request.message ? { message: request.message.slice(0, 4000) } : {}), ...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}),
      })).catch(error => {
        // The request reached the worker; failing to log it is reported with the result rather than dropped.
        unrecorded.push({ id: request.id, kind: request.kind, sender: request.sender, error: message(error).slice(0, 500) });
      });
    };
    const unrecorded: { id: string; kind: string; sender: string; error: string }[] = [];
    try { report = await deps.launch(input, options.signal, onRequest, specification.runtime); }
    catch (error) {
      // The runtime reserves its records before starting a worker, so a worker can exist only if they do. Without an
      // observed or confirmed exit, the error leaves the attempt unresolved, like any launch whose worker may be running.
      const records = await deps.runtime.discover(deps.contextId).catch(() => undefined);
      const runtime = records?.find(r => r.binding.input.identity.leaseId === allocation.leaseId);
      if (records === undefined || runtime?.child.status === "unknown") {
        if (runtime) await deps.attempts.append(ref, "worker_finished", { status: "unresolved", runtimeDirectory: runtime.directory, reason: message(error).slice(0, 500) });
        return result({ ok: false, reason: "stopped", stage: "launch", lease: "preserved", observed, attempt: summary, worker: { status: "unresolved" }, detail: `Launching failed after the worker may have started, so it may still be running: ${message(error)}`, nextAction: "stop_worker" });
      }
      await deps.attempts.append(ref, "worker_finished", { status: runtime ? "failed" : "not_started", runtimeDirectory: runtime?.directory ?? "-", reason: message(error).slice(0, 500) });
      // Awaited here, so that a failure while finalising reaches the handler below and is recorded.
      return await finalise(deps, ref, summary, observed, delivery, undefined, `${runtime ? "Worker failed" : "Worker not started"}: ${message(error)}`);
    }
    await requests;
    if (unrecorded.length > 0) observed.unrecordedRequests = unrecorded;
    if (report.result) {
      const runtime = (await deps.runtime.discover(deps.contextId, { leaseId: allocation.leaseId }))[0];
      if (!runtime?.validatedResult) throw new Error("The validated worker result was not recorded");
      report.result = runtime.validatedResult.content;
      if (runtime.resultDiscrepancy) observed.resultDiscrepancy = runtime.resultDiscrepancy;
    }
    const resultCommit = codeCommit(report.result, outputBranch);
    if (resultCommit) summary.resultCommit = resultCommit;
    await deps.attempts.append(ref, "worker_finished", {
      status: report.status, runtimeDirectory: report.directory,
      ...(report.reason ? { reason: report.reason } : {}), ...(report.detail ? { detail: report.detail.slice(0, 500) } : {}),
      ...(report.result ? { outcome: report.result.outcome } : {}),
      ...(resultCommit ? { resultCommit } : {}),
    });
    if (report.status === "unresolved") {
      return result({ ok: false, reason: "stopped", stage: "launch", lease: "preserved", observed, attempt: summary, worker: { status: report.status }, detail: "The worker's exit was not observed, so it may still be running", nextAction: "stop_worker" });
    }
    stage = "finalise";
    return await finalise(deps, ref, summary, observed, delivery, report);
  } catch (error) {
    const detail = `The attempt stopped at ${stage} because a step failed: ${message(error)}`;
    await deps.attempts.append(ref, "halted", { stage, reason: "error", detail: detail.slice(0, 4000) }).catch(() => {});
    return result({ ok: false, reason: "stopped", stage, lease: summary.leaseId ? "preserved" : "unknown", observed, attempt: summary, detail, nextAction: "inspect_attempt" });
  }
}

/** Step 8: decide the task outcome, check retention, record it and read it back. The lease is always preserved. */
async function finalise(
  deps: Dependencies, ref: AttemptRef, summary: AttemptSummary, observed: Record<string, unknown>,
  delivery: DeliveryContract, report: PiRunReport | undefined, notStarted?: string,
): Promise<DispatchResult> {
  const worker = workerView(report, notStarted);
  const retention = await deps.retention({
    repository: deps.attempts.read(ref).allocation!.backingRepository!, workspace: summary.workspace!, outputBranch: delivery.outputBranch,
    ...(summary.resultCommit ? { resultCommit: summary.resultCommit } : {}),
    gitReferences: (report?.result?.workReferences ?? []).flatMap(w => (w.kind === "git" ? [w] : [])),
    artefacts: (report?.result?.workReferences ?? []).flatMap(w => (w.kind === "artefact" ? [w.path] : [])),
    recyclableRoots: await deps.workspaces.recyclableRoots(),
    ...(report ? { artefactDirectory: report.binding.artefactDirectory } : {}),
    // For a non-code contract the workspace is scratch; reported deliverables are still checked.
    ...(delivery.kind === "artefact" ? { scratchWorkspace: true } : {}),
  });
  await deps.attempts.append(ref, "retention_checked", retention);

  const outcome = decide(report, delivery, retention);
  const holdReason = `Switchboard attempt ${ref.attempt} ${holdLabels[outcome.category]}`;
  const { task: recorded, applied } = await deps.attempts.recordOutcome(ref, {
    outcome: outcome.done ? "done" : "hold", reason: outcome.done ? "done" : holdReason, category: outcome.category,
  });
  return result({
    ok: outcome.done, reason: outcome.done ? "done" : "held", stage: "finalise", lease: "preserved", observed, attempt: summary, worker, retention,
    ...(typeof observed.resultDiscrepancy === "string" ? { resultDiscrepancy: observed.resultDiscrepancy } : {}),
    task: { id: recorded.id, state: recorded.state, held: recorded.held, holdReason: recorded.holdReason },
    ...(!applied ? { detail: "The attempt outcome was recorded, but a newer operator decision left the task unchanged" } : outcome.done ? {} : { detail: holdReason }),
    nextAction: outcome.done ? "finish_attempt" : outcome.category === "review_required" ? "review_then_finish" : "inspect_attempt",
  });
}

/** The outcome table in the Phase 1 PRD. Only a valid, retained completion with an independent contract is done. */
function decide(report: PiRunReport | undefined, delivery: DeliveryContract, retention: RetentionResult):
  { done: true; category: "done" } | { done: false; category: Exclude<OutcomeCategory, "done"> } {
  const hold = (category: Exclude<OutcomeCategory, "done">) => ({ done: false as const, category });
  if (!report || report.status === "failed") return hold("failed");
  if (report.status === "interrupted") return hold(report.reason === "over_budget" ? "over_budget" : "interrupted");
  const outcome = report.result?.outcome;
  if (outcome === "hold") return hold("held_by_worker");
  if (outcome !== "completed") return hold("failed");
  if (!retention.retained) return hold("not_retained");
  if (delivery.acceptance === "review_or_integration") return hold("review_required");
  return { done: true, category: "done" };
}

/** Reports an existing attempt from each owner's current state, as `status` does, not from the log alone. */
async function existingRequest(deps: Dependencies, attempt: AttemptRecord | ArchivedRequest, requestId?: string): Promise<DispatchResult> {
  if ("archived" in attempt) return result({
    ok: false, reason: "existing_request", lease: "none",
    attempt: { contextId: attempt.contextId, taskId: attempt.taskId, attempt: attempt.attempt, ...(requestId === undefined ? {} : { requestId }) },
    observed: { archived: true, archive: attempt.summary }, nextAction: "inspect_attempt",
  });
  const summary = summarise(attempt);
  const task = await deps.tasks.read(attempt.taskId).catch(() => undefined);
  const state = await inspect(deps);
  let lease: DispatchResult["lease"] = "unknown";
  let running = false;
  if (!isFailure(state)) {
    running = state.possiblyRunning.some(p => p.taskId === attempt.taskId && p.attempt === attempt.attempt);
    const outputBranch = summary.outputBranch ?? `${deps.delivery.branchPrefix}${attempt.taskId}/attempt-${attempt.attempt}`;
    const listed = state.leases.some(l => l.leaseId === summary.leaseId || (l.holder === attempt.taskId && l.branch === outputBranch));
    const elsewhere = state.leasesInOtherPools.some(a => a.taskId === attempt.taskId && a.attempt === attempt.attempt);
    lease = listed ? "preserved" : elsewhere ? "unknown" : "none";
  }
  return result({
    ok: false, reason: "existing_request", attempt: summary, lease,
    observed: {
      lastEntry: attempt.entries.at(-1)?.kind, ...(task ? {} : { task: "unreadable" }),
      ...(isFailure(state) ? { owners: "unreadable" } : { possiblyRunning: running }),
    },
    ...(task ? { task: { id: task.id, state: task.state, held: task.held, holdReason: task.holdReason } } : {}),
    nextAction: running ? "stop_worker" : "inspect_attempt",
  });
}

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
