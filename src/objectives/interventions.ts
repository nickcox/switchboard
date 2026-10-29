import type { AttemptEntry, AttemptRef } from "../attempts/log.ts";
import type { ConfirmationRecord } from "../attempts/store.ts";
import type { Database } from "../database.ts";

export type PersonIntervention = {
  id: string; source: string; action: string; actor: string; at: string;
  taskId?: string; contextId?: string; attempt?: number; details: unknown;
};
export type PersonInterventions = {
  count: number; items: PersonIntervention[];
  leaseReturns: { count: number; items: PersonIntervention[] };
};

/** Keep original decision records when pruning, not the dispatcher stages caused by those decisions. */
export function interventionEntry(entry: AttemptEntry): boolean {
  return entry.kind === "requested" || entry.kind === "operator_request" || entry.kind === "rebase_started" ||
    entry.kind === "task_recorded" && entry.data.reason === "finished";
}

/** Counts recorded person decisions, not automatic effects or a second copy of a confirmation or message. */
export function personInterventions(database: Database, objectiveId: string): PersonInterventions {
  const createdAt = String(database.get("SELECT created_at FROM objectives WHERE id = ?", objectiveId)!.created_at);
  const items: PersonIntervention[] = [], leaseReturns: PersonIntervention[] = [];
  const add = (value: PersonIntervention, leaseReturn = false) => {
    if (!value.actor || value.actor.startsWith("supervisor:") || Date.parse(value.at) < Date.parse(createdAt)) return;
    (leaseReturn ? leaseReturns : items).push(value);
  };
  for (const row of database.all("SELECT * FROM objective_changes WHERE objective = ? AND action <> 'add' ORDER BY sequence", objectiveId)) {
    add({ id: `objective:${objectiveId}:${row.sequence}`, source: "objective_changes", action: String(row.action), actor: String(row.changed_by), at: String(row.changed_at), details: JSON.parse(String(row.changes)) });
  }
  // Before and after retain membership changes, including a task moved away from this objective.
  for (const row of database.all("SELECT * FROM task_changes ORDER BY sequence")) {
    const changes = JSON.parse(String(row.changes));
    if (changes.before?.objectiveId !== objectiveId && changes.after?.objectiveId !== objectiveId) continue;
    add({ id: `task:${row.sequence}`, source: "task_changes", action: String(row.action), actor: String(row.changed_by), at: String(row.changed_at), taskId: String(row.task), details: changes });
  }
  const requestIds = new Set<string>();
  const answers = database.all(`SELECT q.*, a.text, a.answered_by, a.answered_at, a.request_id FROM question_answers a
    JOIN question_files q ON q.id = a.question_id`);
  for (const answer of answers) if (answer.request_id !== null) requestIds.add(String(answer.request_id));
  for (const row of database.all(`SELECT n.*, t.objective_id, s.specification, ar.summary FROM attempt_numbers n
    JOIN tasks t ON t.id = n.task
    LEFT JOIN attempt_specifications s ON s.context = n.context AND s.task = n.task AND s.attempt = n.number
    LEFT JOIN archived_attempts ar ON ar.context = n.context AND ar.task = n.task AND ar.attempt = n.number
    ORDER BY n.context,n.task,n.number`)) {
    const archive = row.summary === null ? undefined : JSON.parse(String(row.summary));
    const specification = row.specification === null ? archive?.specification : JSON.parse(String(row.specification));
    if ((specification?.objectiveId === undefined ? row.objective_id : specification.objectiveId) !== objectiveId) continue;
    const ref: AttemptRef = { contextId: String(row.context), taskId: String(row.task), attempt: Number(row.number) };
    const key = JSON.stringify([ref.contextId, ref.taskId, ref.attempt]);
    const entries: AttemptEntry[] = archive ? archive.interventionEntries ?? [] : database.all(
      "SELECT entry FROM attempt_entries WHERE context = ? AND task = ? AND attempt = ? ORDER BY sequence", ref.contextId, ref.taskId, ref.attempt).map(entry => JSON.parse(String(entry.entry)));
    const confirmations: ConfirmationRecord[] = archive ? archive.confirmations ?? [] : database.all(
      "SELECT * FROM confirmations WHERE context = ? AND task = ? AND attempt = ? ORDER BY id", ref.contextId, ref.taskId, ref.attempt).map(confirmation => ({
        ...ref, fact: confirmation.fact, scope: JSON.parse(String(confirmation.scope)), confirmedBy: String(confirmation.confirmed_by), confirmedAt: String(confirmation.confirmed_at),
      } as ConfirmationRecord));
    for (const [index, confirmation] of confirmations.entries()) {
      add({ ...ref, id: `confirmation:${key}:${index}`, source: "confirmations", action: confirmation.fact, actor: confirmation.confirmedBy,
        at: confirmation.confirmedAt, details: confirmation.scope }, confirmation.fact === "no_processes" || confirmation.fact === "lease_returned");
    }
    const requests: Record<string, unknown>[] = archive ? archive.controlRequests ?? [] : database.all(`SELECT r.* FROM control_requests r JOIN worker_claims c ON c.id = r.claim_id
      WHERE c.context = ? AND c.task = ? AND c.attempt = ? ORDER BY r.created_at,r.id`, ref.contextId, ref.taskId, ref.attempt);
    const seenRequests = new Set<string>();
    for (const row of requests) {
      const request = JSON.parse(String(row.request));
      seenRequests.add(request.id);
      if (request.questionId || requestIds.has(request.id)) continue;
      add({ ...ref, id: `request:${request.id}`, source: "control_requests", action: request.kind, actor: request.sender, at: request.createdAt,
        details: { request, claimedBy: row.claimed_by, result: row.result === null ? null : JSON.parse(String(row.result)) } });
    }
    for (const entry of entries.filter(interventionEntry)) {
      if (entry.kind === "operator_request") {
        const id = String(entry.data.id);
        if (seenRequests.has(id) || requestIds.has(id)) continue;
        add({ ...ref, id: `request:${id}`, source: "attempt_entries", action: String(entry.data.kind), actor: String(entry.data.sender), at: entry.recordedAt, details: entry.data });
      } else {
        add({ ...ref, id: `entry:${key}:${entry.sequence}`, source: "attempt_entries", action: entry.kind === "requested" ? "dispatch" : entry.kind === "task_recorded" ? "finish" : "rebase",
          actor: entry.askedBy ?? "", at: entry.recordedAt, details: entry.data });
      }
    }
    for (const answer of answers.filter(answer => answer.context === ref.contextId && answer.task === ref.taskId && Number(answer.attempt) === ref.attempt)) {
      add({ ...ref, id: `answer:${answer.id}`, source: "question_answers", action: "answer", actor: String(answer.answered_by), at: String(answer.answered_at),
        details: { questionId: String(answer.id), text: String(answer.text) } });
    }
  }
  const order = (a: PersonIntervention, b: PersonIntervention) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id);
  return { count: items.length, items: items.sort(order), leaseReturns: { count: leaseReturns.length, items: leaseReturns.sort(order) } };
}
