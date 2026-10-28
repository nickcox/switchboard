import { outputTarget } from "./output-branch.ts";
import { randomUUID } from "node:crypto";
import { AttemptStoreError, type StartingPointEvidence } from "../attempts/store.ts";
import type { ReviewTarget } from "../runtime/contracts.ts";
import type { Dependencies } from "./dependencies.ts";
import { assessAttempts } from "./assess.ts";
import { observeAttempts } from "./observe.ts";
import { requireOperationAuthority, checkCanStartFrom } from "./safety.ts";
import { result, type DispatchResult } from "./result.ts";

/** Read the recorded commit, not today's branch head or worker result file. */
export async function reviewSource(deps: Dependencies, taskId: string, attempt?: number): Promise<{ target: ReviewTarget; evidence: StartingPointEvidence }> {
  const observation = await observeAttempts(deps);
  const unknown = [observation.records, observation.runtime, observation.leases, observation.pool].flatMap(owner => owner.known ? [] : [owner.reason]);
  if (unknown.length) throw new AttemptStoreError("starting_point_unknown", unknown.join("; "));
  const record = deps.attempts.findForTask(taskId, attempt);
  if (!record) throw new AttemptStoreError("starting_point_unknown", "The reviewed attempt is missing or archived; inspect its records");
  const assessment = assessAttempts(observation).find(assessment => assessment.attempt.taskId === taskId && assessment.attempt.attempt === record.attempt);
  if (!assessment) throw new AttemptStoreError("starting_point_unknown", "The reviewed attempt could not be assessed");
  const permission = checkCanStartFrom(assessment.facts);
  if (!permission.allowed) throw new AttemptStoreError(permission.reason === "possibly_running" ? "possibly_running" : "starting_point_unknown", permission.detail);
  const commit = deps.attempts.startingPointCommit(record);
  if (!commit) throw new AttemptStoreError("output_not_recorded", "The reviewed attempt has no recorded output commit");
  const allocation = record.allocation;
  if (!allocation) throw new AttemptStoreError("starting_point_unknown", "The reviewed attempt has no recorded allocation");
  if (allocation.backingRepository !== deps.repository) throw new AttemptStoreError("starting_point_unknown", "The reviewed attempt belongs to a different backing repository");
  const retention = await deps.retention({
    repository: allocation.backingRepository, workspace: allocation.workspace, outputBranch: allocation.outputBranch, targetBranch: outputTarget(record), commitsOnly: true,
    gitReferences: [{ name: "reviewed-output", branch: allocation.outputBranch, commit }], artefacts: [],
    recyclableRoots: await deps.workspaces.recyclableRoots(),
  });
  if (!retention.retained) throw new AttemptStoreError("not_retained", retention.findings.join("; ") || "The reviewed output commit is not retained", "fix_or_discard");
  const runtime = observation.runtime.known ? observation.runtime.value.find(runtime => runtime.binding.input.identity.leaseId === allocation.leaseId) : undefined;
  const sessionId = runtime?.binding.input.identity.sessionId ?? record.entries.find(entry => entry.kind === "launched")?.data.sessionId as string | undefined;
  return {
    target: { taskId, attempt: record.attempt, commit, outputBranch: allocation.outputBranch, ...(sessionId ? { sessionId } : {}) },
    evidence: { records: observation.records.known ? observation.records.value : [], unknown: [], retainedCommit: commit },
  };
}

/** Create a queued review task only. Dispatch is always a separate request. */
export async function createReview(deps: Dependencies, options: { taskId: string; attempt?: number }): Promise<DispatchResult> {
  try {
    requireOperationAuthority(deps, ["manageTasks"], options);
    if (!deps.delivery.byTaskKind.review) return result({ ok: false, reason: "refused", stage: "select", lease: "none", observed: {},
      detail: "Configure delivery.byTaskKind.review before creating a review task", nextAction: "fix_configuration" });
    const { target, evidence } = await reviewSource(deps, options.taskId, options.attempt);
    const id = `${target.taskId}-review-${target.attempt}-${randomUUID().slice(0, 8)}`;
    const task = await deps.attempts.createReviewTask(id, target, evidence);
    return result({ ok: true, reason: "review_created", stage: "select", lease: "none", observed: { reviewTaskId: id, reviewTarget: target },
      task: { id, state: task.state, held: task.held, holdReason: task.holdReason },
      detail: `Review task ${id} judges ${target.taskId} attempt ${target.attempt} at ${target.commit}. Dispatch it with --task ${id}.`, nextAction: "dispatch_again" });
  } catch (error) {
    return result({ ok: false, reason: "refused", stage: "select", lease: "none", observed: { reason: error instanceof AttemptStoreError ? error.reason : "review_unavailable" },
      detail: error instanceof Error ? error.message : String(error), nextAction: error instanceof AttemptStoreError ? error.nextAction : "inspect_attempt" });
  }
}
