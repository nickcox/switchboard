import type { Task } from "../tasks/store.ts";
import { inspect, summarise, type Dependencies } from "./dispatch.ts";
import { nextActions, type AttemptSummary, type NextAction } from "./result.ts";

export type AttemptStatus = {
  attempt: AttemptSummary;
  lastEntry: string;
  possiblyRunning: boolean;
  leaseHeld: boolean;
  task: { state: string; held: boolean; holdReason: string | null } | "missing" | "unreadable";
  nextAction: { code: NextAction; description: string };
};

export type StatusResult = {
  ok: boolean;
  /** `clear` when nothing needs the operator; `attention` when an attempt does; otherwise why state is unknown. */
  reason: "clear" | "attention" | "store_unreadable" | "workspace_unreadable" | "runtime_unreadable" | "attempt_log_unreadable";
  ready: string[];
  inFlight: string[];
  /** Leases in this context's pool that no attempt in the log accounts for. */
  unaccountedLeases: { leaseId: string; holder: string; path: string }[];
  attempts: AttemptStatus[];
  detail?: string;
  nextAction: { code: NextAction; description: string };
};

const action = (code: NextAction) => ({ code, description: nextActions[code] });

/** Read-only view of every attempt and the owner state that decides what happens next. Changes nothing. */
export async function status(deps: Dependencies): Promise<StatusResult> {
  const state = await inspect(deps);
  if ("failed" in state) {
    return {
      ok: false, reason: state.failed.reason as StatusResult["reason"], ready: [], inFlight: [], unaccountedLeases: [], attempts: [],
      ...(state.failed.detail ? { detail: state.failed.detail } : {}), nextAction: action("fix_configuration"),
    };
  }
  const attempts: AttemptStatus[] = [];
  for (const record of state.attempts) {
    const summary = summarise(record);
    const possiblyRunning = state.possiblyRunning.some(p => p.taskId === summary.taskId && (p.attempt === summary.attempt || p.leaseId === summary.leaseId));
    const leaseHeld = summary.leaseId !== undefined && state.leases.some(l => l.leaseId === summary.leaseId);
    let task: AttemptStatus["task"];
    try {
      const read: Task | undefined = await deps.tasks.read(summary.taskId);
      task = read ? { state: read.state, held: read.held, holdReason: read.holdReason } : "missing";
    } catch { task = "unreadable"; }
    const reviewHold = typeof task === "object" && task.held && (task.holdReason ?? "").endsWith("review required");
    const code: NextAction = possiblyRunning ? "stop_worker"
      : !leaseHeld ? (typeof task === "object" && task.state === "in_flight" ? "inspect_attempt" : "none")
      : reviewHold ? "review_branch" : "inspect_attempt";
    attempts.push({ attempt: summary, lastEntry: record.entries.at(-1)!.kind, possiblyRunning, leaseHeld, task, nextAction: action(code) });
  }
  // Runtime records with no matching attempt, for example after a crash before the attempt was logged.
  for (const p of state.possiblyRunning.filter(p => p.attempt === 0)) {
    attempts.push({ attempt: p, lastEntry: "none", possiblyRunning: true, leaseHeld: state.leases.some(l => l.leaseId === p.leaseId), task: "unreadable", nextAction: action("stop_worker") });
  }
  const known = new Set(attempts.map(a => a.attempt.leaseId).filter(Boolean));
  const unaccountedLeases = state.leases.filter(l => !known.has(l.leaseId)).map(({ leaseId, holder, path }) => ({ leaseId, holder, path }));
  const attention = attempts.some(a => a.nextAction.code !== "none") || unaccountedLeases.length > 0;
  return {
    ok: !attention, reason: attention ? "attention" : "clear", ready: state.ready, inFlight: state.inFlight, unaccountedLeases, attempts,
    nextAction: action(overall(attempts, unaccountedLeases.length > 0)),
  };
}

/** Stop a possibly running worker first; otherwise repeat the attempts' shared next action, or ask for inspection. */
function overall(attempts: AttemptStatus[], unaccounted: boolean): NextAction {
  if (attempts.some(a => a.possiblyRunning)) return "stop_worker";
  const pending = new Set(attempts.map(a => a.nextAction.code).filter(code => code !== "none"));
  if (pending.size === 0 && !unaccounted) return "dispatch_again";
  return pending.size === 1 && !unaccounted ? [...pending][0]! : "inspect_attempt";
}

export function describeStatus(value: StatusResult): string {
  const lines = [`${value.reason === "clear" ? "Clear" : value.reason === "attention" ? "Needs attention" : `Unknown: ${value.reason}`}`];
  if (value.detail) lines.push(`Detail: ${value.detail}`);
  lines.push(`Ready: ${value.ready.join(", ") || "none"}`, `In flight: ${value.inFlight.join(", ") || "none"}`);
  for (const a of value.attempts) {
    const task = typeof a.task === "string" ? a.task : `${a.task.state}${a.task.held ? `, held: ${a.task.holdReason}` : ""}`;
    const lease = a.attempt.leaseId ? `lease ${a.attempt.leaseId} ${a.leaseHeld ? `held at ${a.attempt.workspace ?? "an unknown path"}` : "not held"}` : "no lease";
    lines.push(`- ${a.attempt.taskId} attempt ${a.attempt.attempt}: last ${a.lastEntry}; task ${task}; ${lease}${a.possiblyRunning ? "; WORKER MAY BE RUNNING" : ""}`);
    if (a.nextAction.code !== "none") lines.push(`  Next: ${a.nextAction.description}`);
  }
  for (const l of value.unaccountedLeases) lines.push(`- Lease ${l.leaseId} for ${l.holder} at ${l.path} is not in the attempt log`);
  lines.push(`Next: ${value.nextAction.description}`);
  return lines.join("\n");
}
