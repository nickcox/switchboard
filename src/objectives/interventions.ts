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
  return entry.kind === "requested" || entry.kind === "operator_request" || entry.kind === "rebase_started" || entry.kind === "integration_started" ||
    entry.kind === "task_recorded" && entry.data.reason === "finished";
}

type InterventionSource = { kind: "objective"; sequence: number } | { kind: "task"; sequence: number }
  | { kind: "attempt"; ref: AttemptRef; id: string };

/** Resolve only the source just written; collection below shares all decision and duplicate rules. */
export function personIntervention(database: Database, objectiveId: string, id: string, entryRef?: AttemptRef): PersonIntervention | undefined {
  let source: InterventionSource;
  if (id.startsWith("objective:")) source = { kind: "objective", sequence: Number(id.slice(id.lastIndexOf(":") + 1)) };
  else if (id.startsWith("task:")) source = { kind: "task", sequence: Number(id.slice(5)) };
  else {
    let ref: AttemptRef;
    if (id.startsWith("entry:") || id.startsWith("confirmation:")) {
      const [contextId, taskId, attempt] = JSON.parse(id.slice(id.indexOf(":") + 1, id.lastIndexOf(":"))) as [string, string, number];
      ref = { contextId, taskId, attempt };
    } else {
      const row = id.startsWith("request:") ? database.get(`SELECT c.context,c.task,c.attempt FROM control_requests r
        JOIN worker_claims c ON c.id = r.claim_id WHERE r.id = ?`, id.slice(8))
        : id.startsWith("answer:") ? database.get("SELECT context,task,attempt FROM question_files WHERE id = ?", id.slice(7)) : undefined;
      if (!row && !entryRef) return undefined;
      ref = row ? { contextId: String(row.context), taskId: String(row.task), attempt: Number(row.attempt) } : entryRef!;
    }
    source = { kind: "attempt", ref, id };
  }
  const result = collectInterventions(database, objectiveId, source);
  return [...result.items, ...result.leaseReturns.items].find(item => item.id === id);
}

/** Counts recorded person decisions, not automatic effects or a second copy of a confirmation or message. */
export function personInterventions(database: Database, objectiveId: string): PersonInterventions {
  return collectInterventions(database, objectiveId);
}

function sourcePosition(id: string): number { return Number(id.slice(id.lastIndexOf(":") + 1)); }

function readEntries(database: Database, ref: AttemptRef, target?: string): AttemptEntry[] {
  const query = "SELECT entry FROM attempt_entries WHERE context = ? AND task = ? AND attempt = ?";
  let rows: ReturnType<Database["all"]>;
  if (target?.startsWith("entry:")) {
    const position = sourcePosition(target);
    // Prior finish and integration decisions establish whether this entry is a duplicate finish.
    rows = database.all(`${query} AND sequence <= ? AND
      (sequence = ? OR json_extract(entry, '$.kind') IN ('task_recorded','integration_started')) ORDER BY sequence`,
      ref.contextId, ref.taskId, ref.attempt, position, position);
  } else if (target?.startsWith("request:")) {
    rows = database.all(`${query} AND json_extract(entry, '$.kind') = 'operator_request'
      AND json_extract(entry, '$.data.id') = ? ORDER BY sequence`, ref.contextId, ref.taskId, ref.attempt, target.slice(8));
  } else if (target) return [];
  else rows = database.all(`${query} ORDER BY sequence`, ref.contextId, ref.taskId, ref.attempt);
  return rows.map(row => JSON.parse(String(row.entry)));
}

function readConfirmations(database: Database, ref: AttemptRef, target?: string): ConfirmationRecord[] {
  if (target && !target.startsWith("confirmation:")) return [];
  const query = "SELECT * FROM confirmations WHERE context = ? AND task = ? AND attempt = ? ORDER BY id";
  const rows = target ? database.all(`${query} LIMIT 1 OFFSET ?`, ref.contextId, ref.taskId, ref.attempt, sourcePosition(target))
    : database.all(query, ref.contextId, ref.taskId, ref.attempt);
  return rows.map(row => ({ ...ref, fact: row.fact, scope: JSON.parse(String(row.scope)),
    confirmedBy: String(row.confirmed_by), confirmedAt: String(row.confirmed_at) } as ConfirmationRecord));
}

function collectInterventions(database: Database, objectiveId: string, source?: InterventionSource): PersonInterventions {
  const createdAt = String(database.get("SELECT created_at FROM objectives WHERE id = ?", objectiveId)!.created_at);
  const items: PersonIntervention[] = [], leaseReturns: PersonIntervention[] = [];
  const add = (value: PersonIntervention, leaseReturn = false) => {
    if (source?.kind === "attempt" && value.id !== source.id) return;
    if (!value.actor || value.actor.startsWith("supervisor:") || Date.parse(value.at) < Date.parse(createdAt)) return;
    (leaseReturn ? leaseReturns : items).push(value);
  };
  const objectiveChanges = source ? source.kind === "objective" ? database.all("SELECT * FROM objective_changes WHERE objective = ? AND sequence = ? AND action <> 'add'", objectiveId, source.sequence) : []
    : database.all("SELECT * FROM objective_changes WHERE objective = ? AND action <> 'add' ORDER BY sequence", objectiveId);
  for (const row of objectiveChanges) {
    add({ id: `objective:${objectiveId}:${row.sequence}`, source: "objective_changes", action: String(row.action), actor: String(row.changed_by), at: String(row.changed_at), details: JSON.parse(String(row.changes)) });
  }
  for (const row of source ? [] : database.all(`SELECT q.id, a.* FROM person_answers a JOIN person_questions q ON q.id = a.question_id WHERE q.objective = ?`, objectiveId)) {
    add({ id: `person_answer:${row.id}`, source: "person_answers", action: "answer", actor: String(row.answered_by), at: String(row.answered_at),
      details: { questionId: String(row.id), text: String(row.text) } });
  }
  const memberships = new Map<string, { at: number; before: string | null | undefined; after: string | null | undefined }[]>();
  // Before and after retain membership changes, including a task moved away from this objective.
  const taskChanges = source ? source.kind === "task" ? database.all("SELECT * FROM task_changes WHERE sequence = ?", source.sequence)
    : source.kind === "attempt" ? database.all("SELECT * FROM task_changes WHERE task = ? ORDER BY changed_at,sequence", source.ref.taskId) : []
    : database.all("SELECT * FROM task_changes ORDER BY changed_at,sequence");
  for (const row of taskChanges) {
    const changes = JSON.parse(String(row.changes));
    const history = memberships.get(String(row.task)) ?? [];
    history.push({ at: Date.parse(String(row.changed_at)), before: changes.before?.objectiveId, after: changes.after?.objectiveId });
    memberships.set(String(row.task), history);
    if (changes.before?.objectiveId !== objectiveId && changes.after?.objectiveId !== objectiveId) continue;
    add({ id: `task:${row.sequence}`, source: "task_changes", action: String(row.action), actor: String(row.changed_by), at: String(row.changed_at), taskId: String(row.task), details: changes });
  }
  const requestIds = new Set<string>();
  const answers = source ? source.kind === "attempt" && source.id.startsWith("answer:") ? database.all(`SELECT q.*, a.text, a.answered_by, a.answered_at, a.request_id FROM question_files q
    JOIN question_answers a ON a.question_id = q.id WHERE q.id = ?`, source.id.slice(7)) : []
    : database.all(`SELECT q.*, a.text, a.answered_by, a.answered_at, a.request_id FROM question_answers a
    JOIN question_files q ON q.id = a.question_id`);
  for (const answer of answers) if (answer.request_id !== null) requestIds.add(String(answer.request_id));
  const answerRequest = (id: string) => source ? Boolean(database.get("SELECT 1 FROM question_answers WHERE request_id = ?", id)) : requestIds.has(id);
  const attemptQuery = `SELECT n.*, t.objective_id, s.specification, ar.summary FROM attempt_numbers n
    JOIN tasks t ON t.id = n.task
    LEFT JOIN attempt_specifications s ON s.context = n.context AND s.task = n.task AND s.attempt = n.number
    LEFT JOIN archived_attempts ar ON ar.context = n.context AND ar.task = n.task AND ar.attempt = n.number`;
  const attempts = source ? source.kind === "attempt" ? database.all(`${attemptQuery} WHERE n.context = ? AND n.task = ? AND n.number = ?`,
    source.ref.contextId, source.ref.taskId, source.ref.attempt) : [] : database.all(`${attemptQuery} ORDER BY n.context,n.task,n.number`);
  for (const row of attempts) {
    const archive = row.summary === null ? undefined : JSON.parse(String(row.summary));
    const specification = row.specification === null ? archive?.specification : JSON.parse(String(row.specification));
    const ref: AttemptRef = { contextId: String(row.context), taskId: String(row.task), attempt: Number(row.number) };
    const addAttempt = (value: PersonIntervention, leaseReturn = false, dispatch = false) => {
      const history = memberships.get(ref.taskId) ?? [];
      const latest = history.filter(change => change.at <= Date.parse(value.at) && change.after !== undefined).at(-1);
      let membership = specification?.objectiveId === undefined ? row.objective_id : specification.objectiveId;
      if (latest) membership = latest.after;
      else if (history[0]?.before !== undefined) membership = history[0].before;
      if (dispatch && specification?.objectiveId !== undefined) membership = specification.objectiveId;
      if (membership === objectiveId) add(value, leaseReturn);
    };
    const key = JSON.stringify([ref.contextId, ref.taskId, ref.attempt]);
    const target = source?.kind === "attempt" ? source.id : undefined;
    const entries: AttemptEntry[] = archive ? archive.interventionEntries ?? [] : readEntries(database, ref, target);
    let confirmations: ConfirmationRecord[] = archive ? archive.confirmations ?? [] : readConfirmations(database, ref, target);
    if (archive && target?.startsWith("confirmation:")) confirmations = confirmations.slice(sourcePosition(target), sourcePosition(target) + 1);
    for (const [index, confirmation] of confirmations.entries()) {
      const position = target?.startsWith("confirmation:") ? sourcePosition(target) : index;
      addAttempt({ ...ref, id: `confirmation:${key}:${position}`, source: "confirmations", action: confirmation.fact, actor: confirmation.confirmedBy,
        at: confirmation.confirmedAt, details: confirmation.scope }, confirmation.fact === "no_processes" || confirmation.fact === "lease_returned");
    }
    const requests: Record<string, unknown>[] = archive ? archive.controlRequests ?? [] : target ? target.startsWith("request:")
      ? database.all("SELECT * FROM control_requests WHERE id = ?", target.slice(8)) : []
      : database.all(`SELECT r.* FROM control_requests r JOIN worker_claims c ON c.id = r.claim_id
        WHERE c.context = ? AND c.task = ? AND c.attempt = ? ORDER BY r.created_at,r.id`, ref.contextId, ref.taskId, ref.attempt);
    const seenRequests = new Set<string>();
    for (const row of requests) {
      const request = JSON.parse(String(row.request));
      seenRequests.add(request.id);
      if (request.questionId || answerRequest(request.id)) continue;
      addAttempt({ ...ref, id: `request:${request.id}`, source: "control_requests", action: request.kind, actor: request.sender, at: request.createdAt,
        details: { request, claimedBy: row.claimed_by, result: row.result === null ? null : JSON.parse(String(row.result)) } });
    }
    for (const entry of entries.filter(interventionEntry)) {
      if (entry.kind === "operator_request") {
        const id = String(entry.data.id);
        if (seenRequests.has(id) || answerRequest(id)) continue;
        addAttempt({ ...ref, id: `request:${id}`, source: "attempt_entries", action: String(entry.data.kind), actor: String(entry.data.sender), at: entry.recordedAt, details: entry.data });
      } else {
        if (entry.kind === "task_recorded") {
          const previousFinish = entries.filter(candidate => candidate.sequence < entry.sequence && candidate.kind === "task_recorded" && candidate.data.reason === "finished").at(-1)?.sequence ?? -1;
          // Integration may finish an already-done task, or stop before recording it. Its intent is the finish decision.
          if (entries.some(candidate => candidate.kind === "integration_started" && candidate.sequence > previousFinish && candidate.sequence < entry.sequence && candidate.askedBy === entry.askedBy)) continue;
        }
        addAttempt({ ...ref, id: `entry:${key}:${entry.sequence}`, source: "attempt_entries", action: entry.kind === "requested" ? "dispatch" : entry.kind === "rebase_started" ? "rebase" : "finish",
          actor: entry.askedBy ?? "", at: entry.recordedAt, details: entry.data }, false, entry.kind === "requested");
      }
    }
    for (const answer of answers.filter(answer => answer.context === ref.contextId && answer.task === ref.taskId && Number(answer.attempt) === ref.attempt)) {
      addAttempt({ ...ref, id: `answer:${answer.id}`, source: "question_answers", action: "answer", actor: String(answer.answered_by), at: String(answer.answered_at),
        details: { questionId: String(answer.id), text: String(answer.text) } });
    }
  }
  const order = (a: PersonIntervention, b: PersonIntervention) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id);
  return { count: items.length, items: items.sort(order), leaseReturns: { count: leaseReturns.length, items: leaseReturns.sort(order) } };
}
