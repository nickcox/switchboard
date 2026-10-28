import type { Database } from "../database.ts";
import type { AttemptRef } from "../attempts/log.ts";

export type AttemptSpending = AttemptRef & {
  cost: number | null;
  workerTimeMs: number | null;
  finished: boolean;
};
export type ObjectiveSpending = {
  /** Known subtotals remain useful when the total is unknown. */
  observedCost: number;
  observedWorkerTimeMs: number;
  cost: number | null;
  workerTimeMs: number | null;
  unknown: (AttemptSpending & { confirmed: boolean })[];
};
export type ObjectiveBudget = {
  budget: { maxCost: number | null; maxWorkerTimeMs: number | null };
  deadline: string | null;
  timeLeftMs: number | null;
  spending: ObjectiveSpending;
};
export type BudgetRefusal = {
  reason: "objective_cost_limit" | "objective_worker_time_limit" | "objective_deadline" | "objective_usage_unknown";
  detail: string;
};

/** No launch means no worker spending. A fence or an unobserved exit must not invent usage. */
export function attemptSpending(database: Database, ref: AttemptRef, now = Date.now()): AttemptSpending {
  const row = database.get("SELECT closed FROM attempts WHERE context = ? AND task = ? AND number = ?", ref.contextId, ref.taskId, ref.attempt);
  if (!row) {
    const archive = database.get("SELECT summary FROM archived_attempts WHERE context = ? AND task = ? AND attempt = ?", ref.contextId, ref.taskId, ref.attempt);
    const saved = archive && JSON.parse(String(archive.summary));
    return { ...ref, cost: null, workerTimeMs: null, ...saved?.spending, finished: true };
  }
  const launch = database.get("SELECT * FROM launches WHERE context = ? AND task = ? AND attempt = ?", ref.contextId, ref.taskId, ref.attempt);
  if (!launch) {
    const evidence = database.get(`SELECT 1 FROM attempt_entries WHERE context = ? AND task = ? AND attempt = ?
      AND (json_extract(entry, '$.kind') = 'launched' OR (json_extract(entry, '$.kind') = 'worker_finished'
        AND json_extract(entry, '$.data.status') <> 'not_started'))`, ref.contextId, ref.taskId, ref.attempt);
    return { ...ref, cost: evidence ? null : 0, workerTimeMs: evidence ? null : 0, finished: Boolean(row.closed) };
  }
  const directory = String(launch.directory);
  const exit = database.get("SELECT value,recorded_at FROM worker_observations WHERE directory = ? AND kind = 'exit'", directory);
  if (exit && JSON.parse(String(exit.value)).started === false) return { ...ref, cost: 0, workerTimeMs: 0, finished: true };
  const stopped = database.get("SELECT 1 FROM confirmations WHERE context = ? AND task = ? AND attempt = ? AND fact = 'worker_stopped'", ref.contextId, ref.taskId, ref.attempt);
  const finished = Boolean(exit || stopped || row.closed);
  const usage = database.get("SELECT cost FROM worker_usage WHERE directory = ?", directory);
  // Older runtimes recorded usage only in their bounded diagnostic activity log.
  const stats = usage ? undefined : database.get("SELECT entry FROM worker_activity WHERE directory = ? AND json_extract(entry, '$.kind') = 'stats' ORDER BY sequence DESC LIMIT 1", directory);
  const cost = usage ? Number(usage.cost) : stats ? JSON.parse(String(stats.entry)).cost : null;
  const elapsed = launch.kind === "fence" || (!exit && finished) ? null : Math.max(0, (exit ? Date.parse(String(exit.recorded_at)) : now) - Date.parse(String(launch.created_at)));
  return { ...ref, cost: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null, workerTimeMs: elapsed !== null && Number.isFinite(elapsed) ? elapsed : null, finished };
}

export function unknownKey(value: AttemptSpending): string {
  return JSON.stringify([value.contextId, value.taskId, value.attempt, value.cost === null, value.workerTimeMs === null]);
}

export function objectiveBudget(database: Database, id: string, now = Date.now()): ObjectiveBudget {
  const objective = database.get("SELECT budget,deadline FROM objectives WHERE id = ?", id);
  if (!objective) throw new Error(`Objective ${id} does not exist`);
  const confirmed = new Set<string>();
  for (const row of database.all("SELECT changes FROM objective_changes WHERE objective = ? AND action = 'confirm-budget' ORDER BY sequence", id)) {
    for (const key of JSON.parse(String(row.changes)).unknownAttempts) confirmed.add(key);
  }
  const attempts = database.all(`SELECT n.* FROM attempt_numbers n JOIN tasks t ON t.id = n.task
    WHERE t.objective_id = ? ORDER BY n.context,n.task,n.number`, id).map(row => attemptSpending(database, {
    contextId: String(row.context), taskId: String(row.task), attempt: Number(row.number),
  }, now));
  const unknown = attempts.filter(a => a.cost === null || a.workerTimeMs === null).map(a => ({ ...a, confirmed: confirmed.has(unknownKey(a)) }));
  const observedCost = attempts.reduce((sum, a) => sum + (a.cost ?? 0), 0);
  const observedWorkerTimeMs = attempts.reduce((sum, a) => sum + (a.workerTimeMs ?? 0), 0);
  const deadline = objective.deadline as string | null;
  return {
    budget: JSON.parse(String(objective.budget)), deadline, timeLeftMs: deadline === null ? null : Math.max(0, Date.parse(deadline) - now),
    spending: { observedCost, observedWorkerTimeMs, cost: unknown.some(a => a.cost === null) ? null : observedCost,
      workerTimeMs: unknown.some(a => a.workerTimeMs === null) ? null : observedWorkerTimeMs, unknown },
  };
}

/** Reservations refuse at the limit; running workers stop only once they go over it. */
export function checkObjectiveBudget(id: string, value: ObjectiveBudget, running = false): BudgetRefusal | undefined {
  const { budget, spending } = value;
  const reached = (spent: number, limit: number | null) => limit !== null && (running ? spent > limit : spent >= limit);
  if (value.timeLeftMs === 0) return { reason: "objective_deadline", detail: `Objective ${id}'s deadline has passed; ask its creator to extend or clear the deadline` };
  if (reached(spending.observedCost, budget.maxCost)) return { reason: "objective_cost_limit", detail: `Objective ${id} has reached its cost budget (${spending.observedCost} / ${budget.maxCost}); ask its creator to raise the budget` };
  if (reached(spending.observedWorkerTimeMs, budget.maxWorkerTimeMs)) return { reason: "objective_worker_time_limit", detail: `Objective ${id} has reached its worker-time budget (${spending.observedWorkerTimeMs}ms / ${budget.maxWorkerTimeMs}ms); ask its creator to raise the budget` };
  if (!running && spending.unknown.some(a => a.finished && !a.confirmed)) return { reason: "objective_usage_unknown", detail: `Objective ${id} has unknown usage for a finished attempt; ask its creator to inspect objective show, then confirm-budget with a note or raise the budget` };
  return undefined;
}

export function describeObjectiveBudget(value: ObjectiveBudget): string {
  const { budget, spending } = value;
  const unknown = spending.unknown.map(a => `${a.contextId}/${a.taskId}/${a.attempt} (${[a.cost === null ? "cost" : "", a.workerTimeMs === null ? "worker time" : ""].filter(Boolean).join(", ")}${a.confirmed ? "; confirmed" : ""})`).join("; ");
  return `budget: cost ${budget.maxCost ?? "unlimited"}, worker time ${budget.maxWorkerTimeMs === null ? "unlimited" : `${budget.maxWorkerTimeMs}ms`}; spending: cost ${spending.cost ?? `unknown (observed ${spending.observedCost})`}, worker time ${spending.workerTimeMs ?? `unknown (observed ${spending.observedWorkerTimeMs})`}ms; unknown usage: ${unknown || "none"}; deadline: ${value.deadline ?? "none"}${value.timeLeftMs === null ? "" : ` (${value.timeLeftMs}ms left)`}`;
}
