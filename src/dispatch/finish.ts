import { randomUUID } from "node:crypto";
import type { AttemptRecord } from "../attempts/log.ts";
import { onPath } from "../infra/executables.ts";
import { validateWorkerResult } from "../runtime/contracts.ts";
import { readJsonFile } from "../runtime/records.ts";
import type { RetentionResult } from "../workspaces/retention.ts";
import { branchHead, fastForward, isAncestor } from "../workspaces/integration.ts";
import { WorkspaceError } from "../workspaces/provider.ts";
import { resolvedBy, type Dependencies } from "./dispatch.ts";
import { resolvePolicy, type ResolvedPolicy } from "./policy.ts";
import { result, type DispatchResult, type NextAction } from "./result.ts";
import { observeAttempt } from "./observe.ts";
import { assessAttempt, type AttemptAssessment } from "./assess.ts";
import { checkCanAcceptOutput, checkCanDiscard, checkCanFinish, checkCanIntegrate, checkCanReturnLease } from "./safety.ts";

/**
 * `finish` and `discard` (Phase 2 PRD): the only commands that return a lease. Each refuses unless every condition in
 * the PRD's "Returning a lease" holds, and each step reads back its owner and is recorded in the attempt log, so a
 * command interrupted partway can be run again to complete what is left.
 */

type Located = { attempt: AttemptAssessment; record: AttemptRecord };
const operator = `operator:${process.env.USER ?? process.env.USERNAME ?? "unknown"}`;
/** The lease's state after a failed step: `returnLease` marks its errors, and every earlier step leaves the lease held. */
const leaseAfter = (error: unknown): DispatchResult["lease"] =>
  typeof error === "object" && error !== null && "lease" in error && (error.lease === "none" || error.lease === "unknown") ? error.lease : "preserved";
const refused = (nextAction: NextAction, detail: string, extra: Omit<Partial<DispatchResult>, "nextAction" | "version"> = {}) =>
  result({ ok: false, reason: "refused", stage: "finish", lease: "preserved", observed: {}, detail, nextAction, ...extra });

async function locate(deps: Dependencies, leaseId: string): Promise<Located | DispatchResult> {
  const observation = await observeAttempt(deps, { leaseId });
  if (!observation) return refused("inspect_attempt", "No attempt in this context has this lease ID", { lease: "none" });
  const attempt = assessAttempt(observation);
  if (attempt.facts.unknown.length) return refused("inspect_attempt", attempt.facts.unknown.join("; "), { lease: "unknown" });
  const record = observation.record.known ? observation.record.value : undefined;
  if (!record) return refused("inspect_attempt", "The attempt could not be read from the attempt log", { lease: "unknown" });
  return { attempt, record };
}

/**
 * Fence a pending launch by inserting its immutable launch row first. If permission already exists, the worker must
 * have an observed exit or the operator's stop confirmation. A fence remains safe when a command is run again.
 */
async function fenceLaunch(deps: Dependencies, record: AttemptRecord, leaseId: string): Promise<string | undefined> {
  if (await deps.runtime.fence(deps.contextId, leaseId)) return undefined;
  if (await deps.runtime.storage.launchKind(deps.contextId, leaseId) === "fence") return undefined;
  const runtime = (await deps.runtime.discover(deps.contextId)).find(r => r.binding.input.identity.leaseId === leaseId);
  const stopped = deps.attempts.confirmations(record).some(c => c.fact === "worker_stopped" && c.scope.leaseId === leaseId &&
    (c.scope.sessionId === undefined || c.scope.sessionId === runtime?.binding.input.identity.sessionId));
  if (stopped || (runtime ? runtime.child.status !== "unknown" : resolvedBy(record, "worker_stopped"))) return undefined;
  return "A dispatcher may be starting this attempt's worker now; check with status before trying again";
}

/**
 * Asks the provider to return the lease, recording first that the return was started, so that a run interrupted after
 * the return but before `lease_returned` was written can complete the record.
 */
async function returnLease(deps: Dependencies, record: AttemptRecord, attempt: AttemptAssessment, by: "finish" | "discard", retained: () => Promise<boolean>): Promise<void> {
  const leaseId = attempt.attempt.leaseId!;
  const returnId = randomUUID();
  await deps.attempts.appendConfirmed(record, "lease_return_started", { leaseId, by, returnId },
    { fact: "no_processes", scope: { leaseId, returnId } }, operator);
  const retention = await retained();
  const current = await locate(deps, leaseId);
  if (!("record" in current)) throw new Error(current.detail ?? "The attempt cannot be read before returning its lease");
  const permission = checkCanReturnLease(current.attempt.facts, { by, noProcesses: true, retained: retention, confirmedDiscard: current.attempt.facts.discarded });
  if (!permission.allowed) throw new Error(permission.detail);
  try { await deps.workspaces.returnLease({ leaseId, holder: attempt.attempt.taskId, path: attempt.attempt.workspace! }, { discardChanges: by === "discard" }); }
  catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { lease: error instanceof WorkspaceError && error.reason === "outcome_unknown" ? "unknown" : "preserved" }); }
  try { await deps.attempts.append(record, "lease_returned", { leaseId, by, returnId }); }
  catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { lease: "none" }); }
}

/** Completes the record of a return that an earlier run started, once the lease is no longer listed. */
async function completeReturn(deps: Dependencies, record: AttemptRecord, attempt: AttemptAssessment, by: "finish" | "discard"): Promise<boolean> {
  if (attempt.facts.unknown.length || attempt.facts.possiblyRunning || attempt.leaseHeld || typeof attempt.task !== "object" || attempt.task.state === "in_flight") return false;
  const started = record.entries.some(e => e.kind === "lease_return_started" && e.data.by === by && e.data.leaseId === attempt.attempt.leaseId);
  if (!started || record.entries.some(e => e.kind === "lease_returned")) return false;
  const intent = [...record.entries].reverse().find(e => e.kind === "lease_return_started" && e.data.by === by);
  await deps.attempts.append(record, "lease_returned", { leaseId: attempt.attempt.leaseId!, by, returnId: intent!.data.returnId as string });
  return true;
}

/** Runs the retention check again from the worker's recorded result, as dispatch did when the attempt finished. */
async function recheck(deps: Dependencies, attempt: AttemptAssessment): Promise<RetentionResult | string> {
  const runtime = (await deps.runtime.discover(deps.contextId)).find(r => r.binding.input.identity.leaseId === attempt.attempt.leaseId);
  if (!runtime) return "The attempt has no runtime records, so its worker's result cannot be checked";
  let report;
  try { report = validateWorkerResult(await readJsonFile(runtime.binding.resultPath), runtime.binding.input); }
  catch (error) { return `The worker's result cannot be read: ${error instanceof Error ? error.message : String(error)}`; }
  if (report.outcome !== "completed") return `The worker reported ${report.outcome}, not completed work; use --accept-output to accept its committed output instead`;
  const delivery = runtime.binding.input.delivery;
  return deps.retention({
    repository: deps.repository, workspace: runtime.binding.input.workspace, outputBranch: delivery.outputBranch,
    gitReferences: report.workReferences.flatMap(w => (w.kind === "git" ? [w] : [])),
    artefacts: report.workReferences.flatMap(w => (w.kind === "artefact" ? [w.path] : [])),
    recyclableRoots: await deps.workspaces.recyclableRoots(),
    artefactDirectory: runtime.binding.artefactDirectory,
    ...(delivery.kind === "artefact" ? { scratchWorkspace: true } : {}),
  });
}

/**
 * A failure no step anticipated still gives a structured result. Each step that changes an owner has its own handler, so
 * the lease's state is unknown only in the sense that this handler does not know which step failed.
 */
const unexpected = (command: "finish" | "discard") => (error: unknown) => result({
  ok: false, reason: "stopped", stage: "finish", lease: "unknown", observed: {},
  detail: `${command} failed unexpectedly: ${error instanceof Error ? error.message : String(error)}. Check status, then run ${command} again`, nextAction: "inspect_attempt",
});

export async function finish(deps: Dependencies, options: { leaseId: string; noProcesses: boolean; dryRun?: boolean; acceptOutput?: boolean }): Promise<DispatchResult> {
  return finishAttempt(deps, options).catch(unexpected("finish"));
}

export async function discard(deps: Dependencies, options: { leaseId: string; noProcesses: boolean; confirm: boolean; dryRun?: boolean; note?: string }): Promise<DispatchResult> {
  return discardAttempt(deps, options).catch(unexpected("discard"));
}

async function finishAttempt(deps: Dependencies, options: { leaseId: string; noProcesses: boolean; dryRun?: boolean; acceptOutput?: boolean }): Promise<DispatchResult> {
  if (!options.noProcesses && !options.dryRun) return refused("confirm_no_processes", "Returning the lease needs your confirmation that no worker process remains (--no-processes)");
  const located = await locate(deps, options.leaseId);
  if (!("record" in located)) return located;
  const { attempt, record } = located;
  const base = { attempt: attempt.attempt };
  if (!options.dryRun && await completeReturn(deps, record, attempt, "finish")) return result({ ok: true, reason: "finished", stage: "finish", lease: "none", observed: {}, ...base, nextAction: "none" });
  const accepted = [...(record.confirmations ?? [])].reverse().find(c => c.fact === "output_accepted");
  const accepting = options.acceptOutput || accepted !== undefined;
  const permission = checkCanFinish(attempt.facts, accepting);
  if (!permission.allowed) return refused(permission.nextAction, permission.detail, { ...base, observed: { refusal: permission } });

  let policy: ResolvedPolicy;
  try { policy = deps.policy ? await resolvePolicy(deps.policy) : { kind: "manual", sources: { kind: "default" }, forbidden: [] }; }
  catch (error) { return refused("fix_configuration", `The finalisation policy cannot be resolved: ${error instanceof Error ? error.message : String(error)}`, base); }
  if (policy.refusal) return refused("fix_configuration", policy.refusal, base);

  const leased = record.entries.find(e => e.kind === "leased");
  let acceptedCommit: string | undefined;
  if (accepting) {
    try {
      const git = { git: deps.policy?.git ?? onPath("git"), environment: deps.policy?.environment ?? {}, repository: deps.repository };
      acceptedCommit = options.acceptOutput ? await branchHead(git, attempt.attempt.outputBranch!) : accepted!.scope.commit;
      const start = leased?.data.startingCommit as string | undefined;
      const permission = checkCanAcceptOutput(attempt.facts, !!acceptedCommit && !!start && acceptedCommit !== start && await isAncestor(git, start, acceptedCommit));
      if (!permission.allowed) return refused(permission.nextAction, permission.detail, { ...base, observed: { refusal: permission } });
    } catch (error) { return refused("inspect_attempt", `The output branch cannot be checked: ${String(error)}`, base); }
  }
  const check = () => acceptedCommit ? deps.retention({
    repository: deps.repository, workspace: attempt.attempt.workspace!, outputBranch: attempt.attempt.outputBranch!,
    resultCommit: acceptedCommit, artefacts: [],
  }) : recheck(deps, attempt);
  const retention = await check();
  if (typeof retention === "string") return refused("inspect_attempt", retention, base);
  if (!retention.retained) return refused("inspect_attempt", `The work is not retained: ${retention.findings.join("; ")}`, { ...base, retention });

  // Under local-merge, check before any change that the target can be fast-forwarded, or already contains the work.
  const outputBranch = attempt.attempt.outputBranch!;
  let integration: { target: string; from: string; to: string } | undefined;
  // The target already contains the work, but an earlier run's fast-forward may not have been recorded.
  let unrecorded: { target: string; commit: string } | undefined;
  if (policy.kind === "local-merge") {
    const git = { git: deps.policy!.git, environment: deps.policy!.environment, repository: deps.repository };
    const to = acceptedCommit ?? await branchHead(git, outputBranch);
    const from = await branchHead(git, policy.targetBranch!);
    if (!to || !from) return refused("inspect_attempt", `Branch ${!to ? outputBranch : policy.targetBranch} cannot be read in the backing repository`, base);
    if (!await isAncestor(git, to, from)) {
      if (!await isAncestor(git, from, to)) return refused("inspect_attempt", `${policy.targetBranch} cannot be fast-forwarded to ${outputBranch}: it has commits the output branch does not`, base);
      integration = { target: policy.targetBranch!, from, to };
    } else if (!record.entries.some(e => e.kind === "integrated")) unrecorded = { target: policy.targetBranch!, commit: to };
  }

  const task = await deps.tasks.read(attempt.attempt.taskId).catch(() => undefined);
  if (!task) return refused("inspect_attempt", "The task cannot be read", base);
  const steps = [
    ...(acceptedCommit ? [`accept output commit ${acceptedCommit} as the operator`] : []),
    ...(integration ? [`fast-forward ${integration.target} to ${integration.to}`] : []),
    ...(task.state === "done" ? [] : ["record the task as done"]),
    `return lease ${options.leaseId}`,
  ];
  if (options.dryRun) return result({ ok: true, reason: "planned", stage: "finish", lease: "preserved", observed: { policy }, ...base, retention, detail: `Would ${steps.join(", then ")}`, nextAction: "none" });

  // From here each step changes an owner; a failure leaves what is done recorded and the rest for a later run.
  const stopped = (error: unknown, step: string) => result({
    ok: false, reason: "stopped", stage: "finish", lease: leaseAfter(error), observed: {}, ...base, retention,
    detail: `Stopped while trying to ${step}: ${error instanceof Error ? error.message : String(error)}. Run finish again to complete it`, nextAction: "inspect_attempt",
  });
  const fenced = await fenceLaunch(deps, record, options.leaseId);
  if (fenced) return refused("inspect_attempt", fenced, base);
  if (acceptedCommit && accepted?.scope.commit !== acceptedCommit) {
    try {
      const current = await locate(deps, options.leaseId);
      if (!("record" in current)) return current;
      const permission = checkCanAcceptOutput(current.attempt.facts, true);
      if (!permission.allowed) return refused(permission.nextAction, permission.detail, { ...base, observed: { refusal: permission } });
      await deps.attempts.appendConfirmed(record, "output_accepted", { commit: acceptedCommit }, { fact: "output_accepted", scope: { commit: acceptedCommit } }, operator);
    }
    catch (error) { return stopped(error, "record the operator's output acceptance"); }
  }
  if (integration) {
    try {
      const retained = await check();
      const current = await locate(deps, options.leaseId);
      if (!("record" in current)) return current;
      const currentPolicy = await resolvePolicy(deps.policy!);
      const permission = checkCanIntegrate(current.attempt.facts, { accepting, retained: typeof retained !== "string" && retained.retained,
        policyRefusal: currentPolicy.refusal ?? (currentPolicy.kind !== "local-merge" || currentPolicy.targetBranch !== integration.target ? "The finalisation policy changed" : undefined), fastForward: true });
      if (!permission.allowed) return refused(permission.nextAction, permission.detail, { ...base, observed: { refusal: permission } });
      await fastForward({ git: deps.policy!.git, environment: deps.policy!.environment, repository: deps.repository }, integration.target, integration.from, integration.to);
      await deps.attempts.append(record, "integrated", { policy: "local-merge", targetBranch: integration.target, commit: integration.to });
    } catch (error) { return stopped(error, `fast-forward ${integration.target}`); }
  }
  if (unrecorded) {
    try { await deps.attempts.append(record, "integrated", { policy: "local-merge", targetBranch: unrecorded.target, commit: unrecorded.commit }); }
    catch (error) { return stopped(error, `record that ${unrecorded.target} contains the work`); }
  }
  if (task.state !== "done" || !record.entries.some(e => e.kind === "task_recorded" && e.data.outcome === "done")) {
    try { await deps.attempts.finishAttempt(record, task); }
    catch (error) { return stopped(error, "record the task as done"); }
  }
  // The PRD's condition 2: retention is checked again immediately before the lease is returned.
  const finalRetention = await check().catch((error: unknown) => `The retention check failed: ${error instanceof Error ? error.message : String(error)}`);
  if (typeof finalRetention === "string" || !finalRetention.retained) {
    const why = typeof finalRetention === "string" ? finalRetention : finalRetention.findings.join("; ");
    return stopped(new Error(`The work is no longer retained: ${why}`), `return lease ${options.leaseId}`);
  }
  try { await returnLease(deps, record, attempt, "finish", async () => { const retained = await check(); return typeof retained !== "string" && retained.retained; }); }
  catch (error) { return stopped(error, `return lease ${options.leaseId}`); }
  return result({ ok: true, reason: "finished", stage: "finish", lease: "none", observed: { policy }, ...base, retention, nextAction: "none" });
}

async function discardAttempt(deps: Dependencies, options: { leaseId: string; noProcesses: boolean; confirm: boolean; dryRun?: boolean; note?: string }): Promise<DispatchResult> {
  if (!options.confirm && !options.dryRun) return refused("confirm_discard", "Discarding the attempt's work needs your explicit confirmation (--confirm)");
  if (!options.noProcesses && !options.dryRun) return refused("confirm_no_processes", "Returning the lease needs your confirmation that no worker process remains (--no-processes)");
  const located = await locate(deps, options.leaseId);
  if (!("record" in located)) return located;
  const { attempt, record } = located;
  const base = { attempt: attempt.attempt };
  if (!options.dryRun && await completeReturn(deps, record, attempt, "discard")) return result({ ok: true, reason: "discarded", stage: "finish", lease: "none", observed: {}, ...base, nextAction: "none" });
  const permission = checkCanDiscard(attempt.facts, options.confirm || !!options.dryRun);
  if (!permission.allowed) return refused(permission.nextAction, permission.detail, { ...base, lease: attempt.leaseHeld ? "preserved" : "none", observed: { refusal: permission } });
  const task = await deps.tasks.read(attempt.attempt.taskId).catch(() => undefined);
  if (!task) return refused("inspect_attempt", "The task cannot be read", base);
  const holdReason = `Switchboard attempt ${attempt.attempt.attempt} discarded`;
  const hold = task.state !== "done" && !(task.held && task.holdReason === holdReason);
  const steps = [...(hold ? ["hold the task"] : []), `discard the workspace's contents and return lease ${options.leaseId}`];
  if (options.dryRun) return result({ ok: true, reason: "planned", stage: "finish", lease: "preserved", observed: {}, ...base, detail: `Would ${steps.join(", then ")}`, nextAction: "none" });

  const stopped = (error: unknown, step: string) => result({
    ok: false, reason: "stopped", stage: "finish", lease: leaseAfter(error), observed: {}, ...base,
    detail: `Stopped while trying to ${step}: ${error instanceof Error ? error.message : String(error)}. Run discard again to complete it`, nextAction: "inspect_attempt",
  });
  const fenced = await fenceLaunch(deps, record, options.leaseId);
  if (fenced) return refused("inspect_attempt", fenced, base);
  try {
    await deps.attempts.discardAttempt(record, task, operator, options.leaseId, options.note);
  } catch (error) { return stopped(error, "record the discard"); }
  try { await returnLease(deps, record, attempt, "discard", async () => false); }
  catch (error) { return stopped(error, `return lease ${options.leaseId}`); }
  return result({ ok: true, reason: "discarded", stage: "finish", lease: "none", observed: {}, ...base, nextAction: "none" });
}
