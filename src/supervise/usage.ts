import type { Caller } from "../caller.ts";
import type { Database } from "../database.ts";
import { requireScope } from "../dispatch/safety.ts";
import { TaskStoreError } from "../tasks/store.ts";
import { observeBudgetEvents } from "./events.ts";

export type SupervisorUsage = {
  sessionId: string; sequence: number; objectiveId: string; observedAt: string;
  cost: number | null; tokens: number | null;
};

export function supervisorUsage(database: Database, objectiveId: string): SupervisorUsage[] {
  return database.all(`SELECT * FROM supervisor_usage u WHERE objective = ? AND sequence =
    (SELECT max(sequence) FROM supervisor_usage WHERE session_id = u.session_id) ORDER BY session_id`, objectiveId)
    .map(row => ({ sessionId: String(row.session_id), sequence: Number(row.sequence), objectiveId: String(row.objective),
      observedAt: String(row.observed_at), cost: row.cost === null ? null : Number(row.cost), tokens: row.tokens === null ? null : Number(row.tokens) }));
}

/** Host observations, not an agent tool. Keep each session's cumulative high-water marks. */
export async function recordSupervisorUsage(database: Database, caller: Caller, objectiveId: string,
  input: { sessionId: string; cost?: number | null; tokens?: number | null }): Promise<SupervisorUsage> {
  const reject = (detail: string): never => { throw new TaskStoreError("rejected", detail); };
  if (caller.kind !== "supervisor" || caller.objectiveId !== objectiveId) reject("Only the objective's supervisor can record its usage");
  if (typeof input.sessionId !== "string" || !input.sessionId.trim()) reject("Usage requires a nonblank session ID");
  for (const value of [input.cost, input.tokens]) {
    if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) reject("Usage must be a finite nonnegative number or unknown");
  }
  return database.transaction(() => {
    requireScope(database, caller, { objectiveId });
    const previous = database.get("SELECT * FROM supervisor_usage WHERE session_id = ? ORDER BY sequence DESC LIMIT 1", input.sessionId);
    if (previous && previous.objective !== objectiveId) reject("A supervisor session cannot be moved to another objective");
    if (!previous && database.get("SELECT state FROM objectives WHERE id = ?", objectiveId)?.state !== "open") reject(`Objective ${objectiveId} must be open before registering supervisor usage`);
    const highWater = (value: number | null | undefined, before: unknown): number | null =>
      value == null && before == null ? null : Math.max(value ?? 0, before == null ? 0 : Number(before));
    const snapshot: SupervisorUsage = { sessionId: input.sessionId, objectiveId, sequence: Number(previous?.sequence ?? 0) + 1,
      observedAt: new Date().toISOString(), cost: highWater(input.cost, previous?.cost), tokens: highWater(input.tokens, previous?.tokens) };
    database.run("INSERT INTO supervisor_usage VALUES(?,?,?,?,?,?)", snapshot.sessionId, snapshot.sequence, objectiveId, snapshot.observedAt, snapshot.cost, snapshot.tokens);
    observeBudgetEvents(database, objectiveId);
    return snapshot;
  });
}
