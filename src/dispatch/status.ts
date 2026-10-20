import { readActivity } from "../runtime/activity.ts";
import { dispatcherRunning } from "../runtime/heartbeat.ts";
import type { RuntimeRecord } from "../runtime/records.ts";
import type { Lease } from "../workspaces/provider.ts";
import type { Task } from "../tasks/store.ts";
import { inspect, isOpen, summarise, type Dependencies } from "./dispatch.ts";
import { classify, type AttemptState } from "./state.ts";
import { summariseActivity, transcriptPath, type ActivitySummary } from "./watch.ts";
import { nextActions, type AttemptSummary, type NextAction } from "./result.ts";

export type AttemptStatus = {
  attempt: AttemptSummary;
  /** The attempt's state across every owner (Phase 2 PRD, attempt states). */
  state: AttemptState;
  /** Whether a command may change this attempt: false while its worker may be running or any owner state is unknown. */
  changeable: boolean;
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
  /** How to continue the work by hand. Offered only once the worker is known to have stopped. */
  takeover?: string;
  nextAction: { code: NextAction; description: string };
};

const defaultStaleMs = 20 * 60 * 1000;

/** Quotes a path for the operator's shell: POSIX shells on macOS and Linux, PowerShell on Windows. */
function quote(path: string): string {
  return process.platform === "win32" ? `"${path.replace(/["`$]/g, "`$&")}"` : `'${path.replace(/'/g, "'\\''")}'`;
}

async function workerView(record: RuntimeRecord | undefined, possiblyRunning: boolean, staleMs: number, leases: Lease[]): Promise<Pick<AttemptStatus, "activity" | "transcript" | "takeover" | "thinkingLevel">> {
  if (!record) return {};
  const activity = summariseActivity(await readActivity(record.directory));
  const stale = possiblyRunning && (activity.lastActivity === null || Date.now() - Date.parse(activity.lastActivity) > staleMs);
  const transcript = await transcriptPath(record);
  const { sessionId } = record.binding.input.identity;
  return {
    activity: { ...activity, stale },
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
  /** Tasks in flight with no attempt in the log, no runtime record and no lease, so nothing accounts for them. */
  orphanedInFlight: string[];
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
      version: 1, ok: false, reason: "refused", ready: [], inFlight: [], unaccountedLeases: [], orphanedInFlight: [], attempts: [],
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
    const otherPool = state.leasesInOtherPools.find(a => a.taskId === summary.taskId && a.attempt === summary.attempt)?.pool;
    const runtime = state.runtime.find(r => r.binding.input.identity.leaseId === summary.leaseId);
    const running = possiblyRunning && runtime !== undefined && await dispatcherRunning(runtime.directory);
    const unfinished = isOpen(record) && state.openTasks.includes(summary.taskId);
    const classified = classify({ record, possiblyRunning, dispatcherRunning: running, leaseHeld, leaseInOtherPool: otherPool !== undefined, unfinished, task });
    attempts.push({
      attempt: summary, state: classified.state, changeable: classified.changeable, lastEntry: record.entries.at(-1)!.kind, possiblyRunning, leaseHeld, ...(otherPool === undefined ? {} : { leaseInOtherPool: otherPool }), task,
      ...await workerView(runtime, possiblyRunning, deps.staleMs ?? defaultStaleMs, state.leases), nextAction: action(classified.nextAction),
    });
  }
  // Runtime records with no matching attempt, for example after a crash before the attempt was logged.
  for (const p of state.possiblyRunning.filter(p => p.attempt === 0)) {
    const runtime = state.runtime.find(r => r.binding.input.identity.leaseId === p.leaseId);
    const leaseHeld = state.leases.some(l => l.leaseId === p.leaseId);
    const classified = classify({
      record: undefined, possiblyRunning: true, dispatcherRunning: runtime !== undefined && await dispatcherRunning(runtime.directory),
      leaseHeld, leaseInOtherPool: false, unfinished: false, task: "unreadable",
    });
    attempts.push({
      attempt: p, state: classified.state, changeable: classified.changeable, lastEntry: "none", possiblyRunning: true, leaseHeld, task: "unreadable",
      ...await workerView(runtime, true, deps.staleMs ?? defaultStaleMs, state.leases), nextAction: action(classified.nextAction),
    });
  }
  const known = new Set(attempts.map(a => a.attempt.leaseId).filter(Boolean));
  const unaccountedLeases = state.leases.filter(l => !known.has(l.leaseId)).map(({ leaseId, holder, path }) => ({ leaseId, holder, path }));
  const orphanedInFlight = state.inFlight.filter(id => !state.attempts.some(a => a.taskId === id) &&
    !state.runtime.some(r => r.binding.input.identity.taskId === id) && !state.leases.some(l => l.holder === id));
  const unaccounted = unaccountedLeases.length > 0 || orphanedInFlight.length > 0;
  const attention = attempts.some(a => a.nextAction.code !== "none" && a.nextAction.code !== "watch_attempt") || unaccounted;
  return {
    version: 1, ok: !attention, reason: attention ? "attention" : "clear", ready: state.ready, inFlight: state.inFlight, unaccountedLeases, orphanedInFlight, attempts,
    nextAction: action(overall(attempts, unaccounted)),
  };
}

/** Prioritise stop confirmation when no dispatcher heartbeat is fresh; otherwise use the shared next action. */
function overall(attempts: AttemptStatus[], unaccounted: boolean): NextAction {
  if (attempts.some(a => a.nextAction.code === "stop_worker")) return "stop_worker";
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
    const lease = a.leaseInOtherPool !== undefined ? `lease ${a.attempt.leaseId ?? "with unknown ID"} at ${where} UNKNOWN: its workspace pool is no longer listed`
      : !a.attempt.leaseId ? "no lease"
      : a.leaseHeld ? `lease ${a.attempt.leaseId} held at ${where}`
      : `lease ${a.attempt.leaseId} not held`;
    lines.push(`- ${a.attempt.taskId} attempt ${a.attempt.attempt}: ${a.state.replaceAll("_", " ")}; last ${a.lastEntry}; task ${task}; ${lease}${a.possiblyRunning ? (a.nextAction.code === "watch_attempt" ? "; WORKER RUNNING" : "; WORKER MAY BE RUNNING") : ""}`);
    const thinking = `thinking ${a.thinkingLevel ?? "unknown"}`;
    if (a.activity?.lastActivity) {
      const usage = a.activity.tokens === null ? "" : `; ${a.activity.tokens} tokens, $${(a.activity.cost ?? 0).toFixed(2)}`;
      lines.push(`  Last activity ${a.activity.lastActivity}${a.activity.currentTool ? `, running ${a.activity.currentTool}` : ""}${usage}; ${thinking}${a.activity.stale ? "; NO RECENT ACTIVITY" : ""}`);
    } else lines.push(`  No activity recorded; ${thinking}${a.activity?.stale ? "; NO RECENT ACTIVITY" : ""}`);
    if (a.transcript) lines.push(`  Transcript: ${a.transcript}`);
    if (a.takeover) lines.push(`  Take over by hand: ${a.takeover}`);
    if (a.nextAction.code !== "none") lines.push(`  Next: ${a.nextAction.description}`);
  }
  for (const l of value.unaccountedLeases) lines.push(`- Lease ${l.leaseId} for ${l.holder} at ${l.path} is not in the attempt log`);
  for (const id of value.orphanedInFlight) lines.push(`- Task ${id} is in flight, but no attempt, worker or lease accounts for it`);
  lines.push(`Next: ${value.nextAction.description}`);
  return lines.join("\n");
}
