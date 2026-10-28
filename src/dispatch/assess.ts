import { isOpen } from "./attempt.ts";
import { otherPool, unfinished, workerMayBeRunning, type AttemptObservation, type ContextObservation } from "./observe.ts";
import { classify, type AttemptState, type TaskView } from "./state.ts";
import { nextActions, type AttemptSummary, type NextAction } from "./result.ts";

export type AttemptFacts = {
  unknown: string[];
  hasRecord: boolean;
  possiblyRunning: boolean;
  dispatcherRunning: boolean;
  leaseHeld: boolean;
  leaseInOtherPool: boolean;
  open: boolean;
  unfinished: boolean;
  task: TaskView;
  recordedOutcome: boolean;
  matchingHold: boolean;
  outcomeCategory: string | undefined;
  completedOutcomePending: boolean;
  acceptedOutput: boolean;
  discarded: boolean;
  lastRecordedAt: string | undefined;
  /** Includes other attempts of this task, to protect shared runtime evidence during prune. */
  taskLeaseHeld: boolean;
  taskWorkerMayBeRunning: boolean;
  leaseReturnedConfirmed: boolean;
};
export type AttemptAssessment = {
  attempt: AttemptSummary;
  state: AttemptState;
  nextAction: { code: NextAction; description: string };
  lastEntry: string;
  possiblyRunning: boolean;
  leaseHeld: boolean;
  leaseInOtherPool?: string;
  task: TaskView;
  taskDisagreement?: boolean;
  resultDiscrepancy?: string;
  facts: AttemptFacts;
};

/** Pure assessment of owner evidence. State labels help people; operation checks use the facts instead. */
export function assessAttempt(observation: AttemptObservation): AttemptAssessment {
  const unknown = [observation.record, observation.runtime, observation.leases, observation.pool, observation.task, observation.heartbeat]
    .flatMap(owner => owner.known ? [] : [owner.reason]);
  const record = observation.record.known ? observation.record.value : undefined;
  const leases = observation.leases.known ? observation.leases.value : [];
  const task = observation.task.known ? observation.task.value : "unreadable";
  const recorded = record && [...record.entries].reverse().find(e => e.kind === "task_recorded");
  const possiblyRunning = workerMayBeRunning(observation);
  const dispatcherRunning = observation.heartbeat.known && observation.heartbeat.value;
  const leaseHeld = leases.some(l => l.leaseId === observation.attempt.leaseId);
  const pool = otherPool(observation);
  const facts: AttemptFacts = {
    unknown, hasRecord: record !== undefined, possiblyRunning, dispatcherRunning, leaseHeld, leaseInOtherPool: pool !== undefined,
    open: record !== undefined && isOpen(record), unfinished: unfinished(observation), task,
    recordedOutcome: recorded !== undefined,
    matchingHold: typeof task === "object" && task.held && recorded !== undefined && task.holdReason === recorded.data.reason,
    outcomeCategory: recorded?.data.category as string | undefined,
    completedOutcomePending: recorded === undefined && record !== undefined && record.entries.some(e => e.kind === "task_started") &&
      record.entries.some(e => e.kind === "worker_finished" && e.data.status === "reported" && e.data.outcome === "completed"),
    acceptedOutput: record?.confirmations?.some(c => c.fact === "output_accepted") ?? false,
    discarded: record?.entries.some(e => e.kind === "discarded") ?? false,
    lastRecordedAt: record?.entries.at(-1)?.recordedAt,
    taskLeaseHeld: leases.some(l => l.holder === observation.attempt.taskId || l.leaseId === observation.attempt.leaseId),
    taskWorkerMayBeRunning: observation.taskWorkerMayBeRunning,
    leaseReturnedConfirmed: record?.confirmations?.some(c => c.fact === "lease_returned") ?? false,
  };
  const classified = classify({ record, possiblyRunning, dispatcherRunning, leaseHeld, leaseInOtherPool: pool !== undefined,
    unfinished: facts.unfinished, task });
  const state = unknown.length ? "unknown" : classified.state;
  const code = unknown.length ? "inspect_attempt" : classified.nextAction;
  return { attempt: observation.attempt, state, nextAction: { code, description: nextActions[code] }, facts,
    lastEntry: record?.entries.at(-1)?.kind ?? "none", possiblyRunning, leaseHeld, task,
    ...(pool === undefined ? {} : { leaseInOtherPool: pool }),
    ...(observation.runtime.known && observation.runtime.value?.resultDiscrepancy ? { resultDiscrepancy: observation.runtime.value.resultDiscrepancy } : {}),
    ...(record?.entries.some(e => e.kind === "task_recorded" && e.data.applied === false) ? { taskDisagreement: true } : {}) };
}

export function assessAttempts(context: ContextObservation): AttemptAssessment[] {
  return context.attempts.map(observation => {
    const assessment = assessAttempt(observation);
    assessment.facts.taskWorkerMayBeRunning = !context.runtime.known || context.runtime.value.some(r =>
      r.binding.input.identity.taskId === assessment.attempt.taskId && r.child.status === "unknown" &&
      !context.attempts.some(a => a.attempt.leaseId === r.binding.input.identity.leaseId && !workerMayBeRunning(a)));
    return assessment;
  });
}
