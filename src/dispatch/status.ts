import { readActivity } from "../runtime/activity.ts";
import type { RuntimeRecord } from "../runtime/records.ts";
import type { Task } from "../tasks/store.ts";
import { inspect, summarise, type Dependencies } from "./dispatch.ts";
import { summariseActivity, transcriptPath, type ActivitySummary } from "./watch.ts";
import { nextActions, type AttemptSummary, type NextAction } from "./result.ts";

export type AttemptStatus = {
  attempt: AttemptSummary;
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
  /** How to continue the work by hand. Offered only once the worker is known to have stopped. */
  takeover?: string;
  nextAction: { code: NextAction; description: string };
};

const defaultStaleMs = 20 * 60 * 1000;

async function workerView(record: RuntimeRecord | undefined, possiblyRunning: boolean, staleMs: number): Promise<Pick<AttemptStatus, "activity" | "transcript" | "takeover">> {
  if (!record) return {};
  const activity = summariseActivity(await readActivity(record.directory));
  const stale = possiblyRunning && (activity.lastActivity === null || Date.now() - Date.parse(activity.lastActivity) > staleMs);
  const transcript = await transcriptPath(record);
  const { sessionId } = record.binding.input.identity;
  return {
    activity: { ...activity, stale },
    ...(transcript ? { transcript } : {}),
    ...(possiblyRunning ? {} : { takeover: `In ${record.binding.input.workspace}, run: pi --session-id ${sessionId} --session-dir ${record.binding.sessionDirectory}` }),
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
      version: 1, ok: false, reason: "refused", ready: [], inFlight: [], unaccountedLeases: [], attempts: [],
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
    const otherPool = state.leasesInOtherPools.find(a => a.taskId === summary.taskId && a.attempt === summary.attempt)?.pool;
    const code: NextAction = possiblyRunning ? "stop_worker"
      : otherPool !== undefined ? "confirm_lease_returned"
      : !leaseHeld ? (typeof task === "object" && task.state === "in_flight" ? "inspect_attempt" : "none")
      : reviewHold ? "review_branch"
      : typeof task === "object" && task.state === "done" ? "return_lease" : "inspect_attempt";
    const runtime = state.runtime.find(r => r.binding.input.identity.leaseId === summary.leaseId);
    attempts.push({
      attempt: summary, lastEntry: record.entries.at(-1)!.kind, possiblyRunning, leaseHeld, ...(otherPool === undefined ? {} : { leaseInOtherPool: otherPool }), task,
      ...await workerView(runtime, possiblyRunning, deps.staleMs ?? defaultStaleMs), nextAction: action(code),
    });
  }
  // Runtime records with no matching attempt, for example after a crash before the attempt was logged.
  for (const p of state.possiblyRunning.filter(p => p.attempt === 0)) {
    const runtime = state.runtime.find(r => r.binding.input.identity.leaseId === p.leaseId);
    attempts.push({
      attempt: p, lastEntry: "none", possiblyRunning: true, leaseHeld: state.leases.some(l => l.leaseId === p.leaseId), task: "unreadable",
      ...await workerView(runtime, true, deps.staleMs ?? defaultStaleMs), nextAction: action("stop_worker"),
    });
  }
  const known = new Set(attempts.map(a => a.attempt.leaseId).filter(Boolean));
  const unaccountedLeases = state.leases.filter(l => !known.has(l.leaseId)).map(({ leaseId, holder, path }) => ({ leaseId, holder, path }));
  const attention = attempts.some(a => a.nextAction.code !== "none") || unaccountedLeases.length > 0;
  return {
    version: 1, ok: !attention, reason: attention ? "attention" : "clear", ready: state.ready, inFlight: state.inFlight, unaccountedLeases, attempts,
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
  const lines = [`${value.reason === "clear" ? "Clear" : value.reason === "attention" ? "Needs attention" : "Unknown: owner state could not be read"}`];
  if (value.detail) lines.push(`Detail: ${value.detail}`);
  lines.push(`Ready: ${value.ready.join(", ") || "none"}`, `In flight: ${value.inFlight.join(", ") || "none"}`);
  for (const a of value.attempts) {
    const task = typeof a.task === "string" ? a.task : `${a.task.state}${a.task.held ? `, held: ${a.task.holdReason}` : ""}`;
    const where = a.attempt.workspace ?? "an unknown path";
    const lease = !a.attempt.leaseId ? "no lease"
      : a.leaseHeld ? `lease ${a.attempt.leaseId} held at ${where}`
      : a.leaseInOtherPool !== undefined ? `lease ${a.attempt.leaseId} at ${where} UNKNOWN: its workspace pool is no longer listed`
      : `lease ${a.attempt.leaseId} not held`;
    lines.push(`- ${a.attempt.taskId} attempt ${a.attempt.attempt}: last ${a.lastEntry}; task ${task}; ${lease}${a.possiblyRunning ? "; WORKER MAY BE RUNNING" : ""}`);
    if (a.activity?.lastActivity) {
      const usage = a.activity.tokens === null ? "" : `; ${a.activity.tokens} tokens, $${(a.activity.cost ?? 0).toFixed(2)}`;
      lines.push(`  Last activity ${a.activity.lastActivity}${a.activity.currentTool ? `, running ${a.activity.currentTool}` : ""}${usage}${a.activity.stale ? "; NO RECENT ACTIVITY" : ""}`);
    } else if (a.activity?.stale) lines.push("  No activity recorded; NO RECENT ACTIVITY");
    if (a.transcript) lines.push(`  Transcript: ${a.transcript}`);
    if (a.takeover) lines.push(`  Take over by hand: ${a.takeover}`);
    if (a.nextAction.code !== "none") lines.push(`  Next: ${a.nextAction.description}`);
  }
  for (const l of value.unaccountedLeases) lines.push(`- Lease ${l.leaseId} for ${l.holder} at ${l.path} is not in the attempt log`);
  lines.push(`Next: ${value.nextAction.description}`);
  return lines.join("\n");
}
