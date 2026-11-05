import type { Caller } from "../caller.ts";
import type { Database } from "../database.ts";
import { requireScope } from "../dispatch/safety.ts";
import { TaskStoreError } from "../tasks/store.ts";

export type SupervisorSessionState = {
  sessionId: string; sequence: number; objectiveId: string; observedAt: string;
  state: "stopped" | "resumed"; errorMessage: string | null; eventIds: string[];
};

export const supervisorRecovery = "Check the provider, then send a message in the supervisor's Pi session or restart it with switchboard supervisor start";

export function supervisorSessionHealth(database: Database, objectiveId: string) {
  const stoppedSessions: SupervisorSessionState[] = database.all(`SELECT * FROM supervisor_session_states s WHERE objective = ? AND state = 'stopped'
    AND sequence = (SELECT max(sequence) FROM supervisor_session_states WHERE session_id = s.session_id) ORDER BY observed_at,session_id`, objectiveId)
    .map(row => ({ sessionId: String(row.session_id), sequence: Number(row.sequence), objectiveId: String(row.objective),
      observedAt: String(row.observed_at), state: "stopped", errorMessage: String(row.error_message), eventIds: JSON.parse(String(row.event_ids)) }));
  return { attentionRequired: stoppedSessions.length > 0, stoppedSessions,
    nextAction: stoppedSessions.length ? supervisorRecovery : null };
}

/** Trusted host observations only. A successful response clears this session, never another session. */
export async function recordSupervisorSessionState(database: Database, caller: Caller, objectiveId: string,
  input: { sessionId: string; state: "stopped" | "resumed"; errorMessage?: string; eventIds?: string[] }): Promise<SupervisorSessionState | null> {
  const reject = (detail: string): never => { throw new TaskStoreError("rejected", detail); };
  if (caller.kind !== "supervisor" || caller.objectiveId !== objectiveId) reject("Only the objective's supervisor can record its session state");
  if (typeof input.sessionId !== "string" || !input.sessionId.trim()) reject("Session state requires a nonblank session ID");
  if (!["stopped", "resumed"].includes(input.state)) reject("Session state must be stopped or resumed");
  if (input.state === "stopped" && (typeof input.errorMessage !== "string" || !input.errorMessage.trim())) reject("Stopped sessions require an error message");
  if (input.state === "resumed" && (input.errorMessage !== undefined || input.eventIds?.length)) reject("Resumed sessions cannot include an error or event IDs");
  if (input.eventIds !== undefined && (!Array.isArray(input.eventIds) || input.eventIds.some(id => typeof id !== "string" || !id.trim()))) reject("Event IDs must be nonblank strings");
  return database.transaction(() => {
    requireScope(database, caller, { objectiveId });
    const registered = database.get("SELECT objective FROM supervisor_usage WHERE session_id = ? LIMIT 1", input.sessionId);
    if (!registered || registered.objective !== objectiveId) reject("Session state requires a session registered to this objective");
    const previous = database.get("SELECT * FROM supervisor_session_states WHERE session_id = ? ORDER BY sequence DESC LIMIT 1", input.sessionId);
    if (input.state === "resumed" && previous?.state !== "stopped") return null;
    const snapshot: SupervisorSessionState = { sessionId: input.sessionId, objectiveId, sequence: Number(previous?.sequence ?? 0) + 1,
      observedAt: new Date().toISOString(), state: input.state, errorMessage: input.state === "stopped" ? input.errorMessage! : null,
      eventIds: [...new Set(input.eventIds ?? [])] };
    database.run("INSERT INTO supervisor_session_states VALUES(?,?,?,?,?,?,?)", snapshot.sessionId, snapshot.sequence, objectiveId,
      snapshot.observedAt, snapshot.state, snapshot.errorMessage, JSON.stringify(snapshot.eventIds));
    return snapshot;
  });
}
