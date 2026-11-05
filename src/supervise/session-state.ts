import type { Caller } from "../caller.ts";
import type { Database } from "../database.ts";
import { requireScope } from "../dispatch/safety.ts";
import { TaskStoreError } from "../tasks/store.ts";

export type SupervisorSessionState = {
  sessionId: string; sequence: number; objectiveId: string; observedAt: string;
  state: "stopped" | "resumed" | "retrying"; errorMessage: string | null; eventIds: string[];
  retryNumber?: number; retryTotal?: number; nextRetryAt?: string;
};

export const supervisorRecovery = "Check the provider, then send a message in the supervisor's Pi session or restart it with switchboard supervisor start";

export function supervisorSessionHealth(database: Database, objectiveId: string) {
  // A successful response in any session for this objective supersedes earlier failures without rewriting history.
  // Append order also distinguishes observations recorded in the same millisecond.
  const sessions: SupervisorSessionState[] = database.all(`SELECT * FROM supervisor_session_states s WHERE objective = ? AND state IN ('stopped','retrying')
    AND sequence = (SELECT max(sequence) FROM supervisor_session_states WHERE session_id = s.session_id)
    AND NOT EXISTS (SELECT 1 FROM supervisor_session_states r WHERE r.objective = s.objective AND r.state = 'resumed' AND r.rowid > s.rowid)
    ORDER BY observed_at,session_id`, objectiveId)
    .map(row => ({ sessionId: String(row.session_id), sequence: Number(row.sequence), objectiveId: String(row.objective),
      observedAt: String(row.observed_at), state: row.state as "stopped" | "retrying", errorMessage: String(row.error_message), eventIds: JSON.parse(String(row.event_ids)),
      ...(row.state === "retrying" ? { retryNumber: Number(row.retry_number), retryTotal: Number(row.retry_total), nextRetryAt: String(row.next_retry_at) } : {}) }));
  const stoppedSessions = sessions.filter(session => session.state === "stopped");
  const retryingSessions = sessions.filter(session => session.state === "retrying");
  return { attentionRequired: stoppedSessions.length > 0, stoppedSessions, retryingSessions,
    nextAction: stoppedSessions.length ? supervisorRecovery : null };
}

/** Trusted host observations only. Successful responses can recover supervision across session restarts. */
export async function recordSupervisorSessionState(database: Database, caller: Caller, objectiveId: string,
  input: { sessionId: string; state: "stopped" | "resumed" | "retrying"; errorMessage?: string; eventIds?: string[];
    retryNumber?: number; retryTotal?: number; nextRetryAt?: string }): Promise<SupervisorSessionState | null> {
  const reject = (detail: string): never => { throw new TaskStoreError("rejected", detail); };
  if (caller.kind !== "supervisor" || caller.objectiveId !== objectiveId) reject("Only the objective's supervisor can record its session state");
  if (typeof input.sessionId !== "string" || !input.sessionId.trim()) reject("Session state requires a nonblank session ID");
  if (!["stopped", "resumed", "retrying"].includes(input.state)) reject("Session state must be stopped, resumed or retrying");
  if (input.state !== "resumed" && (typeof input.errorMessage !== "string" || !input.errorMessage.trim())) reject("Stopped or retrying sessions require an error message");
  if (input.state === "resumed" && (input.errorMessage !== undefined || input.eventIds?.length)) reject("Resumed sessions cannot include an error or event IDs");
  if (input.eventIds !== undefined && (!Array.isArray(input.eventIds) || input.eventIds.some(id => typeof id !== "string" || !id.trim()))) reject("Event IDs must be nonblank strings");
  if (input.state === "retrying") {
    if (!Number.isSafeInteger(input.retryNumber) || !Number.isSafeInteger(input.retryTotal) || input.retryNumber! <= 0 || input.retryTotal! < input.retryNumber!) reject("Retry numbers require a positive retry number and a total at least that number");
    if (typeof input.nextRetryAt !== "string" || !Number.isFinite(Date.parse(input.nextRetryAt))) reject("Retrying sessions require a valid next retry time");
  } else if (input.retryNumber !== undefined || input.retryTotal !== undefined || input.nextRetryAt !== undefined) reject("Only retrying sessions can include retry details");
  return database.transaction(() => {
    requireScope(database, caller, { objectiveId });
    const registered = database.get("SELECT objective FROM supervisor_usage WHERE session_id = ? LIMIT 1", input.sessionId);
    if (!registered || registered.objective !== objectiveId) reject("Session state requires a session registered to this objective");
    const previous = database.get("SELECT * FROM supervisor_session_states WHERE session_id = ? ORDER BY sequence DESC LIMIT 1", input.sessionId);
    const health = supervisorSessionHealth(database, objectiveId);
    if (input.state === "resumed" && !["stopped", "retrying"].includes(String(previous?.state)) && !health.attentionRequired && !health.retryingSessions.length) return null;
    const snapshot: SupervisorSessionState = { sessionId: input.sessionId, objectiveId, sequence: Number(previous?.sequence ?? 0) + 1,
      observedAt: new Date().toISOString(), state: input.state, errorMessage: input.state !== "resumed" ? input.errorMessage! : null,
      eventIds: [...new Set(input.eventIds ?? [])],
      ...(input.state === "retrying" ? { retryNumber: input.retryNumber!, retryTotal: input.retryTotal!, nextRetryAt: input.nextRetryAt! } : {}) };
    database.run("INSERT INTO supervisor_session_states VALUES(?,?,?,?,?,?,?,?,?,?)", snapshot.sessionId, snapshot.sequence, objectiveId,
      snapshot.observedAt, snapshot.state, snapshot.errorMessage, JSON.stringify(snapshot.eventIds),
      snapshot.retryNumber ?? null, snapshot.retryTotal ?? null, snapshot.nextRetryAt ?? null);
    return snapshot;
  });
}
