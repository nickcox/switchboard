import { ObjectiveStore, type ObjectiveBrief } from "../objectives/store.ts";
import { readQuestions, type Question, type InvalidQuestionFile } from "../runtime/questions-store.ts";
import { describeQuestions } from "../runtime/questions.ts";
import { describeObjectiveBudget } from "../objectives/budget.ts";
import { describeChecks, type CheckResult } from "../attempts/checks.ts";
import { describeReviews, type ReviewRecord } from "../attempts/reviews.ts";
import { describeCriteriaReport } from "../runtime/criteria-report.ts";
import type { CriteriaReport } from "../runtime/contracts.ts";
import type { ReadFailure } from "./failure.ts";
import { unsettledReads } from "./owner-reads.ts";
import { readActivity } from "../runtime/activity.ts";
import { attemptSpecificationSchema, type StoredSpecification, type AttemptAllocation } from "../attempts/specification.ts";
import type { RuntimeRecord } from "../runtime/records.ts";
import type { Lease } from "../workspaces/provider.ts";
import type { Dependencies } from "./dispatch.ts";
import type { AttemptState } from "./state.ts";
import { observeAttempts } from "./observe.ts";
import { assessAttempts } from "./assess.ts";
import { resolvePolicy, type ResolvedPolicy } from "./policy.ts";
import { summariseActivity, transcriptPath, type ActivitySummary } from "./watch.ts";
import { describeAcceptanceEvidence, nextActions, type AttemptSummary, type NextAction } from "./result.ts";
import { checkAcceptanceEvidence, type AcceptanceEvidence } from "./safety.ts";

export type AttemptStatus = {
  questions?: Question[];
  invalidQuestionFiles?: InvalidQuestionFile[];
  taskDisagreement?: boolean;
  latestReadFailure?: ReadFailure & { sequence: number };
  unsettledReadFailures?: (ReadFailure & { sequence: number })[];
  validatedResult?: RuntimeRecord["validatedResult"];
  resultDiscrepancy?: string;
  criteriaReport?: CriteriaReport;
  checks?: CheckResult[];
  reviews?: ReviewRecord[];
  outputCommit?: string;
  acceptanceEvidence: AcceptanceEvidence;
  specification?: StoredSpecification;
  specificationComplete: boolean;
  allocation?: AttemptAllocation;
  attempt: AttemptSummary;
  /** The attempt's state across every owner (Phase 2 PRD, attempt states). */
  state: AttemptState;
  /** Whether a command may change this attempt: false while its worker may be running or any owner state is unknown. */
  changeable: boolean;
  unknownOwners?: string[];
  lastEntry: string;
  possiblyRunning: boolean;
  leaseHeld: boolean;
  /**
   * The workspace pool the attempt's lease was acquired in, when the provider no longer lists that pool. Whether the
   * lease is still held is then unknown, and `leaseHeld` is false only because it is not listed.
   */
  leaseInOtherPool?: string;
  task: { state: string; held: boolean; holdReason: string | null } | "missing" | "unreadable";
  /** From the attempt's activity log, when the worker was launched. Diagnostic only. */
  activity?: ActivitySummary & { stale: boolean };
  /** Pi's session file: the worker's full transcript. */
  transcript?: string;
  thinkingLevel?: RuntimeRecord["thinkingLevel"];
  /**
   * What Switchboard can see of the worker, to help the operator before confirming `--no-processes`: whether its direct
   * child's exit was observed or confirmed by the operator, and whether the owning dispatcher's heartbeat is fresh.
   * Neither proves that no process from the worker remains.
   */
  worker?: {
    exit: "observed" | "operator_confirmed_stopped" | "not_observed"; code?: number | null; signal?: string | null;
    dispatcherHeartbeat: "fresh" | "stale_or_missing";
    claim?: { id: string; ownerPid: number; ownerStartedAt: string; heartbeatAt: string; releasedAt: string | null };
  };
  /** How to continue the work by hand. Offered only once the worker is known to have stopped. */
  takeover?: string;
  nextAction: { code: NextAction; description: string };
};

export type StatusOptions = { activity?: boolean; transcript?: boolean };
const defaultStaleMs = 20 * 60 * 1000;

/** Quotes a path for the operator's shell: POSIX shells on macOS and Linux, PowerShell on Windows. */
function quote(path: string): string {
  return process.platform === "win32" ? `"${path.replace(/["`$]/g, "`$&")}"` : `'${path.replace(/'/g, "'\\''")}'`;
}

async function workerView(record: RuntimeRecord | undefined, possiblyRunning: boolean, running: boolean, staleMs: number, leases: Lease[], options: StatusOptions): Promise<Pick<AttemptStatus, "activity" | "transcript" | "takeover" | "thinkingLevel" | "worker">> {
  if (!record) return {};
  const child = record.child;
  const claim = await record.storage.heartbeat(record.claimId);
  const worker: AttemptStatus["worker"] = {
    ...(child.status === "exited" ? { exit: "observed" as const, code: child.exit.code, signal: child.exit.signal } : { exit: child.status === "operator_confirmed_stopped" ? "operator_confirmed_stopped" as const : "not_observed" as const }),
    dispatcherHeartbeat: running ? "fresh" : "stale_or_missing",
    ...(claim ? { claim: { id: record.claimId, ownerPid: Number(claim.owner_pid), ownerStartedAt: String(claim.owner_started_at),
      heartbeatAt: String(claim.heartbeat_at), releasedAt: claim.released_at === null ? null : String(claim.released_at) } } : {}),
  };
  const activity = options.activity === false ? undefined : summariseActivity(await readActivity(record));
  const stale = possiblyRunning && activity !== undefined && (activity.lastActivity === null || Date.now() - Date.parse(activity.lastActivity) > staleMs);
  const transcript = options.transcript === false ? undefined : await transcriptPath(record);
  const { sessionId } = record.binding.input.identity;
  return {
    worker,
    ...(activity ? { activity: { ...activity, stale } } : {}),
    ...(record.thinkingLevel === undefined ? {} : { thinkingLevel: record.thinkingLevel }),
    ...(transcript ? { transcript } : {}),
    // Only while the worker has stopped and its own lease still holds the same workspace: once the lease is returned,
    // the path may belong to another task.
    ...(possiblyRunning || !leases.some(l => l.leaseId === record.binding.input.identity.leaseId && l.path === record.binding.input.workspace) ? {} : {
      takeover: `cd ${quote(record.binding.input.workspace)} && pi --session-id ${sessionId} --session-dir ${quote(record.binding.sessionDirectory)}`,
    }),
  };
}

export type StatusResult = {
  version: 1;
  ok: boolean;
  /** `clear` when nothing needs the operator; `attention` when an attempt does; otherwise why state is unknown. */
  reason: "clear" | "attention" | "refused";
  ready: string[];
  inFlight: string[];
  /** Leases in this context's pool that no attempt in the log accounts for. */
  unaccountedLeases: { leaseId: string; holder: string; path: string }[];
  /** Imported tasks can be in flight with no attempt, runtime record or lease accounting for them. */
  orphanedInFlight: string[];
  attempts: AttemptStatus[];
  objectives: ObjectiveBrief[];
  openQuestions?: Question[];
  /** The context's resolved finalisation policy, or why it could not be resolved. Absent when none is configured. */
  policy?: { resolved: ResolvedPolicy } | { error: string };
  detail?: string;
  nextAction: { code: NextAction; description: string };
};

const action = (code: NextAction) => ({ code, description: nextActions[code] });

/** Read-only view of every attempt and the owner state that decides what happens next. Changes nothing. */
export async function status(deps: Dependencies, options: StatusOptions = {}): Promise<StatusResult> {
  const context = await observeAttempts(deps);
  const assessed = assessAttempts(context);
  const leases = context.leases.known ? context.leases.value : [];
  const records = context.records.known ? context.records.value : [];
  const runtime = context.runtime.known ? context.runtime.value : [];
  const errors = [context.records, context.runtime, context.leases, context.pool].flatMap(owner => owner.known ? [] : [owner.reason]);
  let ready: string[] = [], inFlight: string[] = [];
  try { ready = await deps.tasks.ready(); inFlight = await deps.tasks.inFlight(); }
  catch (error) { errors.push(`The task store could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  let objectives: ObjectiveBrief[] = [];
  try { objectives = new ObjectiveStore(deps.attempts.database, deps.caller).list("open"); }
  catch (error) { errors.push(`The objectives could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  const attempts: AttemptStatus[] = [];
  for (const { facts, ...assessment } of assessed) {
    const worker = runtime.find(r => r.binding.input.identity.leaseId === assessment.attempt.leaseId);
    const record = records.find(r => r.taskId === assessment.attempt.taskId && r.attempt === assessment.attempt.attempt);
    const latestReadFailure = [...(record?.entries ?? [])].reverse().find(e => e.kind === "owner_read_failed");
    const unsettled = record ? unsettledReads(record) : [];
    const reconcile = unsettled.length > 0;
    attempts.push({ ...assessment,
      ...(record?.questions ? { questions: record.questions } : {}),
      ...(record?.invalidQuestionFiles ? { invalidQuestionFiles: record.invalidQuestionFiles } : {}),
      acceptanceEvidence: { ...(assessment.outputCommit ? { commit: assessment.outputCommit } : {}),
        permission: checkAcceptanceEvidence(assessment.outputCommit, deps.checks ?? [], assessment.checks ?? [], assessment.reviews ?? []) },
      ...(latestReadFailure ? { latestReadFailure: { ...latestReadFailure.data as ReadFailure, sequence: latestReadFailure.sequence } } : {}),
      ...(reconcile ? { unsettledReadFailures: unsettled.map(e => ({ ...e.data as ReadFailure, sequence: e.sequence })) } : {}),
      specificationComplete: attemptSpecificationSchema.safeParse(record?.specification).success,
      ...(worker?.validatedResult ? { validatedResult: worker.validatedResult } : {}),
      ...(record?.specification ? { specification: record.specification } : {}), ...(record?.allocation ? { allocation: record.allocation } : {}),
      changeable: facts.unknown.length === 0 && facts.hasRecord && typeof facts.task === "object" && !facts.possiblyRunning && !reconcile,
      ...(assessment.state === "awaiting_finish" ? { nextAction: { code: "finish_attempt" as const,
        description: `The task is done with its lease retained. Once no worker process remains, return it with switchboard finish --lease ${assessment.attempt.leaseId} --no-processes` } } : {}),
      ...(reconcile ? { nextAction: action("reconcile_owner") } : {}),
      ...(facts.unknown.length ? { unknownOwners: facts.unknown } : {}),
      ...await workerView(worker, assessment.possiblyRunning, facts.dispatcherRunning, deps.staleMs ?? defaultStaleMs, leases, options).catch(() => ({})) });
  }
  const known = new Set(attempts.map(a => a.attempt.leaseId).filter(Boolean));
  const unaccountedLeases = leases.filter(l => !known.has(l.leaseId)).map(({ leaseId, holder, path }) => ({ leaseId, holder, path }));
  const orphanedInFlight = inFlight.filter(id => !records.some(a => a.taskId === id) &&
    !runtime.some(r => r.binding.input.identity.taskId === id) && !leases.some(l => l.holder === id));
  const unaccounted = unaccountedLeases.length > 0 || orphanedInFlight.length > 0;
  const policy = deps.policy === undefined ? undefined
    : await resolvePolicy(deps.policy).then(resolved => ({ resolved }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  // A policy that cannot be resolved needs fixing before any attempt can be finished.
  const openQuestions = readQuestions(deps.attempts.database, { contextId: deps.contextId }).questions.filter(question => !question.answer);
  const attention = openQuestions.length > 0 || attempts.some(a => a.resultDiscrepancy || (a.nextAction.code !== "none" && a.nextAction.code !== "watch_attempt")) || unaccounted || (policy !== undefined && "error" in policy);
  return {
    version: 1, ok: !attention && errors.length === 0, reason: errors.length ? "refused" : attention ? "attention" : "clear", ready, inFlight, unaccountedLeases, orphanedInFlight, attempts, objectives,
    ...(openQuestions.length ? { openQuestions } : {}),
    ...(errors.length ? { detail: errors.join("; ") } : {}), ...(policy ? { policy } : {}),
    nextAction: action(errors.length ? "fix_configuration" : overall(attempts, unaccounted)),
  };
}

/** Prioritise stop confirmation when no dispatcher heartbeat is fresh; otherwise use the shared next action. */
function overall(attempts: AttemptStatus[], unaccounted: boolean): NextAction {
  if (attempts.some(a => a.nextAction.code === "stop_worker")) return "stop_worker";
  const pending = new Set(attempts.map(a => a.nextAction.code).filter(code => code !== "none"));
  if (pending.size === 0 && !unaccounted) return "dispatch_again";
  return pending.size === 1 && !unaccounted ? [...pending][0]! : "inspect_attempt";
}

function describePolicy(policy: NonNullable<StatusResult["policy"]>): string {
  if ("error" in policy) return `Finalisation policy cannot be resolved: ${policy.error}`;
  const p = policy.resolved;
  const target = p.targetBranch ? ` into ${p.targetBranch} (target from the ${p.sources.targetBranch} layer)` : "";
  const forbidden = p.forbidden.length ? `; forbidden: ${p.forbidden.map(f => `${f.kind} by the ${f.by} layer`).join(", ")}` : "";
  const notes = `${p.refusal ? `; cannot be used: ${p.refusal}` : ""}${p.forgeUnknown ? `; not checked against the forge: ${p.forgeUnknown}` : ""}`;
  return `Finalisation policy: ${p.kind} (from the ${p.sources.kind} layer)${target}${forbidden}${notes}`;
}

export function describeStatus(value: StatusResult): string {
  const lines = [`${value.reason === "clear" ? "Clear" : value.reason === "attention" ? "Needs attention" : "Unknown: owner state could not be read"}`];
  if (value.detail) lines.push(`Detail: ${value.detail}`);
  lines.push(`Ready: ${value.ready.join(", ") || "none"}`, `In flight: ${value.inFlight.join(", ") || "none"}`);
  for (const objective of value.objectives) lines.push(`Objective ${objective.id}: ${objective.request.replace(/\s+/g, " ").slice(0, 120)}; ${objective.doneTaskCount}/${objective.taskCount} tasks done; ${describeObjectiveBudget(objective)}`);
  for (const a of value.attempts) {
    const task = typeof a.task === "string" ? a.task : `${a.task.state}${a.task.held ? `, held: ${a.task.holdReason}` : ""}`;
    const where = a.attempt.workspace ?? "an unknown path";
    const lease = a.leaseInOtherPool !== undefined ? `lease ${a.attempt.leaseId ?? "with unknown ID"} at ${where} UNKNOWN: its workspace pool is no longer listed`
      : !a.attempt.leaseId ? "no lease"
      : a.leaseHeld ? `lease ${a.attempt.leaseId} held at ${where}`
      : `lease ${a.attempt.leaseId} not held`;
    lines.push(`- ${a.attempt.taskId} attempt ${a.attempt.attempt}: ${a.state.replaceAll("_", " ")}; last ${a.lastEntry}; task ${task}; ${lease}${a.possiblyRunning ? (a.nextAction.code === "watch_attempt" ? "; WORKER RUNNING" : "; WORKER MAY BE RUNNING") : ""}`);
    if (!a.specificationComplete) lines.push("  Stored specification incomplete – this attempt cannot be launched; inspect and resolve it");
    if (a.specification) lines.push(`  Specification: ${a.specification.title ?? "unknown title"}, revision ${a.specification.definitionRevision ?? "unknown"}; ${a.specification.runtime?.profile ?? "unknown profile"}`);
    if (a.specification?.handover) lines.push(a.specification.handover);
    if (a.unknownOwners) for (const reason of a.unknownOwners) lines.push(`  Unknown: ${reason}`);
    if (a.latestReadFailure) {
      const f = a.latestReadFailure;
      lines.push(`  Latest read failure: sequence ${f.sequence}; ${f.owner}; ${f.classification}; ${f.operation}/${f.step}; ${f.failedAt}`);
      if (a.unsettledReadFailures?.length) lines.push(`  Unsettled read failures: ${a.unsettledReadFailures.map(f => f.sequence).join(", ")}`);
      lines.push(`  Read diagnostics: ${JSON.stringify(f.diagnostics)}`);
    }
    lines.push(`  ${describeAcceptanceEvidence(a.acceptanceEvidence)}`);
    for (const line of describeReviews(a.reviews)) lines.push(`  ${line}`);
    for (const line of describeChecks(a.checks)) lines.push(`  ${line}`);
    for (const line of describeCriteriaReport(a.criteriaReport)) lines.push(`  ${line}`);
    for (const line of describeQuestions(a.questions ?? [])) lines.push(`  ${line}`);
    for (const file of a.invalidQuestionFiles ?? []) lines.push(`  Invalid question file ${file.filename}: ${file.diagnostic}`);
    if (a.resultDiscrepancy) lines.push(`  Result discrepancy: ${a.resultDiscrepancy}`);
    if (a.taskDisagreement) lines.push("  Task unchanged: a newer operator decision disagrees with the attempt outcome");
    const thinking = `thinking ${a.thinkingLevel ?? "unknown"}`;
    if (a.activity?.lastActivity) {
      const usage = a.activity.tokens === null ? "" : `; ${a.activity.tokens} tokens, $${(a.activity.cost ?? 0).toFixed(2)}`;
      lines.push(`  Last activity ${a.activity.lastActivity}${a.activity.currentTool ? `, running ${a.activity.currentTool}` : ""}${usage}; ${thinking}${a.activity.stale ? "; NO RECENT ACTIVITY" : ""}`);
    } else lines.push(`  No activity recorded; ${thinking}${a.activity?.stale ? "; NO RECENT ACTIVITY" : ""}`);
    if (a.worker) {
      const exit = a.worker.exit === "observed" ? `observed (${a.worker.code !== null && a.worker.code !== undefined ? `code ${a.worker.code}` : `signal ${a.worker.signal}`})`
        : a.worker.exit === "operator_confirmed_stopped" ? "not observed; the operator confirmed the worker stopped" : "not observed";
      lines.push(`  Worker exit: ${exit}; dispatcher heartbeat ${a.worker.dispatcherHeartbeat === "fresh" ? "fresh" : "stale or missing"}`);
      const claim = a.worker.claim;
      if (claim) lines.push(`  Dispatcher claim ${claim.id}: PID ${claim.ownerPid}, started ${claim.ownerStartedAt}; last heartbeat ${claim.heartbeatAt}${claim.releasedAt ? `; released ${claim.releasedAt}` : ""}`);
    }
    if (a.transcript) lines.push(`  Transcript: ${a.transcript}`);
    if (a.takeover) lines.push(`  Take over by hand: ${a.takeover}`);
    if (a.nextAction.code !== "none") lines.push(`  Next: ${a.nextAction.description}`);
  }
  for (const question of value.openQuestions ?? []) {
    lines.push(`Open question ${question.id}: task ${question.taskId}, attempt ${question.attempt} – ${question.text}`);
    lines.push(`  Answer with switchboard answer --task ${question.taskId} --question ${question.id} "<answer>"`);
  }
  for (const l of value.unaccountedLeases) lines.push(`- Lease ${l.leaseId} for ${l.holder} at ${l.path} is not in the attempt log`);
  for (const id of value.orphanedInFlight) lines.push(`- Task ${id} is in flight, but no attempt, worker or lease accounts for it`);
  if (value.policy) lines.push(describePolicy(value.policy));
  lines.push(`Next: ${value.nextAction.description}`);
  return lines.join("\n");
}
