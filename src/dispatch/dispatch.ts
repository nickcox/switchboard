import { randomUUID } from "node:crypto";
import { type AttemptRecord, type AttemptRef, holdLabels, type OutcomeCategory } from "../attempts/log.ts";
import { AttemptStoreError, type ArchivedRequest } from "../attempts/store.ts";
import { attemptSpecificationSchema, workerInput } from "../attempts/specification.ts";
import type { DeliveryContract, WorkerResult } from "../runtime/contracts.ts";
import type { RunReport, WorkerHooks } from "../runtime/supervisor.ts";
import type { RuntimeRecord } from "../runtime/records.ts";
import { TaskStoreError, type Task } from "../tasks/store.ts";
import { WorkspaceError, type Allocation, type Lease } from "../workspaces/provider.ts";
import type { RetentionResult } from "../workspaces/retention.ts";
import { result, type AttemptSummary, type DispatchResult, type NextAction, type Stage } from "./result.ts";
import type { Dependencies } from "./dependencies.ts";
import { resolvedBy, summarise } from "./attempt.ts";
import { observeAttempts } from "./observe.ts";
import { assessAttempts, type AttemptAssessment } from "./assess.ts";
import { checkCanDispatch, checkCanRedispatch } from "./safety.ts";
import { OwnerReads, readRefusal } from "./owner-reads.ts";
export type { ContractSpec, DeliveryConfiguration, Dependencies } from "./dependencies.ts";

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
  assessments: AttemptAssessment[];
};

type Failure = { failed: DispatchResult };
const isFailure = (value: unknown): value is Failure => typeof value === "object" && value !== null && "failed" in value;

/** Phase 1 PRD dispatch step 1: read every owner. Unreadable owner state refuses dispatch. */
export async function inspect(deps: Dependencies, reads = new OwnerReads(deps, "dispatch")): Promise<Inspection | Failure> {
  const read = async <T>(what: string, load: () => Promise<T>): Promise<T | Failure> => {
    try { return await load(); }
    catch (error) { return { failed: readRefusal(await reads.failure(what, "preflight", error))! }; }
  };
  const observation = await observeAttempts(deps);
  try { await reads.context(observation, "preflight"); }
  catch (error) { return { failed: readRefusal(error)! }; }
  const { records: attempts, runtime, leases, pool } = observation;
  if (!attempts.known) return { failed: refusal("preflight", "fix_configuration", attempts.reason) };
  if (!runtime.known) return { failed: refusal("preflight", "fix_configuration", runtime.reason) };
  if (!leases.known) return { failed: refusal("preflight", "fix_configuration", leases.reason) };
  if (!pool.known) return { failed: refusal("preflight", "fix_configuration", pool.reason) };
  const assessments = assessAttempts(observation);
  for (const assessment of assessments) {
    const check = checkCanDispatch(assessment.facts);
    if (!check.allowed && check.reason === "unknown") return { failed: refusal("preflight", check.nextAction, check.detail) };
  }
  const inFlight = await read("The task store", () => deps.tasks.inFlight());
  if (isFailure(inFlight)) return inFlight;
  const ready = await read("The task store", () => deps.tasks.ready());
  if (isFailure(ready)) return ready;

  const possiblyRunning = assessments.filter(a => !checkCanDispatch(a.facts).allowed).map(a => a.attempt);
  const leasesInOtherPools = assessments.flatMap(a => a.leaseInOtherPool === undefined ? [] : [{ ...a.attempt, pool: a.leaseInOtherPool }]);
  const openTasks = assessments.filter(a => a.facts.unfinished).map(a => a.attempt.taskId);
  return { attempts: attempts.value, runtime: runtime.value, leases: leases.value, pool: pool.value,
    inFlight, ready, possiblyRunning, leasesInOtherPools, openTasks, assessments };
}

/** Runs one dispatch: steps 1–8 of the Phase 1 PRD dispatch sequence. Never starts a second task. */
export async function dispatchOnce(
  deps: Dependencies, options: { taskId?: string; requestId?: string; signal?: AbortSignal; dryRun?: boolean } = {},
): Promise<DispatchResult> {
  const reads = new OwnerReads(deps, "dispatch");
  return dispatchAttempt(deps, options, reads).catch(error => {
    const failed = readRefusal(error);
    return failed ? { ...failed, lease: reads.effectAttempted ? "unknown" : "none" } : refusal("preflight", "inspect_attempt", message(error));
  });
}

async function dispatchAttempt(deps: Dependencies, options: { taskId?: string; requestId?: string; signal?: AbortSignal; dryRun?: boolean }, reads: OwnerReads): Promise<DispatchResult> {
  try {
    const roots = await reads.read("Treehouse workspace roots", "check storage", () => deps.workspaces.recyclableRoots());
    await deps.runtime.checkStorage(roots);
    await deps.attempts.checkStorage(roots);
  } catch (error) {
    const failed = readRefusal(error);
    return failed ? { ...failed, lease: "none" } : refusal("preflight", "fix_configuration", `Runtime storage is not retained: ${message(error)}`);
  }
  if (options.requestId !== undefined) {
    try {
      const existing = await deps.attempts.findByRequest(options.requestId, { ...(options.taskId === undefined ? {} : { taskId: options.taskId }) });
      if (existing) return existingRequest(deps, existing, options.requestId, reads);
    } catch (error) {
      if (error instanceof AttemptStoreError && error.reason === "request_input_mismatch") return result({
        ok: false, reason: "request_input_mismatch", stage: "preflight", lease: "none", observed: {}, detail: error.message, nextAction: "inspect_attempt",
      });
      if (error instanceof AttemptStoreError) return refusal("preflight", "inspect_attempt", error.message, { reason: error.reason });
      return { ...readRefusal(await reads.failure("Attempt records", "read request record", error))!, lease: "none" };
    }
  }
  const state = await inspect(deps, reads);
  if (isFailure(state)) return { ...state.failed, lease: "none" };
  const observed: Record<string, unknown> = { ready: state.ready, inFlight: state.inFlight, leases: state.leases.length };
  for (const assessment of state.assessments) {
    const check = checkCanDispatch(assessment.facts);
    if (!check.allowed) return refusal("preflight", check.nextAction, check.detail, { ...observed, possiblyRunning: state.possiblyRunning });
  }

  try { await deps.runtime.probeExclusiveCreation(); }
  catch (error) {
    return refusal("preflight", "fix_configuration", `Runtime storage exclusive-creation check failed: ${message(error)}. Configure a writable runtime directory that enforces exclusive creation`, observed);
  }

  // Step 2: select one ready task with no lease and no in-flight state.
  const attemptChecks = (id: string) => state.assessments.filter(a => a.attempt.taskId === id).map(a => checkCanRedispatch(a.facts, id));
  const blocked = (id: string) => state.leases.some(l => l.holder === id) || state.inFlight.includes(id) || attemptChecks(id).some(check => !check.allowed);
  let taskId = options.taskId;
  if (taskId !== undefined) {
    if (state.leases.some(l => l.holder === taskId)) return refusal("select", "choose_another_task", `Task ${taskId} already has a workspace lease from an earlier attempt`, observed);
    const checks = attemptChecks(taskId);
    const unknownLease = checks.find(check => !check.allowed && check.reason === "lease_in_other_pool");
    if (unknownLease && !unknownLease.allowed) return refusal("select", unknownLease.nextAction, unknownLease.detail, observed);
    if (state.inFlight.includes(taskId)) return refusal("select", "choose_another_task", `Task ${taskId} is already in flight`, observed);
    if (!state.ready.includes(taskId)) return refusal("select", "choose_another_task", `Task ${taskId} is not ready`, observed);
    const unfinished = checks.find(check => !check.allowed);
    if (unfinished && !unfinished.allowed) return refusal("select", unfinished.nextAction, unfinished.detail, observed);
  } else {
    taskId = state.ready.find(id => !blocked(id));
    if (taskId === undefined) return result({ ok: true, reason: "no_ready_work", stage: "select", lease: "none", observed, nextAction: "dispatch_again" });
  }
  // Resolve the delivery contract before any change; a task whose contract cannot be resolved is refused.
  let selected: Task | undefined;
  try { selected = await deps.tasks.read(taskId); }
  catch (error) { return { ...readRefusal(await reads.failure("Task store", "read selected task", error), "select")!, lease: "none" }; }
  if (!selected) return refusal("select", "choose_another_task", `Task ${taskId} no longer exists`, observed);
  const contractName = selected.kind ?? "default";
  const contract = selected.kind === null ? deps.delivery.default : deps.delivery.byTaskKind[selected.kind];
  if (!contract) {
    return refusal("select", "fix_configuration", `Task ${taskId} has kind "${selected.kind}", which has no delivery contract in the configuration`, observed);
  }

  if (options.dryRun) {
    if (await reads.read("Attempt records", "check capacity", () => deps.attempts.activeCount()) >= (deps.maxAttempts ?? 1)) return refusal("select", "inspect_attempt", "The context's attempt maximum has been reached", { ...observed, reason: "capacity" });
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
        title: task.title, instructions: task.body.trim() === "" ? task.title : task.body, acceptanceCriteria: task.acceptanceCriteria, repository: task.repo, kind: task.kind,
        backingRepository: configuration.repository, baseRef: configuration.delivery.baseRef,
        outputBranch: `${configuration.delivery.branchPrefix}${task.id}/attempt-${ref.attempt}`,
        delivery: resolvedContract, runtime: configuration.runtime, provenance: {
          ...configuration.provenance,
          definitionRevision: `task:${task.id}.definitionRevision`, title: `task:${task.id}.title`, acceptanceCriteria: `task:${task.id}.acceptanceCriteria`,
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
      return existingRequest(deps, existing, options.requestId, reads);
    }
  } catch (error) {
    if (error instanceof AttemptStoreError && error.reason === "request_input_mismatch") return result({
      ok: false, reason: "request_input_mismatch", stage: "select", lease: "none", observed, detail: error.message, nextAction: "inspect_attempt",
    });
    if (error instanceof AttemptStoreError || error instanceof TaskStoreError) return refusal("select", "inspect_attempt", error.message, { ...observed, reason: error.reason });
    return refusal("select", "fix_configuration", `The attempt store could not be written: ${message(error)}`, observed);
  }
  reads.record = ref;
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
    // The reservation's requested entry is the durable acquisition intent.
    reads.effectAttempted = true;
    // The operator may have resolved this attempt while it was waiting; never acquire for a resolved attempt.
    if (resolvedBy(await reads.read("Attempt records", "check resolution before acquisition", () => deps.attempts.read(ref)), "lease_returned")) {
      return halt("acquire", "inspect_attempt", "The operator resolved this attempt before its lease was acquired");
    }

    stage = "acquire";
    // Step 3: acquire a lease for the exact task ID on a unique output branch.
    const specification = attemptSpecificationSchema.parse((await reads.read("Attempt specification", "read acquisition inputs", () => deps.attempts.read(ref))).specification);
    const outputBranch = specification.outputBranch;
    let allocation: Allocation;
    try {
      allocation = await deps.workspaces.acquire({ holder: specification.taskId, baseRef: specification.baseRef, branch: outputBranch });
    } catch (error) {
      if (error instanceof WorkspaceError && error.readFailure) throw await reads.failure(error.readFailure.owner, "read acquisition", error.readFailure.error);
      if (error instanceof WorkspaceError && error.reason === "unreadable") throw await reads.failure("Treehouse", "read acquisition", error);
      if (error instanceof WorkspaceError && error.reason === "rejected") return halt("acquire", "fix_configuration", `The workspace provider refused the lease: ${message(error)}`);
      // Inspect by holder and branch instead of acquiring again, and report whatever lease exists.
      const found = (await reads.read("Treehouse leases", "inspect acquisition outcome", () => deps.workspaces.leases())).filter(l => l.holder === taskId && l.branch === outputBranch);
      const lease = found.length > 0 ? "preserved" : "none";
      if (found[0]) Object.assign(summary, { leaseId: found[0].leaseId, workspace: found[0].path, outputBranch });
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
    const stored = await reads.read("Attempt records", "read launch inputs", () => deps.attempts.read(ref));
    const input = workerInput(attemptSpecificationSchema.parse(stored.specification), stored.allocation!, randomUUID());
    const delivery = input.delivery;
    const sessionId = input.identity.sessionId;
    summary.sessionId = sessionId;
    await deps.attempts.append(ref, "launched", { sessionId });
    deps.progress?.(`Session ${sessionId}`);
    let report: RunReport;
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
      const records = await reads.read("Runtime records", "inspect launch outcome", () => deps.runtime.discover(deps.contextId));
      const runtime = records.find(r => r.binding.input.identity.leaseId === allocation.leaseId);
      if (runtime?.child.status === "unknown") {
        if (runtime) await deps.attempts.append(ref, "worker_finished", { status: "unresolved", runtimeDirectory: runtime.directory, reason: message(error).slice(0, 500) });
        return result({ ok: false, reason: "stopped", stage: "launch", lease: "preserved", observed, attempt: summary, worker: { status: "unresolved" }, detail: `Launching failed after the worker may have started, so it may still be running: ${message(error)}`, nextAction: "stop_worker" });
      }
      await deps.attempts.append(ref, "worker_finished", { status: runtime ? "failed" : "not_started", runtimeDirectory: runtime?.directory ?? "-", reason: message(error).slice(0, 500) });
      // Awaited here, so that a failure while finalising reaches the handler below and is recorded.
      return await finalise(deps, reads, ref, summary, observed, delivery, undefined, `${runtime ? "Worker failed" : "Worker not started"}: ${message(error)}`);
    }
    await requests;
    if (unrecorded.length > 0) observed.unrecordedRequests = unrecorded;
    if (report.result) {
      const runtime = (await reads.read("Runtime records", "read validated result", () => deps.runtime.discover(deps.contextId, { leaseId: allocation.leaseId })))[0];
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
    return await finalise(deps, reads, ref, summary, observed, delivery, report);
  } catch (error) {
    const failed = readRefusal(error, stage);
    if (failed) return { ...failed, attempt: summary, lease: summary.leaseId ? "preserved" : reads.effectAttempted ? "unknown" : "none" };
    const detail = `The attempt stopped at ${stage} because a step failed: ${message(error)}`;
    await deps.attempts.append(ref, "halted", { stage, reason: "error", detail: detail.slice(0, 4000) }).catch(() => {});
    return result({ ok: false, reason: "stopped", stage, lease: summary.leaseId ? "preserved" : "unknown", observed, attempt: summary, detail, nextAction: "inspect_attempt" });
  }
}

/** Step 8: decide the task outcome, check retention, record it and read it back. The lease is always preserved. */
async function finalise(
  deps: Dependencies, reads: OwnerReads, ref: AttemptRef, summary: AttemptSummary, observed: Record<string, unknown>,
  delivery: DeliveryContract, report: RunReport | undefined, notStarted?: string,
): Promise<DispatchResult> {
  const worker = workerView(report, notStarted);
  const stored = await reads.read("Attempt records", "read retention inputs", () => deps.attempts.read(ref));
  const roots = await reads.read("Treehouse workspace roots", "check retention", () => deps.workspaces.recyclableRoots());
  const retention = await reads.read("Git retention", "check retention", () => deps.retention({
    repository: stored.allocation!.backingRepository!, workspace: summary.workspace!, outputBranch: delivery.outputBranch,
    ...(summary.resultCommit ? { resultCommit: summary.resultCommit } : {}),
    gitReferences: (report?.result?.workReferences ?? []).flatMap(w => (w.kind === "git" ? [w] : [])),
    artefacts: (report?.result?.workReferences ?? []).flatMap(w => (w.kind === "artefact" ? [w.path] : [])),
    recyclableRoots: roots,
    ...(report ? { artefactDirectory: report.binding.artefactDirectory } : {}),
    // For a non-code contract the workspace is scratch; reported deliverables are still checked.
    ...(delivery.kind === "artefact" ? { scratchWorkspace: true } : {}),
  }));
  let failedRead;
  for (const failure of retention.readFailures ?? []) {
    const failed = await reads.failure("Git retention", "check retention", Object.assign(new Error(failure.message), { detail: failure.detail }), undefined, retention.definiteRejection);
    if (failed.failure.classification !== "rejected") failedRead = failed;
  }
  if (failedRead) throw failedRead;
  await deps.attempts.append(ref, "retention_checked", { retained: retention.retained, findings: retention.findings, notes: retention.notes });

  const outcome = decide(report, delivery, retention);
  const holdReason = `Switchboard attempt ${ref.attempt} ${holdLabels[outcome.category]}`;
  const { task: recorded, applied } = await deps.attempts.recordOutcome(ref, {
    outcome: outcome.done ? "done" : "hold", reason: outcome.done ? "done" : holdReason, category: outcome.category,
  });
  return result({
    ok: outcome.done, reason: outcome.done ? "done" : "held", stage: "finalise", lease: "preserved", observed, attempt: summary, worker, retention,
    ...(report?.result?.criteriaReport ? { criteriaReport: report.result.criteriaReport } : {}),
    ...(typeof observed.resultDiscrepancy === "string" ? { resultDiscrepancy: observed.resultDiscrepancy } : {}),
    task: { id: recorded.id, state: recorded.state, held: recorded.held, holdReason: recorded.holdReason },
    ...(!applied ? { detail: "The attempt outcome was recorded, but a newer operator decision left the task unchanged" } : outcome.done ? {} : { detail: holdReason }),
    nextAction: outcome.done ? "finish_attempt" : outcome.category === "review_required" ? "review_then_finish" : "inspect_attempt",
  });
}

/** The outcome table in the Phase 1 PRD. Only a valid, retained completion with an independent contract is done. */
function decide(report: RunReport | undefined, delivery: DeliveryContract, retention: RetentionResult):
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
async function existingRequest(deps: Dependencies, attempt: AttemptRecord | ArchivedRequest, requestId?: string, reads = new OwnerReads(deps, "dispatch")): Promise<DispatchResult> {
  if ("archived" in attempt) return result({
    ok: false, reason: "existing_request", lease: "none",
    attempt: { contextId: attempt.contextId, taskId: attempt.taskId, attempt: attempt.attempt, ...(requestId === undefined ? {} : { requestId }) },
    observed: { archived: true, archive: attempt.summary }, nextAction: "inspect_attempt",
  });
  reads.record = attempt;
  const summary = summarise(attempt);
  const task = await reads.read("Task store", "read existing request", () => deps.tasks.read(attempt.taskId));
  const state = await inspect(deps, reads);
  if (isFailure(state)) return { ...state.failed, attempt: summary };
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

/** Refused before any change: nothing to preserve or undo. */
function refusal(stage: Stage, nextAction: NextAction, detail: string, observed: Record<string, unknown> = {}): DispatchResult {
  return result({ ok: false, reason: "refused", stage, lease: "none", observed, detail, nextAction });
}

function workerView(report: RunReport | undefined, notStarted?: string): NonNullable<DispatchResult["worker"]> {
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
