import type { AttemptRecord } from "../attempts/log.ts";
import { readDispatcherHeartbeat } from "../runtime/heartbeat.ts";
import type { RuntimeRecord } from "../runtime/records.ts";
import type { Lease } from "../workspaces/provider.ts";
import { isOpen, leaseReturned, possibleLeasePool, resolvedBy, summarise } from "./attempt.ts";
import type { Dependencies } from "./dependencies.ts";
import type { AttemptSummary } from "./result.ts";
import type { TaskView } from "./state.ts";

export type Observation<T> = { known: true; value: T } | { known: false; reason: string; error?: unknown };
export type AttemptSelector = { leaseId: string } | { taskId: string; attempt?: number };
export type AttemptObservation = {
  attempt: AttemptSummary;
  record: Observation<AttemptRecord | undefined>;
  runtime: Observation<RuntimeRecord | undefined>;
  leases: Observation<Lease[]>;
  pool: Observation<string>;
  task: Observation<TaskView>;
  heartbeat: Observation<boolean>;
  latest: boolean;
  taskWorkerMayBeRunning: boolean;
};
export type ContextObservation = {
  attempts: AttemptObservation[];
  records: Observation<AttemptRecord[]>;
  runtime: Observation<RuntimeRecord[]>;
  leases: Observation<Lease[]>;
  pool: Observation<string>;
};

async function read<T>(owner: string, load: () => Promise<T> | T): Promise<Observation<T>> {
  try { return { known: true, value: await load() }; }
  catch (error) {
    return Object.defineProperty({ known: false as const, reason: `${owner} could not be read: ${error instanceof Error ? error.message : String(error)}` }, "error", { value: error });
  }
}

async function observe(deps: Dependencies, selector?: AttemptSelector): Promise<ContextObservation> {
  let latestNumber: number | undefined;
  const records = await read("The attempt log", async () => {
    if (!selector) return deps.attempts.list();
    if ("leaseId" in selector) {
      const record = await deps.attempts.findByLease(selector.leaseId);
      if (record) latestNumber = deps.attempts.latestNumber(record.taskId);
      return record ? [record] : [];
    }
    latestNumber = deps.attempts.latestNumber(selector.taskId);
    const record = deps.attempts.findForTask(selector.taskId, selector.attempt ?? latestNumber);
    return record ? [record] : [];
  });
  const runtime = await read("Runtime records", () => deps.runtime.discover(deps.contextId, selector));
  const leases = await read("Workspace leases", () => deps.workspaces.leases());
  const pool = await read("The workspace pool", () => deps.workspaces.pool());
  const attempts: AttemptObservation[] = [];
  const tasks = new Map<string, Observation<TaskView>>();
  const summaries = records.known ? records.value.map(summarise) : [];
  if (runtime.known) for (const record of runtime.value) {
    const { contextId, taskId, leaseId, sessionId } = record.binding.input.identity;
    if (!summaries.some(a => a.leaseId === leaseId)) summaries.push({ contextId, taskId, leaseId, sessionId, attempt: 0 });
  }
  if (!summaries.length && selector && (!records.known || !runtime.known)) {
    summaries.push({ contextId: deps.contextId, taskId: "taskId" in selector ? selector.taskId : "unknown", attempt: "attempt" in selector ? selector.attempt ?? 0 : 0,
      ...("leaseId" in selector ? { leaseId: selector.leaseId } : {}) });
  }
  for (const summary of summaries) {
    const record = records.known ? records.value.find(a => a.taskId === summary.taskId && a.attempt === summary.attempt) : undefined;
    const worker = runtime.known ? runtime.value.find(r => r.binding.input.identity.leaseId === summary.leaseId) : undefined;
    // Confirmations are scoped to this lease and session, not a general statement that workers have stopped.
    if (worker?.child.status === "unknown" && record) {
      const confirmed = (record.confirmations ?? []).find(c => c.fact === "worker_stopped" && c.scope.leaseId === summary.leaseId &&
        (c.scope.sessionId === undefined || c.scope.sessionId === worker.binding.input.identity.sessionId));
      if (confirmed) worker.child = { status: "operator_confirmed_stopped", confirmedAt: confirmed.confirmedAt };
    }
    if (!tasks.has(summary.taskId)) tasks.set(summary.taskId, await read("The attempt's task", async () => {
      const task = await deps.tasks.read(summary.taskId);
      return task ? { state: task.state, held: task.held, holdReason: task.holdReason } : "missing";
    }));
    const heartbeat = await read("The dispatcher heartbeat", () => worker ? readDispatcherHeartbeat(worker) : false);
    attempts.push({ attempt: summary, record: records.known ? { known: true, value: record } : records,
      runtime: runtime.known ? { known: true, value: worker } : runtime, leases, pool, task: tasks.get(summary.taskId)!, heartbeat,
      latest: selector ? latestNumber === summary.attempt :
        !records.known || !records.value.some(a => a.taskId === summary.taskId && a.attempt > summary.attempt),
      taskWorkerMayBeRunning: !runtime.known || runtime.value.some(r => r.binding.input.identity.taskId === summary.taskId && r.child.status === "unknown") });
  }
  return { attempts, records, runtime, leases, pool };
}

/** Reads only the selected attempt and runtime, plus the provider's current pool and lease listing. No reporting I/O. */
export async function observeAttempt(deps: Dependencies, selector: AttemptSelector): Promise<AttemptObservation | undefined> {
  const context = await observe(deps, selector);
  return context.attempts.find(a => "leaseId" in selector ? a.attempt.leaseId === selector.leaseId :
    a.attempt.taskId === selector.taskId && (selector.attempt === undefined || a.attempt.attempt === selector.attempt));
}

/** Reads each shared owner once, and each task and heartbeat once, for a context-wide assessment. */
export async function observeAttempts(deps: Dependencies): Promise<ContextObservation> { return observe(deps); }

export function workerMayBeRunning(observation: AttemptObservation): boolean {
  if (!observation.runtime.known || !observation.record.known) return true;
  const runtime = observation.runtime.value;
  if (runtime) return runtime.child.status === "unknown";
  const record = observation.record.value;
  return record !== undefined && record.entries.some(e => e.kind === "launched") &&
    !record.entries.some(e => e.kind === "worker_finished") && !resolvedBy(record, "worker_stopped");
}

export function otherPool(observation: AttemptObservation): string | undefined {
  if (!observation.record.known || !observation.record.value || !observation.pool.known) return undefined;
  const record = observation.record.value;
  const pool = possibleLeasePool(record);
  return pool !== undefined && pool !== observation.pool.value && !leaseReturned(record) ? pool : undefined;
}

export function unfinished(observation: AttemptObservation): boolean {
  return observation.latest && observation.record.known && observation.record.value !== undefined && isOpen(observation.record.value);
}
