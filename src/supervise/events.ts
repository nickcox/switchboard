import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { callerName, callerSchema, type Caller } from "../caller.ts";
import { requireAuthority } from "../dispatch/safety.ts";
import type { AttemptEntry, AttemptRef } from "../attempts/log.ts";
import type { Database } from "../database.ts";
import { objectiveBudget } from "../objectives/budget.ts";
import { interventionEntry, personInterventions } from "../objectives/interventions.ts";
import { TaskStoreError } from "../tasks/store.ts";

export type SupervisorEvent = {
  id: string; objectiveId: string; sequence: number; kind: string; at: string;
  contextId: string | null; taskId: string | null; attempt: number | null; details: unknown;
};

/** Call inside the transaction that records the fact. Source keys make replays harmless. */
export function recordEvent(database: Database, objectiveId: string | null, source: string, kind: string, at: string,
  details: unknown, ref?: Partial<AttemptRef>): void {
  if (objectiveId === null) return;
  if (database.get("SELECT 1 FROM supervisor_events WHERE objective = ? AND source = ?", objectiveId, source)) return;
  database.run(`INSERT INTO supervisor_events VALUES(?,?,(SELECT coalesce(max(sequence),0)+1 FROM supervisor_events WHERE objective = ?),?,?,?,?,?,?,?)`,
    randomUUID(), objectiveId, objectiveId, source, kind, at, ref?.contextId ?? null, ref?.taskId ?? null, ref?.attempt ?? null, JSON.stringify(details));
}

export function taskObjective(database: Database, taskId: string): string | null {
  const row = database.get("SELECT objective_id FROM tasks WHERE id = ?", taskId);
  return row?.objective_id == null ? null : String(row.objective_id);
}

/** Use the same decision and duplicate rules as the briefing, while the source write is still uncommitted. */
export function recordPersonEvents(database: Database, objectiveIds: (string | null | undefined)[], id: string): void {
  for (const objectiveId of new Set(objectiveIds)) {
    if (!objectiveId) continue;
    const interventions = personInterventions(database, objectiveId);
    const item = [...interventions.items, ...interventions.leaseReturns.items].find(item => item.id === id);
    if (item) recordEvent(database, objectiveId, `person:${id}`, "person_intervention", item.at, item, item);
  }
}

export function recordEntryEvents(database: Database, entry: AttemptEntry): void {
  const objectiveId = taskObjective(database, entry.taskId);
  const key = JSON.stringify([entry.contextId, entry.taskId, entry.attempt]);
  const source = `entry:${key}:${entry.sequence}`;
  const kind = entry.kind === "worker_finished" ? "worker_finished"
    : entry.kind === "review_recorded" ? "review_recorded"
    : entry.kind === "task_recorded" && entry.data.outcome === "hold" ? "attempt_held"
    : entry.kind === "halted" || entry.kind === "owner_read_failed" || entry.kind === "check_finished" && entry.data.status !== "passed" ? "decision_needed" : null;
  if (kind) recordEvent(database, objectiveId, source, kind, entry.recordedAt, entry.data, entry);
  const actor = entry.kind === "operator_request" ? entry.data.sender : entry.askedBy;
  if (!interventionEntry(entry) || typeof actor !== "string" || !actor || actor.startsWith("supervisor:")) return;
  const specification = database.get("SELECT specification FROM attempt_specifications WHERE context = ? AND task = ? AND attempt = ?", entry.contextId, entry.taskId, entry.attempt);
  const captured = specification ? JSON.parse(String(specification.specification)).objectiveId : null;
  recordPersonEvents(database, [objectiveId, captured], entry.kind === "operator_request" ? `request:${entry.data.id}` : source);
}

/** Record limits reached by a budget, usage or task-membership write in that same transaction. */
export function recordBudgetEvents(database: Database, objectiveId: string, now = Date.now()): void {
  const value = objectiveBudget(database, objectiveId, now);
  const at = new Date(now).toISOString();
  for (const [name, limit, spent] of [
    ["cost", value.budget.maxCost, value.spending.observedCost],
    ["worker_time", value.budget.maxWorkerTimeMs, value.spending.observedWorkerTimeMs],
  ] as const) {
    if (limit !== null && spent >= limit) recordEvent(database, objectiveId, `budget:${name}:${limit}`, "budget_reached", at, { budget: name, limit, spent });
  }
}

/** Time passing has no source write; wait and dispatcher checks record the first observation. */
export function observeBudgetEvents(database: Database, objectiveId: string, now = Date.now()): void {
  recordBudgetEvents(database, objectiveId, now);
  const row = database.get("SELECT deadline FROM objectives WHERE id = ?", objectiveId)!;
  if (row.deadline !== null && Date.parse(String(row.deadline)) <= now) {
    recordEvent(database, objectiveId, `deadline:${row.deadline}`, "deadline_reached", new Date(now).toISOString(), { deadline: row.deadline });
  }
}

function event(row: NonNullable<ReturnType<Database["get"]>>): SupervisorEvent {
  return { id: String(row.id), objectiveId: String(row.objective), sequence: Number(row.sequence), kind: String(row.kind), at: String(row.at),
    contextId: row.context as string | null, taskId: row.task as string | null, attempt: row.attempt === null ? null : Number(row.attempt), details: JSON.parse(String(row.details)) };
}

export function pendingEvents(database: Database, objectiveId: string): { count: number; first: SupervisorEvent | null } {
  const first = database.get(`SELECT e.*, count(*) OVER() AS unhandled_count FROM supervisor_events e
    WHERE e.objective = ? AND e.sequence > coalesce((SELECT sequence FROM supervisor_positions WHERE objective = ?), 0)
    ORDER BY e.sequence LIMIT 1`, objectiveId, objectiveId);
  return { count: first ? Number(first.unhandled_count) : 0, first: first ? event(first) : null };
}

function requireSupervisor(database: Database, caller: Caller, objectiveId: string): void {
  if (caller.kind !== "supervisor" || caller.objectiveId !== objectiveId) throw new TaskStoreError("rejected", "Only the objective's supervisor can wait for or handle its events");
  requireAuthority(database, caller, "recordAttempt", { objectiveId });
  if (database.get("SELECT state FROM objectives WHERE id = ?", objectiveId)?.state !== "open") {
    throw new TaskStoreError("rejected", `Objective ${objectiveId} must be open before supervising its events`);
  }
}

export async function waitForEvent(database: Database, caller: Caller, objectiveId: string, timeoutSeconds?: number): Promise<{ ok: true; action: "wait"; event: SupervisorEvent | null; timedOut: boolean }> {
  caller = callerSchema.parse(caller);
  if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0)) throw new Error("Timeout must be a nonnegative number of seconds");
  const until = timeoutSeconds === undefined ? Infinity : Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const next = await database.transaction(() => {
      requireSupervisor(database, caller, objectiveId);
      observeBudgetEvents(database, objectiveId);
      return pendingEvents(database, objectiveId).first;
    });
    if (next) return { ok: true, action: "wait", event: next, timedOut: false };
    if (Date.now() >= until) return { ok: true, action: "wait", event: null, timedOut: true };
    await sleep(Math.min(200, until - Date.now()));
  }
}

export async function handleEvent(database: Database, caller: Caller, objectiveId: string, id: string): Promise<SupervisorEvent> {
  caller = callerSchema.parse(caller);
  return database.transaction(() => {
    requireSupervisor(database, caller, objectiveId);
    const row = database.get("SELECT * FROM supervisor_events WHERE id = ?", id);
    const reject = (message: string): never => { throw new TaskStoreError("rejected", message); };
    if (!row || row.objective !== objectiveId) reject("Unknown event for this objective");
    const value = event(row!);
    const position = Number(database.get("SELECT sequence FROM supervisor_positions WHERE objective = ?", objectiveId)?.sequence ?? 0);
    if (value.sequence <= position) return value;
    if (pendingEvents(database, objectiveId).first?.id !== id) reject("Only the next unhandled event can be marked handled");
    database.run(`INSERT INTO supervisor_positions VALUES(?,?,?,?) ON CONFLICT(objective) DO UPDATE SET
      sequence = excluded.sequence, handled_by = excluded.handled_by, handled_at = excluded.handled_at`, objectiveId, value.sequence, callerName(caller), new Date().toISOString());
    return value;
  });
}
