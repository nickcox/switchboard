import { callerName, callerSchema, type Caller } from "../caller.ts";
import type { Database } from "../database.ts";
import { requireAuthority } from "../dispatch/safety.ts";
import { TaskStoreError } from "../tasks/store.ts";

export type SupervisorNote = { objectiveId: string; sequence: number; text: string; writtenAt: string; writtenBy: string };

export function readNotes(database: Database, objectiveId: string): SupervisorNote[] {
  return database.all("SELECT * FROM supervisor_notes WHERE objective = ? ORDER BY sequence", objectiveId).map(row => ({
    objectiveId, sequence: Number(row.sequence), text: String(row.text), writtenAt: String(row.written_at), writtenBy: String(row.written_by),
  }));
}

/** Notes belong to the supervisor, even when its task permissions have been narrowed. */
export async function appendNote(database: Database, caller: Caller, objectiveId: string, text: string): Promise<SupervisorNote> {
  caller = callerSchema.parse(caller);
  if (caller.kind !== "supervisor" || caller.objectiveId !== objectiveId) throw new TaskStoreError("rejected", "Only the objective's supervisor can write its notes");
  if (!text.trim()) throw new TaskStoreError("rejected", "A supervisor note must not be blank");
  return database.transaction(() => {
    requireAuthority(database, caller, "recordAttempt", { objectiveId });
    const objective = database.get("SELECT state FROM objectives WHERE id = ?", objectiveId);
    if (objective?.state !== "open") throw new TaskStoreError("rejected", `Objective ${objectiveId} must be open before writing a note`);
    const sequence = Number(database.get("SELECT coalesce(max(sequence),0)+1 AS n FROM supervisor_notes WHERE objective = ?", objectiveId)!.n);
    const note = { objectiveId, sequence, text, writtenAt: new Date().toISOString(), writtenBy: callerName(caller) };
    database.run("INSERT INTO supervisor_notes VALUES(?,?,?,?,?)", objectiveId, sequence, text, note.writtenAt, note.writtenBy);
    return note;
  });
}
