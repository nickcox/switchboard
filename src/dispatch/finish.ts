import type { AttemptRecord } from "../attempts/log.ts";
import { onPath } from "../infra/executables.ts";
import { validateWorkerResult } from "../runtime/contracts.ts";
import { readJsonFile } from "../runtime/records.ts";
import type { RetentionResult } from "../workspaces/retention.ts";
import { branchHead, fastForward, isAncestor } from "../workspaces/integration.ts";
import type { Dependencies } from "./dispatch.ts";
import { resolvePolicy, type ResolvedPolicy } from "./policy.ts";
import { result, type DispatchResult, type NextAction } from "./result.ts";
import { status, type AttemptStatus } from "./status.ts";

/**
 * `finish` and `discard` (Phase 2 PRD): the only commands that return a lease. Each refuses unless every condition in
 * the PRD's "Returning a lease" holds, and each step reads back its owner and is recorded in the attempt log, so a
 * command interrupted partway can be run again to complete what is left.
 */

type Located = { attempt: AttemptStatus; record: AttemptRecord };
const refused = (nextAction: NextAction, detail: string, extra: Omit<Partial<DispatchResult>, "nextAction" | "version"> = {}) =>
  result({ ok: false, reason: "refused", stage: "finish", lease: "preserved", observed: {}, detail, nextAction, ...extra });

async function locate(deps: Dependencies, leaseId: string): Promise<Located | DispatchResult> {
  const view = await status(deps);
  if (view.reason === "refused") return refused("fix_configuration", view.detail ?? "Owner state could not be read", { lease: "unknown" });
  const attempt = view.attempts.find(a => a.attempt.leaseId === leaseId);
  if (!attempt) return refused("inspect_attempt", "No attempt in this context has this lease ID", { lease: "none" });
  const record = (await deps.attempts.forTask(attempt.attempt.taskId)).find(r => r.attempt === attempt.attempt.attempt);
  if (!record) return refused("inspect_attempt", "The attempt could not be read from the attempt log", { lease: "unknown" });
  return { attempt, record };
}

/** Runs the retention check again from the worker's recorded result, as dispatch did when the attempt finished. */
async function recheck(deps: Dependencies, attempt: AttemptStatus): Promise<RetentionResult | string> {
  const runtime = (await deps.runtime.discover(deps.contextId)).find(r => r.binding.input.identity.leaseId === attempt.attempt.leaseId);
  if (!runtime) return "The attempt has no runtime records, so its worker's result cannot be checked";
  let report;
  try { report = validateWorkerResult(await readJsonFile(runtime.binding.resultPath), runtime.binding.input); }
  catch (error) { return `The worker's result cannot be read: ${error instanceof Error ? error.message : String(error)}`; }
  const delivery = runtime.binding.input.delivery;
  return deps.retention({
    repository: deps.repository, workspace: runtime.binding.input.workspace, outputBranch: delivery.outputBranch,
    gitReferences: report.workReferences.flatMap(w => (w.kind === "git" ? [w] : [])),
    artefacts: report.workReferences.flatMap(w => (w.kind === "artefact" ? [w.path] : [])),
    recyclableRoots: await deps.workspaces.recyclableRoots(),
    ...(runtime.binding.artefactDirectory ? { artefactDirectory: runtime.binding.artefactDirectory } : {}),
    ...(delivery.kind === "artefact" ? { scratchWorkspace: true } : {}),
  });
}

export async function finish(deps: Dependencies, options: { leaseId: string; noProcesses: boolean; dryRun?: boolean; acceptOutput?: boolean }): Promise<DispatchResult> {
  if (!options.noProcesses && !options.dryRun) return refused("confirm_no_processes", "Returning the lease needs your confirmation that no worker process remains (--no-processes)");
  const located = await locate(deps, options.leaseId);
  if (!("record" in located)) return located;
  const { attempt, record } = located;
  const base = { attempt: attempt.attempt };
  if (!attempt.changeable) return refused(attempt.nextAction.code, `The attempt is ${attempt.state.replaceAll("_", " ")}, so it cannot be finished`, base);
  if (attempt.state === "finished") return refused("none", "The attempt is already finished", { ...base, lease: "none" });
  const accepted = [...record.entries].reverse().find(e => e.kind === "output_accepted");
  const accepting = options.acceptOutput || accepted !== undefined;
  if (attempt.state !== "awaiting_review" && attempt.state !== "awaiting_finish" && !(accepting && attempt.state === "held" && attempt.leaseHeld)) {
    return refused(attempt.nextAction.code, `Only an attempt awaiting review or awaiting finish, or a held attempt with --accept-output, can be finished; this one is ${attempt.state.replaceAll("_", " ")}`, base);
  }

  let policy: ResolvedPolicy;
  try { policy = deps.policy ? await resolvePolicy(deps.policy) : { kind: "manual", sources: { kind: "default" }, forbidden: [] }; }
  catch (error) { return refused("fix_configuration", `The finalisation policy cannot be resolved: ${error instanceof Error ? error.message : String(error)}`, base); }
  if (policy.refusal) return refused("fix_configuration", policy.refusal, base);

  const leased = record.entries.find(e => e.kind === "leased");
  let acceptedCommit: string | undefined;
  if (accepting) {
    try {
      const git = { git: deps.policy?.git ?? onPath("git"), environment: deps.policy?.environment ?? {}, repository: deps.repository };
      acceptedCommit = options.acceptOutput ? await branchHead(git, attempt.attempt.outputBranch!) : accepted!.data.commit as string;
      const start = leased?.data.startingCommit as string | undefined;
      if (!acceptedCommit || !start || acceptedCommit === start || !await isAncestor(git, start, acceptedCommit)) {
        return refused("inspect_attempt", "The output branch must exist and have commits beyond the attempt's starting commit", base);
      }
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
  if (policy.kind === "local-merge") {
    const git = { git: deps.policy!.git, environment: deps.policy!.environment, repository: deps.repository };
    const to = acceptedCommit ?? await branchHead(git, outputBranch);
    const from = await branchHead(git, policy.targetBranch!);
    if (!to || !from) return refused("inspect_attempt", `Branch ${!to ? outputBranch : policy.targetBranch} cannot be read in the backing repository`, base);
    if (!await isAncestor(git, to, from)) {
      if (!await isAncestor(git, from, to)) return refused("inspect_attempt", `${policy.targetBranch} cannot be fast-forwarded to ${outputBranch}: it has commits the output branch does not`, base);
      integration = { target: policy.targetBranch!, from, to };
    }
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
    ok: false, reason: "stopped", stage: "finish", lease: "preserved", observed: {}, ...base, retention,
    detail: `Stopped while trying to ${step}: ${error instanceof Error ? error.message : String(error)}. Run finish again to complete it`, nextAction: "inspect_attempt",
  });
  if (acceptedCommit && accepted?.data.commit !== acceptedCommit) {
    try { await deps.attempts.append(record, "output_accepted", { commit: acceptedCommit, acceptedBy: "operator" }); }
    catch (error) { return stopped(error, "record the operator's output acceptance"); }
  }
  if (integration) {
    try {
      await fastForward({ git: deps.policy!.git, environment: deps.policy!.environment, repository: deps.repository }, integration.target, integration.from, integration.to);
      await deps.attempts.append(record, "integrated", { policy: "local-merge", targetBranch: integration.target, commit: integration.to });
    } catch (error) { return stopped(error, `fast-forward ${integration.target}`); }
  }
  if (task.state !== "done") {
    try {
      const note = JSON.stringify({ attempt: attempt.attempt, finishedBy: "switchboard finish", policy: policy.kind, ...(integration ? { integrated: integration.to } : {}) });
      const done = await deps.tasks.recordDone(task.id, note);
      if (done.state !== "done") throw new Error("The task store does not show the task as done");
      await deps.attempts.append(record, "task_recorded", { outcome: "done", reason: "finished" });
    } catch (error) { return stopped(error, "record the task as done"); }
  }
  try {
    if (acceptedCommit) {
      const finalRetention = await check();
      if (typeof finalRetention === "string" || !finalRetention.retained) throw new Error("The accepted output is no longer retained");
    }
    await deps.workspaces.returnLease({ leaseId: options.leaseId, holder: attempt.attempt.taskId, path: attempt.attempt.workspace! }, { discardChanges: false });
    await deps.attempts.append(record, "lease_returned", { leaseId: options.leaseId, by: "finish", noProcessesConfirmedBy: "operator" });
  } catch (error) { return stopped(error, `return lease ${options.leaseId}`); }
  return result({ ok: true, reason: "finished", stage: "finish", lease: "none", observed: { policy }, ...base, retention, nextAction: "none" });
}

const discardable = ["awaiting_review", "awaiting_finish", "held", "not_retained", "stopped", "task_update_unconfirmed"];

export async function discard(deps: Dependencies, options: { leaseId: string; noProcesses: boolean; confirm: boolean; dryRun?: boolean; note?: string }): Promise<DispatchResult> {
  if (!options.confirm && !options.dryRun) return refused("confirm_discard", "Discarding the attempt's work needs your explicit confirmation (--confirm)");
  if (!options.noProcesses && !options.dryRun) return refused("confirm_no_processes", "Returning the lease needs your confirmation that no worker process remains (--no-processes)");
  const located = await locate(deps, options.leaseId);
  if (!("record" in located)) return located;
  const { attempt, record } = located;
  const base = { attempt: attempt.attempt };
  if (!attempt.changeable) return refused(attempt.nextAction.code, `The attempt is ${attempt.state.replaceAll("_", " ")}, so it cannot be discarded`, base);
  if (!discardable.includes(attempt.state) || !attempt.leaseHeld) {
    return refused(attempt.nextAction.code, `An attempt that is ${attempt.state.replaceAll("_", " ")} has no listed lease to discard`, { ...base, lease: attempt.leaseHeld ? "preserved" : "none" });
  }
  const task = await deps.tasks.read(attempt.attempt.taskId).catch(() => undefined);
  if (!task) return refused("inspect_attempt", "The task cannot be read", base);
  const holdReason = `Switchboard attempt ${attempt.attempt.attempt} discarded`;
  const steps = [...(task.state === "in_flight" ? ["hold the task"] : []), `discard the workspace's contents and return lease ${options.leaseId}`];
  if (options.dryRun) return result({ ok: true, reason: "planned", stage: "finish", lease: "preserved", observed: {}, ...base, detail: `Would ${steps.join(", then ")}`, nextAction: "none" });

  const stopped = (error: unknown, step: string) => result({
    ok: false, reason: "stopped", stage: "finish", lease: "preserved", observed: {}, ...base,
    detail: `Stopped while trying to ${step}: ${error instanceof Error ? error.message : String(error)}. Run discard again to complete it`, nextAction: "inspect_attempt",
  });
  try {
    if (!record.entries.some(e => e.kind === "discarded")) await deps.attempts.append(record, "discarded", { ...(options.note ? { note: options.note } : {}) });
    // A task left in flight would never be dispatched again; hold it so the operator decides what happens next.
    if (task.state === "in_flight") await deps.tasks.recordHold(task.id, { reason: holdReason, body: `${task.body}\n\n## ${holdReason}\n` });
  } catch (error) { return stopped(error, "record the discard"); }
  try {
    await deps.workspaces.returnLease({ leaseId: options.leaseId, holder: attempt.attempt.taskId, path: attempt.attempt.workspace! }, { discardChanges: true });
    await deps.attempts.append(record, "lease_returned", { leaseId: options.leaseId, by: "discard", noProcessesConfirmedBy: "operator" });
  } catch (error) { return stopped(error, `return lease ${options.leaseId}`); }
  return result({ ok: true, reason: "discarded", stage: "finish", lease: "none", observed: {}, ...base, nextAction: "none" });
}
