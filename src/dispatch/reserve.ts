import type { StartingPoint } from "../attempts/specification.ts";
import { AttemptStoreError } from "../attempts/store.ts";
import { onPath } from "../infra/executables.ts";
import type { Dependencies } from "./dependencies.ts";
import { assessAttempts } from "./assess.ts";
import { observeAttempts } from "./observe.ts";
import { result, type DispatchResult, type NextAction } from "./result.ts";
import { checkCanDispatch, checkCanRedispatch, checkCanStartFrom, requireOperationAuthority } from "./safety.ts";
import { specificationFactory } from "./specification.ts";
import { handover } from "./handover.ts";

/** Reserve immutable starting inputs only. Acquisition and launch belong to dispatch. */
export async function reserveFromAttempt(deps: Dependencies, options: {
  taskId: string; startingPoint: StartingPoint; requestId: string; note?: string; dryRun?: boolean;
}): Promise<DispatchResult> {
  const refuse = (reason: string, detail: string, nextAction: NextAction = "inspect_attempt") => result({
    ok: false, reason: reason === "request_input_mismatch" ? reason : "refused", stage: "select", lease: "none",
    observed: { reason }, detail, nextAction,
  });
  try {
    requireOperationAuthority(deps, ["dispatch", "continueAttempts"], options);
    const inputs = { taskId: options.taskId, startingPoint: options.startingPoint, ...(options.note === undefined ? {} : { note: options.note }) };
    const existing = await deps.attempts.findByRequest(options.requestId, inputs);
    if (existing) return result({ ok: true, reason: "existing_request", stage: "select", lease: "none", observed: {},
      attempt: { contextId: existing.contextId, taskId: existing.taskId, attempt: existing.attempt, requestId: options.requestId }, nextAction: "inspect_attempt" });
    if (options.startingPoint.taskId !== options.taskId) return refuse("starting_point_wrong_task", "The starting attempt belongs to another task; name an earlier attempt of this task");
    const observation = await observeAttempts(deps);
    const unknown = [observation.records, observation.runtime, observation.leases, observation.pool].flatMap(o => o.known ? [] : [o.reason]);
    if (unknown.length) return refuse("starting_point_unknown", unknown.join("; "));
    const assessments = assessAttempts(observation);
    const source = assessments.find(a => a.attempt.taskId === options.taskId && a.attempt.attempt === options.startingPoint.attempt);
    if (!source) return refuse("starting_point_unknown", "The starting attempt is missing or archived; inspect its records");
    const permission = checkCanStartFrom(source.facts);
    if (!permission.allowed) return refuse(permission.reason === "unknown" ? "starting_point_unknown" : permission.reason, permission.detail, permission.nextAction);
    for (const assessment of assessments) {
      const check = checkCanDispatch(assessment.facts);
      if (!check.allowed) return refuse(check.reason, check.detail, check.nextAction);
      if (assessment === source || assessment.attempt.taskId !== options.taskId) continue;
      const redispatch = checkCanRedispatch(assessment.facts, options.taskId);
      if (!redispatch.allowed) return refuse(redispatch.reason, redispatch.detail, redispatch.nextAction);
      if (assessment.facts.leaseHeld) return refuse("lease_held", "Another attempt of this task still has a retained lease; reconcile it first");
    }
    // An unrecorded lease is not covered by the source exception.
    if (observation.leases.known && observation.leases.value.some(l => l.holder === options.taskId && l.leaseId !== source.attempt.leaseId)) {
      return refuse("lease_held", "Another lease for this task must be reconciled first");
    }
    const record = deps.attempts.findForTask(options.taskId, options.startingPoint.attempt)!;
    const output = deps.attempts.startingPointCommit(record);
    if (!output) return refuse("output_not_recorded", "The earlier attempt has no recorded output commit; inspect its result or explicitly accept its output");
    const allocation = record.allocation;
    if (!allocation) return refuse("starting_point_unknown", "The starting attempt has no recorded allocation");
    const retention = await deps.retention({
      repository: allocation.backingRepository ?? deps.repository, workspace: allocation.workspace, outputBranch: allocation.outputBranch, commitsOnly: true,
      gitReferences: [{ name: "starting point", branch: allocation.outputBranch, commit: output }], artefacts: [],
      recyclableRoots: await deps.workspaces.recyclableRoots(),
    });
    if (!retention.retained) return refuse("not_retained", retention.findings.join("; ") || "The recorded output commit is not retained", "fix_or_discard");
    const task = await deps.tasks.read(options.taskId);
    if (!task) return refuse("not_ready", "The task does not exist");
    const contract = task.kind === null ? deps.delivery.default : deps.delivery.byTaskKind[task.kind];
    if (!contract) return refuse("not_ready", "The task's kind has no configured delivery contract", "fix_configuration");
    await deps.runtime.probeExclusiveCreation();
    const previousResult = observation.runtime.known ? observation.runtime.value.find(r =>
      r.binding.input.identity.leaseId === allocation.leaseId)?.validatedResult?.content : undefined;
    const writtenHandover = await handover(deps.policy?.git ?? onPath("git"), deps.policy?.environment ?? {}, task, record, output, previousResult, options.note);
    const specification = specificationFactory(deps, contract);
    const reservation = await deps.attempts.reserveAttempt({
      taskId: task.id, requestInputs: inputs, startingPoint: options.startingPoint, dryRun: options.dryRun === true,
      startingPointEvidence: { records: observation.records.known ? observation.records.value : [], unknown: [], retainedCommit: output },
      maximum: deps.maxAttempts ?? 1, maximumPerTask: deps.maxAttemptsPerTask ?? 3, repo: task.repo, definitionRevision: task.definitionRevision,
      requested: { requestId: options.requestId, pool: observation.pool.known ? observation.pool.value : "unknown", contract: { name: task.kind ?? "default", ...contract } },
      specification: (task, ref) => ({ ...specification(task, ref), handover: writtenHandover }),
    });
    if (options.dryRun) return result({ ok: true, reason: "dry_run", stage: "select", lease: "none", observed: {},
      selection: { taskId: task.id, contract: { name: task.kind ?? "default", ...contract } }, nextAction: "none" });
    return result({ ok: true, reason: reservation.created ? "reserved" : "existing_request", stage: "select", lease: "none", observed: {},
      attempt: { ...reservation.ref, requestId: options.requestId }, nextAction: "inspect_attempt" });
  } catch (error) {
    if (error instanceof AttemptStoreError) return refuse(error.reason, error.message, error.nextAction);
    return refuse("starting_point_unknown", `The starting attempt could not be checked: ${error instanceof Error ? error.message : String(error)}`);
  }
}
