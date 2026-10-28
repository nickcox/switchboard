import { callerName } from "../caller.ts";
import { randomUUID } from "node:crypto";
import { checkWorkspace, runChecks } from "./checks.ts";
import type { CriteriaReport } from "../runtime/contracts.ts";
import type { AttemptRecord } from "../attempts/log.ts";
import { latestChecks } from "../attempts/checks.ts";
import { recordedReviews } from "../attempts/reviews.ts";
import { CommandError } from "../infra/command.ts";
import { onPath } from "../infra/executables.ts";
import { recordValidatedResult, resultDiscrepancy, validateResultFile } from "../runtime/validated-result.ts";
import type { RetentionRequest, RetentionResult } from "../workspaces/retention.ts";
import { branchHead, fastForward, isAncestor } from "../workspaces/integration.ts";
import { WorkspaceError } from "../workspaces/provider.ts";
import { OwnerReadError, type ReadFailure } from "./failure.ts";
import { effectBefore, OwnerReads, readRefusal, unsettledReads } from "./owner-reads.ts";
import { resolvedBy } from "./attempt.ts";
import type { Dependencies } from "./dependencies.ts";
import { resolvePolicy, type ResolvedPolicy } from "./policy.ts";
import { result, type DispatchResult, type NextAction } from "./result.ts";
import { observeAttempt } from "./observe.ts";
import { assessAttempt, type AttemptAssessment } from "./assess.ts";
import { checkAcceptanceEvidence, checkCanAcceptOutput, checkCanDiscard, checkCanFinish, checkCanIntegrate, checkCanReturnLease, type AcceptanceEvidence, requireOperationAuthority } from "./safety.ts";

/**
 * `finish` and `discard` (Phase 2 PRD): the only commands that return a lease, subject to every condition in
 * "Returning a lease". Finishing work does not require returning its lease. Each step reads back its owner and is
 * recorded in the attempt log, so a command interrupted partway can be run again to complete what is left.
 */

type Located = { attempt: AttemptAssessment; record: AttemptRecord };
type OperationDependencies = Dependencies & { reads: OwnerReads };
/** The lease's state after a failed step: `returnLease` marks its errors, and every earlier step leaves the lease held. */
const leaseAfter = (error: unknown): DispatchResult["lease"] =>
  typeof error === "object" && error !== null && "lease" in error && (error.lease === "none" || error.lease === "unknown") ? error.lease : "preserved";
const refused = (nextAction: NextAction, detail: string, extra: Omit<Partial<DispatchResult>, "nextAction" | "version"> = {}) =>
  result({ ok: false, reason: "refused", stage: "finish", lease: "preserved", observed: {}, detail, nextAction, ...extra });

async function locate(deps: OperationDependencies, leaseId: string): Promise<Located | DispatchResult> {
  const observation = await observeAttempt(deps, { leaseId });
  if (!observation) return refused("inspect_attempt", "No attempt in this context has this lease ID", { lease: "none" });
  await deps.reads.attempt(observation, "inspect attempt");
  const attempt = assessAttempt(observation);
  if (attempt.facts.unknown.length) return refused("inspect_attempt", attempt.facts.unknown.join("; "), { lease: "unknown" });
  const record = observation.record.known ? observation.record.value : undefined;
  if (!record) return refused("inspect_attempt", "The attempt could not be read from the attempt log", { lease: "unknown" });
  deps.reads.record = record;
  return { attempt, record };
}

/**
 * Fence a pending launch by inserting its immutable launch row first. If permission already exists, the worker must
 * have an observed exit or the operator's stop confirmation. A fence remains safe when a command is run again.
 */
async function fenceLaunch(deps: OperationDependencies, record: AttemptRecord, leaseId: string): Promise<string | undefined> {
  if (await deps.runtime.fence(deps.contextId, leaseId)) return undefined;
  if (await deps.reads.read("Runtime records", "read launch permission", () => deps.runtime.storage.launchKind(deps.contextId, leaseId)) === "fence") return undefined;
  const runtime = (await deps.reads.read("Runtime records", "check launch permission", () => deps.runtime.discover(deps.contextId, { leaseId }))).find(r => r.binding.input.identity.leaseId === leaseId);
  const stopped = deps.attempts.confirmations(record).some(c => c.fact === "worker_stopped" && c.scope.leaseId === leaseId &&
    (c.scope.sessionId === undefined || c.scope.sessionId === runtime?.binding.input.identity.sessionId));
  if (stopped || (runtime ? runtime.child.status !== "unknown" : resolvedBy(record, "worker_stopped"))) return undefined;
  return "A dispatcher may be starting this attempt's worker now; check with status before trying again";
}

/**
 * Asks the provider to return the lease, recording first that the return was started, so that a run interrupted after
 * the return but before `lease_returned` was written can complete the record.
 */
async function returnLease(deps: OperationDependencies, record: AttemptRecord, attempt: AttemptAssessment, by: "finish" | "discard", retained: () => Promise<boolean>): Promise<void> {
  const leaseId = attempt.attempt.leaseId!;
  await deps.reads.checkEffects();
  const returnId = randomUUID();
  deps.reads.effectAttempted = true;
  await deps.attempts.appendConfirmed(record, "lease_return_started", { leaseId, by, returnId },
    { fact: "no_processes", scope: { leaseId, returnId } }, callerName(deps.caller));
  const retention = await retained();
  const current = await locate(deps, leaseId);
  if (!("record" in current)) throw new Error(current.detail ?? "The attempt cannot be read before returning its lease");
  requireOperationAuthority(deps, ["returnLease"], { leaseId });
  const permission = checkCanReturnLease(current.attempt.facts, { by, noProcesses: true, retained: retention, confirmedDiscard: current.attempt.facts.discarded });
  if (!permission.allowed) throw new Error(permission.detail);
  try { await deps.workspaces.returnLease({ leaseId, holder: attempt.attempt.taskId, path: attempt.attempt.workspace! }, { discardChanges: by === "discard" }); }
  catch (error) {
    if (error instanceof WorkspaceError && error.readFailure) throw await deps.reads.failure(error.readFailure.owner, "read back lease return", error.readFailure.error);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { lease: error instanceof WorkspaceError && error.reason === "outcome_unknown" ? "unknown" : "preserved" });
  }
  try { await deps.attempts.append(record, "lease_returned", { leaseId, by, returnId }); }
  catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { lease: "none" }); }
}

/** Completes the record of a return that an earlier run started, once the lease is no longer listed. */
async function completeReturn(deps: Dependencies, record: AttemptRecord, attempt: AttemptAssessment, by: "finish" | "discard", dryRun = false): Promise<boolean> {
  if (attempt.facts.unknown.length || attempt.facts.possiblyRunning || attempt.leaseHeld || attempt.leaseInOtherPool || typeof attempt.task !== "object" || attempt.task.state === "in_flight") return false;
  const started = record.entries.some(e => e.kind === "lease_return_started" && e.data.by === by && e.data.leaseId === attempt.attempt.leaseId);
  if (!started || record.entries.some(e => e.kind === "lease_returned")) return false;
  const intent = [...record.entries].reverse().find(e => e.kind === "lease_return_started" && e.data.by === by);
  if (!dryRun) await deps.attempts.append(record, "lease_returned", { leaseId: attempt.attempt.leaseId!, by, returnId: intent!.data.returnId as string });
  return true;
}

async function readRetention(deps: OperationDependencies, request: RetentionRequest): Promise<RetentionResult> {
  const retention = await deps.reads.read("Git retention", "check retention", () => deps.retention(request));
  const failures = retention.readFailures ?? [];
  const rejected = retention.definiteRejection === true;
  let failed: OwnerReadError | undefined;
  for (const failure of failures) {
    const error = await deps.reads.failure("Git retention", "check retention", Object.assign(new Error(failure.message), { detail: failure.detail }), undefined, rejected);
    if (error.failure.classification !== "rejected") failed = error;
  }
  if (failed) throw failed;
  return retention;
}

async function readPolicy(deps: OperationDependencies): Promise<ResolvedPolicy> {
  try { return await resolvePolicy(deps.policy!); }
  catch (error) {
    if (error instanceof CommandError) throw await deps.reads.failure("Git policy", "read finalisation policy", error);
    throw error;
  }
}

const gitReads = (deps: OperationDependencies) => ({
  read: <T>(step: string, load: () => Promise<T>) => deps.reads.read("Git", step, load),
  beforeEffect: () => { deps.reads.effectAttempted = true; },
});

/** Runs the retention check again from the worker's recorded result, as dispatch did when the attempt finished. */
async function recheck(deps: OperationDependencies, attempt: AttemptAssessment, dryRun = false): Promise<(RetentionResult & { outputCommit?: string; criteriaReport?: CriteriaReport }) | string> {
  const runtime = (await deps.reads.read("Runtime records", "check worker result", () => deps.runtime.discover(deps.contextId, { leaseId: attempt.attempt.leaseId! }))).find(r => r.binding.input.identity.leaseId === attempt.attempt.leaseId);
  if (!runtime) return "The attempt has no runtime records, so its worker's result cannot be checked";
  let validated;
  try { validated = runtime.validatedResult ?? await (dryRun ? validateResultFile(runtime.binding) : recordValidatedResult(runtime)); }
  catch (error) { return `The worker's result cannot be read: ${error instanceof Error ? error.message : String(error)}`; }
  const report = validated.content;
  const discrepancy = await resultDiscrepancy(validated);
  if (report.outcome !== "completed") return `The worker reported ${report.outcome}, not completed work; use --accept-output to accept its committed output instead`;
  const delivery = runtime.binding.input.delivery;
  const retention = await readRetention(deps, {
    repository: deps.repository, workspace: runtime.binding.input.workspace, outputBranch: delivery.outputBranch, startingCommit: delivery.startingCommit,
    gitReferences: report.workReferences.flatMap(w => (w.kind === "git" ? [w] : [])),
    artefacts: report.workReferences.flatMap(w => (w.kind === "artefact" ? [w.path] : [])),
    recyclableRoots: await deps.reads.read("Treehouse workspace roots", "check retention", () => deps.workspaces.recyclableRoots()),
    artefactDirectory: runtime.binding.artefactDirectory,
    ...(delivery.kind === "artefact" ? { scratchWorkspace: true } : {}),
  });
  const output = report.workReferences.find(w => w.kind === "git" && w.branch === delivery.outputBranch);
  return { ...retention, notes: [...retention.notes, ...(discrepancy ? [discrepancy] : [])],
    ...(output?.kind === "git" ? { outputCommit: output.commit } : {}),
    ...(report.criteriaReport ? { criteriaReport: report.criteriaReport } : {}) };
}

/**
 * A failure no step anticipated still gives a structured result. Each step that changes an owner has its own handler, so
 * the lease's state is unknown only in the sense that this handler does not know which step failed.
 */
const unexpected = (command: "finish" | "discard") => (error: unknown) => readRefusal(error) ?? result({
  ok: false, reason: "stopped", stage: "finish", lease: "unknown", observed: {},
  detail: `${command} failed unexpectedly: ${error instanceof Error ? error.message : String(error)}. Check status, then run ${command} again`, nextAction: "inspect_attempt",
});

export async function finish(deps: Dependencies, options: { leaseId: string; noProcesses: boolean; dryRun?: boolean; acceptOutput?: boolean }): Promise<DispatchResult> {
  try { requireOperationAuthority(deps, ["acceptOutput", "completeTasks", ...(options.noProcesses ? ["returnLease" as const] : [])], options); }
  catch (error) { return refused("inspect_attempt", error instanceof Error ? error.message : String(error)); }
  return finishAttempt({ ...deps, reads: new OwnerReads(deps, "finish", options.leaseId) }, options).catch(unexpected("finish"));
}

export async function discard(deps: Dependencies, options: { leaseId: string; noProcesses: boolean; confirm: boolean; dryRun?: boolean; note?: string }): Promise<DispatchResult> {
  try { requireOperationAuthority(deps, ["returnLease"], options); }
  catch (error) { return refused("inspect_attempt", error instanceof Error ? error.message : String(error)); }
  return discardAttempt({ ...deps, reads: new OwnerReads(deps, "discard", options.leaseId) }, options).catch(unexpected("discard"));
}

/** Only the target containing the exact intended commit can settle an interrupted integration. */
async function reconcileIntegration(deps: OperationDependencies, record: AttemptRecord, dryRun = false): Promise<void> {
  const failures = [...unsettledReads(record), ...record.entries.filter(e => e.kind === "owner_read_failed" &&
    record.confirmations?.some(c => c.fact === "owner_read_reconciled" && c.scope.failureSequence === e.sequence && c.scope.outcome === "happened"))];
  for (const failure of failures) {
    const intent = effectBefore(record, failure.sequence);
    if (intent?.kind !== "integration_started") continue;
    const confirmed = record.confirmations?.some(c => c.fact === "owner_read_reconciled" && c.scope.failureSequence === failure.sequence && c.scope.outcome === "happened");
    if (confirmed && record.entries.some(e => e.kind === "integrated" && e.data.commit === intent.data.commit && e.data.targetBranch === intent.data.targetBranch)) continue;
    const target = intent.data.targetBranch as string;
    const commit = intent.data.commit as string;
    const git = { git: deps.policy?.git ?? onPath("git"), environment: deps.policy?.environment ?? {}, repository: deps.repository, ...gitReads(deps) };
    const head = await branchHead(git, target);
    if (!head || !await isAncestor(git, commit, head) || dryRun) {
      if (confirmed) throw new OwnerReadError(failure.data as ReadFailure);
      continue;
    }
    await deps.attempts.reconcileIntegration(record, failure.sequence, target, commit);
  }
}

async function finishAttempt(deps: OperationDependencies, options: { leaseId: string; noProcesses: boolean; dryRun?: boolean; acceptOutput?: boolean }): Promise<DispatchResult> {
  const located = await locate(deps, options.leaseId);
  if (!("record" in located)) return located;
  const { attempt, record } = located;
  const evidence = (record: AttemptRecord, commit: string | undefined): AcceptanceEvidence => ({ ...(commit ? { commit } : {}),
    permission: checkAcceptanceEvidence(commit, deps.checks ?? [], latestChecks(record, commit), recordedReviews(record, commit)) });
  const base = { attempt: attempt.attempt, acceptanceEvidence: evidence(record, attempt.outputCommit), checks: attempt.checks ?? [], ...(attempt.criteriaReport ? { criteriaReport: attempt.criteriaReport } : {}), ...(attempt.resultDiscrepancy ? { resultDiscrepancy: attempt.resultDiscrepancy } : {}) };
  if (await completeReturn(deps, record, attempt, "finish", options.dryRun)) return result({
    ok: true, reason: options.dryRun ? "planned" : "finished", stage: "finish", lease: "none", observed: {}, ...base,
    ...(options.dryRun ? { detail: `Would record that lease ${options.leaseId} was returned` } : {}), nextAction: "none",
  });
  if (record.entries.some(e => e.kind === "integration_started")) requireOperationAuthority(deps, ["integrate"], options);
  await reconcileIntegration(deps, record, options.dryRun);
  record.entries = (await deps.reads.read("Attempt records", "read integration reconciliation", () => deps.reads.current()))!.entries;
  await deps.reads.checkEffects();
  const accepted = [...(record.confirmations ?? [])].reverse().find(c => c.fact === "output_accepted");
  const accepting = options.acceptOutput || accepted !== undefined;
  const permission = checkCanFinish(attempt.facts, accepting);
  if (!permission.allowed) return refused(permission.nextAction, permission.detail, { ...base, observed: { refusal: permission } });

  let policy: ResolvedPolicy;
  try { policy = deps.policy ? await readPolicy(deps) : { kind: "manual", sources: { kind: "default" }, forbidden: [] }; }
  catch (error) { return readRefusal(error) ?? refused("fix_configuration", `The finalisation policy cannot be resolved: ${error instanceof Error ? error.message : String(error)}`, base); }
  if (policy.kind === "local-merge") requireOperationAuthority(deps, ["integrate"], options);
  const policyPermission = checkCanIntegrate(attempt.facts, { accepting, retained: true, fastForward: true, policyRefusal: policy.refusal });
  if (!policyPermission.allowed) return refused(policyPermission.nextAction, policyPermission.detail, { ...base, observed: { refusal: policyPermission } });

  const leased = record.entries.find(e => e.kind === "leased");
  let acceptedCommit: string | undefined;
  if (accepting) {
    try {
      const git = { git: deps.policy?.git ?? onPath("git"), environment: deps.policy?.environment ?? {}, repository: deps.repository, ...gitReads(deps) };
      acceptedCommit = options.acceptOutput ? await branchHead(git, attempt.attempt.outputBranch!) : accepted!.scope.commit;
      const start = leased?.data.startingCommit as string | undefined;
      const permission = checkCanAcceptOutput(attempt.facts, !!acceptedCommit && !!start && acceptedCommit !== start && await isAncestor(git, start, acceptedCommit));
      if (!permission.allowed) return refused(permission.nextAction, permission.detail, { ...base, observed: { refusal: permission } });
    } catch (error) { return readRefusal(error) ?? refused("inspect_attempt", `The output branch cannot be checked: ${String(error)}`, base); }
  }
  const check = (): Promise<(RetentionResult & { outputCommit?: string; criteriaReport?: CriteriaReport }) | string> => acceptedCommit ? readRetention(deps, {
    repository: deps.repository, workspace: attempt.attempt.workspace!, outputBranch: attempt.attempt.outputBranch!,
    resultCommit: acceptedCommit, artefacts: [],
  }) : recheck(deps, attempt, options.dryRun);
  const retention = await check();
  if (typeof retention === "string") return refused("inspect_attempt", retention, base);
  if (retention.criteriaReport) base.criteriaReport = retention.criteriaReport;
  const integrationPermission = checkCanIntegrate(attempt.facts, { accepting, retained: retention.retained, fastForward: true });
  if (!integrationPermission.allowed) return refused(integrationPermission.nextAction, `${integrationPermission.detail}: ${retention.findings.join("; ")}`, { ...base, retention, observed: { refusal: integrationPermission } });

  // Under local-merge, check before any change that the target can be fast-forwarded, or already contains the work.
  const outputBranch = attempt.attempt.outputBranch!;
  const outputCommit = acceptedCommit ?? retention.outputCommit ?? ((deps.checks?.length ?? 0) > 0
    ? await branchHead({ git: deps.policy?.git ?? onPath("git"), environment: deps.policy?.environment ?? deps.checkEnvironment ?? {}, repository: deps.repository, ...gitReads(deps) }, outputBranch)
    : undefined);
  base.acceptanceEvidence = evidence(record, outputCommit);
  let integration: { target: string; from: string; to: string } | undefined;
  // The target already contains the work, but an earlier run's fast-forward may not have been recorded.
  let unrecorded: { target: string; commit: string } | undefined;
  if (policy.kind === "local-merge" && !record.entries.some(e => e.kind === "integrated" && (outputCommit === undefined || e.data.commit === outputCommit))) {
    const git = { git: deps.policy!.git, environment: deps.policy!.environment, repository: deps.repository, ...gitReads(deps) };
    const to = outputCommit ?? await branchHead(git, outputBranch);
    const from = await branchHead(git, policy.targetBranch!);
    if (!to || !from) return refused("inspect_attempt", `Branch ${!to ? outputBranch : policy.targetBranch} cannot be read in the backing repository`, base);
    if (!await isAncestor(git, to, from)) {
      const permission = checkCanIntegrate(attempt.facts, { accepting, retained: true, fastForward: await isAncestor(git, from, to) });
      if (!permission.allowed) return refused(permission.nextAction, `${policy.targetBranch} cannot be fast-forwarded to ${outputBranch}: it has commits the output branch does not`, { ...base, observed: { refusal: permission } });
      integration = { target: policy.targetBranch!, from, to };
    } else unrecorded = { target: policy.targetBranch!, commit: to };
  }

  const task = await deps.reads.read("Task store", "read task outcome", () => deps.tasks.read(attempt.attempt.taskId));
  if (!task) return refused("inspect_attempt", "The task cannot be read", base);
  const recordTask = task.state !== "done" || !record.entries.some(e => e.kind === "task_recorded" && e.data.outcome === "done");
  const retainedDetail = `Lease retained. Once no worker process remains, return it with switchboard finish --lease ${options.leaseId} --no-processes`;
  const steps = [
    ...(acceptedCommit && accepted?.scope.commit !== acceptedCommit ? [`accept output commit ${acceptedCommit} as ${callerName(deps.caller)}`] : []),
    ...(integration ? [`fast-forward ${integration.target} to ${integration.to}`] : []),
    ...(unrecorded ? [`record that ${unrecorded.target} contains the work`] : []),
    ...(recordTask ? ["record the task as done"] : []),
    options.noProcesses ? `return lease ${options.leaseId}` : `retain lease ${options.leaseId}`,
  ];
  if (options.dryRun && deps.checks?.length) {
    if (!outputCommit) return refused("inspect_attempt", "The exact output commit for checks cannot be read", base);
    const refusal = await checkWorkspace(deps, deps.reads, attempt.attempt.workspace!, outputCommit);
    if (refusal) return refused("inspect_attempt", refusal, base);
    steps.unshift("run configured checks (reusing passing results for this commit)");
  }
  if (deps.caller.kind === "supervisor" && options.dryRun && !base.acceptanceEvidence.permission.allowed) {
    const permission = base.acceptanceEvidence.permission;
    return refused(permission.nextAction, permission.detail, { ...base, observed: { refusal: permission } });
  }
  if (options.dryRun) return result({ ok: true, reason: "planned", stage: "finish", lease: "preserved", observed: { policy }, ...base, retention, detail: `Would ${steps.join(", then ")}${options.noProcesses ? "" : `. ${retainedDetail}`}`, nextAction: options.noProcesses ? "none" : "finish_attempt" });

  // From here each step changes an owner; a failure leaves what is done recorded and the rest for a later run.
  const stopped = (error: unknown, step: string) => readRefusal(error) ?? result({
    ok: false, reason: "stopped", stage: "finish", lease: leaseAfter(error), observed: {}, ...base, retention,
    detail: `Stopped while trying to ${step}: ${error instanceof Error ? error.message : String(error)}. Run finish again to complete it`, nextAction: "inspect_attempt",
  });
  const fenced = await fenceLaunch(deps, record, options.leaseId);
  if (fenced) return refused("inspect_attempt", fenced, base);
  if (deps.checks?.length) {
    const runtime = (await deps.reads.read("Runtime records", "check worker exit before checks", () => deps.runtime.discover(deps.contextId, { leaseId: options.leaseId })))
      .find(r => r.binding.input.identity.leaseId === options.leaseId);
    const stopped = runtime?.child.status === "exited" || runtime?.child.status === "operator_confirmed_stopped" ||
      deps.attempts.confirmations(record).some(c => c.fact === "worker_stopped" && c.scope.leaseId === options.leaseId &&
        (c.scope.sessionId === undefined || c.scope.sessionId === runtime?.binding.input.identity.sessionId));
    if (!stopped) return refused("stop_worker", "Checks require an observed worker exit or a confirmed stop", base);
    if (!outputCommit) return refused("inspect_attempt", "The exact output commit for checks cannot be read", base);
    const checked = await runChecks(deps, deps.reads, record, attempt.attempt.workspace!, outputCommit);
    base.checks = checked.checks;
    base.acceptanceEvidence = evidence(await deps.attempts.read(record), outputCommit);
    if (checked.refusal) return refused("inspect_attempt", checked.refusal, base);
  }
  if (deps.caller.kind === "supervisor") {
    base.acceptanceEvidence = evidence(await deps.attempts.read(record), outputCommit);
    const permission = base.acceptanceEvidence.permission;
    if (!permission.allowed) return refused(permission.nextAction, permission.detail, { ...base, observed: { refusal: permission } });
    requireOperationAuthority(deps, ["acceptOutput", "completeTasks", ...(policy.kind === "local-merge" ? ["integrate" as const] : [])], options);
  }
  if (acceptedCommit && accepted?.scope.commit !== acceptedCommit) {
    try {
      const current = await locate(deps, options.leaseId);
      if (!("record" in current)) return current;
      const permission = checkCanAcceptOutput(current.attempt.facts, true);
      if (!permission.allowed) return refused(permission.nextAction, permission.detail, { ...base, observed: { refusal: permission } });
      deps.reads.effectAttempted = true;
      await deps.attempts.appendConfirmed(record, "output_accepted", { commit: acceptedCommit }, { fact: "output_accepted", scope: { commit: acceptedCommit } }, callerName(deps.caller), current.record);
    }
    catch (error) { return stopped(error, "record the operator's output acceptance"); }
  }
  if (integration) {
    try {
      const retained = await check();
      const current = await locate(deps, options.leaseId);
      if (!("record" in current)) return current;
      const currentPolicy = await readPolicy(deps);
      const permission = checkCanIntegrate(current.attempt.facts, { accepting, retained: typeof retained !== "string" && retained.retained,
        policyRefusal: currentPolicy.refusal ?? (currentPolicy.kind !== "local-merge" || currentPolicy.targetBranch !== integration.target ? "The finalisation policy changed" : undefined), fastForward: true });
      if (!permission.allowed) return refused(permission.nextAction, permission.detail, { ...base, observed: { refusal: permission } });
      await fastForward({ git: deps.policy!.git, environment: deps.policy!.environment, repository: deps.repository, ...gitReads(deps),
        beforeEffect: async () => {
          await deps.reads.checkEffects();
          deps.reads.effectAttempted = true;
          await deps.attempts.append(record, "integration_started", { targetBranch: integration.target, from: integration.from, commit: integration.to });
        } }, integration.target, integration.from, integration.to);
      await deps.attempts.append(record, "integrated", { policy: "local-merge", targetBranch: integration.target, commit: integration.to });
    } catch (error) { return stopped(error, `fast-forward ${integration.target}`); }
  }
  if (unrecorded) {
    try { await deps.attempts.append(record, "integrated", { policy: "local-merge", targetBranch: unrecorded.target, commit: unrecorded.commit }); }
    catch (error) { return stopped(error, `record that ${unrecorded.target} contains the work`); }
  }
  if (recordTask) {
    try {
      const current = await locate(deps, options.leaseId);
      if (!("record" in current)) return current;
      const permission = checkCanFinish(current.attempt.facts, accepting);
      if (!permission.allowed) return refused(permission.nextAction, permission.detail, { ...base, observed: { refusal: permission } });
      deps.reads.effectAttempted = true;
      await deps.attempts.finishAttempt(record, task, current.record, retention.retained);
    }
    catch (error) { return stopped(error, "record the task as done"); }
  }
  if (!options.noProcesses) return result({ ok: true, reason: "finished", stage: "finish", lease: "preserved", observed: { policy }, ...base, retention, detail: retainedDetail, nextAction: "finish_attempt" });
  // The PRD's condition 2: retention is checked again immediately before the lease is returned.
  const finalRetention = await check().catch((error: unknown) => {
    if (error instanceof OwnerReadError) throw error;
    return `The retention check failed: ${error instanceof Error ? error.message : String(error)}`;
  });
  if (typeof finalRetention === "string" || !finalRetention.retained) {
    const why = typeof finalRetention === "string" ? finalRetention : finalRetention.findings.join("; ");
    return stopped(new Error(`The work is no longer retained: ${why}`), `return lease ${options.leaseId}`);
  }
  try { await returnLease(deps, record, attempt, "finish", async () => { const retained = await check(); return typeof retained !== "string" && retained.retained; }); }
  catch (error) { return stopped(error, `return lease ${options.leaseId}`); }
  return result({ ok: true, reason: "finished", stage: "finish", lease: "none", observed: { policy }, ...base, retention, nextAction: "none" });
}

async function discardAttempt(deps: OperationDependencies, options: { leaseId: string; noProcesses: boolean; confirm: boolean; dryRun?: boolean; note?: string }): Promise<DispatchResult> {
  if (!options.confirm && !options.dryRun) return refused("confirm_discard", "Discarding the attempt's work needs your explicit confirmation (--confirm)");
  if (!options.noProcesses && !options.dryRun) return refused("confirm_no_processes", "Returning the lease needs your confirmation that no worker process remains (--no-processes)");
  const located = await locate(deps, options.leaseId);
  if (!("record" in located)) return located;
  const { attempt, record } = located;
  const base = { attempt: attempt.attempt };
  if (!options.dryRun && await completeReturn(deps, record, attempt, "discard")) return result({ ok: true, reason: "discarded", stage: "finish", lease: "none", observed: {}, ...base, nextAction: "none" });
  await deps.reads.checkEffects();
  const permission = checkCanDiscard(attempt.facts, options.confirm || !!options.dryRun);
  if (!permission.allowed) return refused(permission.nextAction, permission.detail, { ...base, lease: attempt.leaseHeld ? "preserved" : "none", observed: { refusal: permission } });
  const task = await deps.reads.read("Task store", "read discard outcome", () => deps.tasks.read(attempt.attempt.taskId));
  if (!task) return refused("inspect_attempt", "The task cannot be read", base);
  const holdReason = `Switchboard attempt ${attempt.attempt.attempt} discarded`;
  const hold = task.state !== "done" && !(task.held && task.holdReason === holdReason);
  const steps = [...(hold ? ["hold the task"] : []), `discard the workspace's contents and return lease ${options.leaseId}`];
  if (options.dryRun) return result({ ok: true, reason: "planned", stage: "finish", lease: "preserved", observed: {}, ...base, detail: `Would ${steps.join(", then ")}`, nextAction: "none" });

  const stopped = (error: unknown, step: string) => readRefusal(error) ?? result({
    ok: false, reason: "stopped", stage: "finish", lease: leaseAfter(error), observed: {}, ...base,
    detail: `Stopped while trying to ${step}: ${error instanceof Error ? error.message : String(error)}. Run discard again to complete it`, nextAction: "inspect_attempt",
  });
  const fenced = await fenceLaunch(deps, record, options.leaseId);
  if (fenced) return refused("inspect_attempt", fenced, base);
  try {
    const current = await locate(deps, options.leaseId);
    if (!("record" in current)) return current;
    const permission = checkCanDiscard(current.attempt.facts, options.confirm);
    if (!permission.allowed) return refused(permission.nextAction, permission.detail, { ...base, observed: { refusal: permission } });
    deps.reads.effectAttempted = true;
    await deps.attempts.discardAttempt(record, task, callerName(deps.caller), options.leaseId, options.note, current.record);
  } catch (error) { return stopped(error, "record the discard"); }
  try { await returnLease(deps, record, attempt, "discard", async () => false); }
  catch (error) { return stopped(error, `return lease ${options.leaseId}`); }
  return result({ ok: true, reason: "discarded", stage: "finish", lease: "none", observed: {}, ...base, nextAction: "none" });
}
