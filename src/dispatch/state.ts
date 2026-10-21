import { type AttemptRecord } from "../attempts/log.ts";
import type { NextAction } from "./result.ts";

/**
 * Each attempt's state across the attempt log, the runtime records, the workspace leases and the task store (Phase 2
 * PRD, attempt states). It is the single source of an attempt's next action and of whether a command may change it.
 */
export type AttemptState =
  | "running" | "possibly_running" | "unfinished" | "lease_in_other_pool" | "task_update_unconfirmed"
  | "not_retained" | "awaiting_review" | "awaiting_finish" | "held" | "stopped" | "finished" | "unknown";

export type TaskView = { state: string; held: boolean; holdReason: string | null } | "missing" | "unreadable";

export type StateInput = {
  record: AttemptRecord | undefined;
  /** No observed or confirmed exit for the attempt's worker. */
  possiblyRunning: boolean;
  /** The owning dispatcher's heartbeat is fresh. */
  dispatcherRunning: boolean;
  leaseHeld: boolean;
  leaseInOtherPool: boolean;
  /** The attempt is open and is its task's latest attempt. */
  unfinished: boolean;
  task: TaskView;
};

const nextActionFor: Record<AttemptState, NextAction> = {
  running: "watch_attempt",
  possibly_running: "stop_worker",
  unfinished: "confirm_attempt_stopped",
  lease_in_other_pool: "confirm_lease_returned",
  task_update_unconfirmed: "complete_task_update",
  not_retained: "fix_or_discard",
  awaiting_review: "review_then_finish",
  awaiting_finish: "finish_attempt",
  held: "inspect_attempt",
  stopped: "inspect_attempt",
  finished: "none",
  unknown: "inspect_attempt",
};

/** The checks are ordered from the most urgent: a worker that may be running outranks everything else. */
export function classify(input: StateInput): { state: AttemptState; nextAction: NextAction; changeable: boolean } {
  const state = stateOf(input);
  // A command may change an attempt only once its worker has stopped and every owner's state is known.
  return { state, nextAction: nextActionFor[state], changeable: !["running", "possibly_running", "unknown"].includes(state) };
}

function stateOf(input: StateInput): AttemptState {
  if (input.possiblyRunning) return input.dispatcherRunning ? "running" : "possibly_running";
  if (input.record === undefined || typeof input.task !== "object") return "unknown";
  if (input.leaseInOtherPool) return "lease_in_other_pool";
  if (input.unfinished && !input.leaseHeld) return "unfinished";
  const entries = input.record.entries;
  const recorded = [...entries].reverse().find(e => e.kind === "task_recorded");
  if (!recorded && entries.some(e => e.kind === "halted" && e.data.stage === "finalise")) return "task_update_unconfirmed";
  const task = input.task;
  if (!input.leaseHeld) return task.state === "in_flight" ? "stopped" : "finished";
  if (!recorded) return "stopped";
  if (task.state === "done") return "awaiting_finish";
  if (!task.held) return "stopped";
  // The recorded outcome decides, and the task store only confirms it: a hold whose reason was changed since is
  // classified as held for another reason, whatever the new reason says.
  if (task.holdReason !== recorded.data.reason) return "held";
  const category = recorded.data.category;
  if (category === "not_retained") return "not_retained";
  if (category === "review_required") return "awaiting_review";
  return "held";
}

