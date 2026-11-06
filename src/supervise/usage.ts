import type { Caller } from "../caller.ts";
import type { Database } from "../database.ts";
import { requireScope } from "../dispatch/safety.ts";
import { TaskStoreError } from "../tasks/store.ts";
import { observeBudgetEvents } from "./events.ts";
import { requireOpenObjective } from "./errors.ts";

export type SupervisorSessionKind = "restricted" | "unrestricted";
export const unrestrictedLimitsNotice = "The objective's limits were not enforced";

export type SupervisorUsage = {
  sessionId: string; sequence: number; objectiveId: string; observedAt: string;
  cost: number | null; tokens: number | null;
  sessionKind: SupervisorSessionKind | "not recorded"; limitsNotice: string | null;
};

export function supervisorUsage(database: Database, objectiveId: string): SupervisorUsage[] {
  return database.all(`SELECT u.*, k.kind FROM supervisor_usage u LEFT JOIN supervisor_session_kinds k ON k.session_id = u.session_id WHERE objective = ? AND sequence =
    (SELECT max(sequence) FROM supervisor_usage WHERE session_id = u.session_id) ORDER BY session_id`, objectiveId)
    .map(row => ({ sessionId: String(row.session_id), sequence: Number(row.sequence), objectiveId: String(row.objective),
      sessionKind: row.kind == null ? "not recorded" : row.kind as SupervisorSessionKind,
      limitsNotice: row.kind === "unrestricted" ? unrestrictedLimitsNotice : null,
      observedAt: String(row.observed_at), cost: row.cost === null ? null : Number(row.cost), tokens: row.tokens === null ? null : Number(row.tokens) }));
}

/** Host observations, not an agent tool. Keep each session's cumulative high-water marks. */
export async function recordSupervisorUsage(database: Database, caller: Caller, objectiveId: string,
  input: { sessionId: string; sessionKind?: SupervisorSessionKind; cost?: number | null; tokens?: number | null }): Promise<SupervisorUsage> {
  const reject = (detail: string): never => { throw new TaskStoreError("rejected", detail); };
  if (caller.kind !== "supervisor" || caller.objectiveId !== objectiveId) reject("Only the objective's supervisor can record its usage");
  if (typeof input.sessionId !== "string" || !input.sessionId.trim()) reject("Usage requires a nonblank session ID");
  if (input.sessionKind !== undefined && !["restricted", "unrestricted"].includes(input.sessionKind)) reject("Session kind must be restricted or unrestricted");
  for (const value of [input.cost, input.tokens]) {
    if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) reject("Usage must be a finite nonnegative number or unknown");
  }
  return database.transaction(() => {
    requireScope(database, caller, { objectiveId });
    const previous = database.get("SELECT * FROM supervisor_usage WHERE session_id = ? ORDER BY sequence DESC LIMIT 1", input.sessionId);
    if (previous && previous.objective !== objectiveId) reject("A supervisor session cannot be moved to another objective");
    if (!previous) requireOpenObjective(database.get("SELECT state FROM objectives WHERE id = ?", objectiveId)?.state,
      `Objective ${objectiveId} must be open before registering supervisor usage`);
    const recordedKind = database.get("SELECT kind FROM supervisor_session_kinds WHERE session_id = ?", input.sessionId)?.kind;
    if (previous && input.sessionKind !== undefined && input.sessionKind !== recordedKind) reject("A supervisor session's kind cannot change after registration");
    if (!previous && input.sessionKind !== undefined) database.run("INSERT INTO supervisor_session_kinds VALUES(?,?)", input.sessionId, input.sessionKind);
    const sessionKind = (recordedKind ?? input.sessionKind ?? "not recorded") as SupervisorUsage["sessionKind"];
    const highWater = (value: number | null | undefined, before: unknown): number | null =>
      value == null && before == null ? null : Math.max(value ?? 0, before == null ? 0 : Number(before));
    const snapshot: SupervisorUsage = { sessionId: input.sessionId, objectiveId, sequence: Number(previous?.sequence ?? 0) + 1,
      sessionKind, limitsNotice: sessionKind === "unrestricted" ? unrestrictedLimitsNotice : null,
      observedAt: new Date().toISOString(), cost: highWater(input.cost, previous?.cost), tokens: highWater(input.tokens, previous?.tokens) };
    database.run("INSERT INTO supervisor_usage VALUES(?,?,?,?,?,?)", snapshot.sessionId, snapshot.sequence, objectiveId, snapshot.observedAt, snapshot.cost, snapshot.tokens);
    observeBudgetEvents(database, objectiveId);
    return snapshot;
  });
}
