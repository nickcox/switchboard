import { z } from "zod";
import { personInterventions } from "./interventions.ts";
import { recordBudgetEvents, recordPersonEvents } from "../supervise/events.ts";
import { readPersonQuestions } from "../supervise/questions.ts";
import { objectiveBudget, unknownKey, type ObjectiveBudget } from "./budget.ts";
import { callerName, callerSchema, type Caller } from "../caller.ts";
import { requireAuthority } from "../dispatch/safety.ts";
import { Database } from "../database.ts";
import { AttemptStore } from "../attempts/store.ts";
import { reviewRecordSchema } from "../attempts/reviews.ts";
import { acceptanceCriteriaSchema } from "../tasks/criteria.ts";
import { TaskStoreError } from "../tasks/store.ts";

const nonempty = z.string().refine(value => value.trim().length > 0, "Must not be blank");
const id = z.string().regex(/^[a-zA-Z0-9._-]+$/);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const permissionsSchema = z.strictObject({
  manageTasks: z.boolean(), dispatch: z.boolean(), continueAttempts: z.boolean(),
  steerWorkers: z.boolean(), stopWorkers: z.boolean(), answerQuestions: z.boolean(),
  acceptOutput: z.boolean(), integrate: z.boolean(), rebase: z.boolean(),
  completeTasks: z.boolean(), completeObjective: z.boolean(),
});
export const defaultPermissions: z.infer<typeof permissionsSchema> = {
  manageTasks: true, dispatch: true, continueAttempts: true,
  steerWorkers: true, stopWorkers: true, answerQuestions: true,
  acceptOutput: true, integrate: true, rebase: true, completeTasks: true, completeObjective: true,
};
export const budgetSchema = z.strictObject({ maxCost: z.number().finite().nonnegative().nullable(), maxWorkerTimeMs: z.number().finite().nonnegative().nullable() });
const fieldsSchema = z.strictObject({
  acceptanceCriteria: acceptanceCriteriaSchema.refine(criteria => criteria.length > 0, "An objective needs at least one criterion"),
  scope: z.string(), constraints: z.string(), permissions: permissionsSchema, budget: budgetSchema,
  deadline: z.iso.datetime({ offset: true }).nullable(),
});
export type ObjectiveChanges = Partial<z.infer<typeof fieldsSchema>>;
const attemptRef = z.strictObject({ contextId: nonempty, taskId: id, attempt: z.number().int().positive(), commit });
export const objectiveReferenceSchema = z.discriminatedUnion("kind", [
  attemptRef.extend({ kind: z.literal("accepted_commit") }),
  attemptRef.extend({ kind: z.literal("review"), reviewTaskId: id, reviewAttempt: z.number().int().positive() }),
]);
export type ObjectiveReference = z.infer<typeof objectiveReferenceSchema>;
export const completionStatementsSchema = z.array(z.strictObject({
  position: z.number().int().positive(), statement: nonempty, references: z.array(objectiveReferenceSchema).min(1),
})).min(1);
export type CompletionStatement = z.infer<typeof completionStatementsSchema>[number];
export type Objective = z.infer<typeof fieldsSchema> & {
  id: string; request: string; state: "open" | "completed" | "abandoned";
  createdBy: string; createdAt: string; updatedAt: string; closedAt: string | null;
  completionStatements: CompletionStatement[];
};
export type ObjectiveBrief = Pick<Objective, "id" | "request" | "state" | "updatedAt"> & ObjectiveBudget & { taskCount: number; doneTaskCount: number };
const reject = (message: string): never => { throw new TaskStoreError("rejected", message); };
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : reject(parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "));
}
const columns = { acceptanceCriteria: "acceptance_criteria", scope: "scope", constraints: "constraints", permissions: "permissions", budget: "budget", deadline: "deadline" } as const;

/** Objective operations share the task database. The host supplies the actor, never the command's arguments. */
export class ObjectiveStore {
  readonly database: Database;
  readonly caller: Caller;
  get actor(): string { return callerName(this.caller); }
  constructor(database: Database, caller: Caller) { this.database = database; this.caller = callerSchema.parse(caller); }

  read(id: string): Objective | undefined {
    const row = this.database.get("SELECT * FROM objectives WHERE id = ?", id);
    if (!row) return undefined;
    return {
      id: String(row.id), request: String(row.request), state: row.state as Objective["state"],
      acceptanceCriteria: JSON.parse(String(row.acceptance_criteria)), scope: String(row.scope), constraints: String(row.constraints),
      permissions: JSON.parse(String(row.permissions)), budget: JSON.parse(String(row.budget)), deadline: row.deadline as string | null,
      createdBy: String(row.created_by), createdAt: String(row.created_at), updatedAt: String(row.updated_at), closedAt: row.closed_at as string | null,
      completionStatements: JSON.parse(String(row.completion_statements)),
    };
  }
  private require(id: string): Objective { return this.read(id) ?? reject(`Objective ${id} does not exist`); }
  private requireOpen(id: string): Objective {
    const objective = this.require(id);
    if (objective.state !== "open") reject(`Objective ${id} is ${objective.state}; reopen it explicitly before changing it`);
    return objective;
  }
  list(state?: Objective["state"]): ObjectiveBrief[] {
    return this.database.all(`SELECT o.*, count(t.id) AS task_count, coalesce(sum(t.state = 'done'),0) AS done_count
      FROM objectives o LEFT JOIN tasks t ON t.objective_id = o.id WHERE (? IS NULL OR o.state = ?)
      GROUP BY o.id ORDER BY o.created_at, o.id`, state ?? null, state ?? null).map(row => ({
      id: String(row.id), request: String(row.request), state: row.state as Objective["state"], updatedAt: String(row.updated_at),
      taskCount: Number(row.task_count), doneTaskCount: Number(row.done_count), ...objectiveBudget(this.database, String(row.id)),
    }));
  }
  show(id: string) {
    const objective = this.require(id);
    const tasks = this.database.all("SELECT id,title,state,hold_reason FROM tasks WHERE objective_id = ? ORDER BY position", id).map(row => ({
      id: String(row.id), title: String(row.title), state: String(row.state), holdReason: row.hold_reason as string | null,
      // Attempt numbers are scoped to a context, so show the latest in each context, including pruned attempts.
      latestAttempts: this.database.all(`SELECT n.context, n.number, a.closed, ar.summary,
        (SELECT entry FROM attempt_entries e WHERE e.context = n.context AND e.task = n.task AND e.attempt = n.number ORDER BY sequence DESC LIMIT 1) AS last_entry
        FROM attempt_numbers n LEFT JOIN attempts a ON a.context = n.context AND a.task = n.task AND a.number = n.number
        LEFT JOIN archived_attempts ar ON ar.context = n.context AND ar.task = n.task AND ar.attempt = n.number
        WHERE n.task = ? AND n.number = (SELECT max(m.number) FROM attempt_numbers m WHERE m.context = n.context AND m.task = n.task)
        ORDER BY n.context`, String(row.id)).map(attempt => ({
        contextId: String(attempt.context), attempt: Number(attempt.number), archived: attempt.summary !== null,
        closed: attempt.summary !== null || Boolean(attempt.closed),
        ...(attempt.last_entry ? { lastEntry: JSON.parse(String(attempt.last_entry)) } : {}),
        ...(attempt.summary ? { summary: JSON.parse(String(attempt.summary)).summary } : {}),
      })),
    }));
    return { ...objective, ...objectiveBudget(this.database, id), criteria: objective.acceptanceCriteria.map((criterion, index) => ({
      position: index + 1, criterion, completion: objective.completionStatements.find(statement => statement.position === index + 1) ?? null,
    })), tasks, openPersonQuestions: readPersonQuestions(this.database, id).filter(question => !question.answer), availableReferences: this.references(id), history: this.history(id), personInterventions: personInterventions(this.database, id) };
  }
  history(id: string) {
    return this.database.all("SELECT * FROM objective_changes WHERE objective = ? ORDER BY sequence", id).map(row => ({
      sequence: Number(row.sequence), action: String(row.action), changedBy: String(row.changed_by), changedAt: String(row.changed_at), changes: JSON.parse(String(row.changes)),
    }));
  }
  async add(input: { id: string; request: string } & ObjectiveChanges): Promise<Objective> {
    const value = parse(z.strictObject({ id, request: nonempty, ...fieldsSchema.shape }), {
      scope: "", constraints: "", permissions: defaultPermissions, budget: { maxCost: null, maxWorkerTimeMs: null }, deadline: null, ...input,
    });
    return this.database.transaction(() => {
      requireAuthority(this.database, this.caller, "objectiveAdd");
      if (this.read(value.id)) reject(`Objective ${value.id} already exists`);
      const now = new Date().toISOString();
      this.database.run(`INSERT INTO objectives(id,request,acceptance_criteria,scope,constraints,permissions,budget,deadline,created_by,created_at,updated_at,state)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'open')`, value.id, value.request, JSON.stringify(value.acceptanceCriteria), value.scope, value.constraints,
        JSON.stringify(value.permissions), JSON.stringify(value.budget), value.deadline, this.actor, now, now);
      const objective = this.require(value.id);
      this.record(value.id, "add", null, objective, now);
      return objective;
    });
  }
  async update(id: string, input: ObjectiveChanges): Promise<Objective> {
    const changes = parse(fieldsSchema.partial(), input);
    return this.database.transaction(() => {
      requireAuthority(this.database, this.caller, "objectiveUpdate", { objectiveId: id, protectedFields: ["permissions", "budget", "deadline", "acceptanceCriteria"].some(key => key in input) });
      const before = this.requireOpen(id);
      const fields = (Object.keys(columns) as (keyof typeof columns)[]).filter(key => changes[key] !== undefined && JSON.stringify(changes[key]) !== JSON.stringify(before[key]));
      if (!fields.length) return before;
      const now = new Date().toISOString();
      this.database.run(`UPDATE objectives SET ${fields.map(key => `${columns[key]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
        ...fields.map(key => ["acceptanceCriteria", "permissions", "budget"].includes(key) ? JSON.stringify(changes[key]) : changes[key] as string | null), now, id);
      const after = this.require(id);
      this.record(id, "update", before, after, now);
      const raised = (key: "maxCost" | "maxWorkerTimeMs") => before.budget[key] !== null && (after.budget[key] === null || after.budget[key]! > before.budget[key]!);
      if ((raised("maxCost") || raised("maxWorkerTimeMs")) && objectiveBudget(this.database, id).spending.unknown.some(a => a.finished && !a.confirmed)) {
        this.recordBudgetConfirmation(id, "Budget raised after inspecting unknown usage", now);
      }
      return after;
    });
  }
  async confirmBudget(id: string, note: string): Promise<ReturnType<ObjectiveStore["show"]>> {
    note = parse(nonempty, note);
    return this.database.transaction(() => {
      requireAuthority(this.database, this.caller, "objectiveUpdate", { objectiveId: id, protectedFields: true });
      this.requireOpen(id);
      this.recordBudgetConfirmation(id, note, new Date().toISOString());
      return this.show(id);
    });
  }
  private recordBudgetConfirmation(id: string, note: string, now: string): void {
    const unknownAttempts = objectiveBudget(this.database, id).spending.unknown.filter(a => a.finished && !a.confirmed).map(unknownKey);
    this.database.run("UPDATE objectives SET updated_at = ? WHERE id = ?", now, id);
    this.database.run(`INSERT INTO objective_changes VALUES(?,(SELECT coalesce(max(sequence),0)+1 FROM objective_changes WHERE objective = ?),?,?,?,?)`,
      id, id, "confirm-budget", this.actor, now, JSON.stringify({ note, unknownAttempts }));
    this.recordEvent(id);
  }
  async abandon(id: string): Promise<Objective> { return this.transition(id, "abandoned"); }
  async reopen(id: string): Promise<Objective> { return this.transition(id, "open"); }
  async complete(id: string, input: CompletionStatement[]): Promise<Objective> {
    const statements = parse(completionStatementsSchema, input);
    return this.database.transaction(() => {
      requireAuthority(this.database, this.caller, "completeObjective", { objectiveId: id });
      const before = this.requireOpen(id);
      if (statements.length !== before.acceptanceCriteria.length || new Set(statements.map(s => s.position)).size !== statements.length ||
        statements.some(s => s.position > before.acceptanceCriteria.length)) reject("Supply exactly one completion statement for each objective criterion");
      const available = this.references(id);
      for (const statement of statements) for (const reference of statement.references) {
        if (!available.some(candidate => JSON.stringify(objectiveReferenceSchema.parse(candidate)) === JSON.stringify(reference))) reject("A completion reference must name an accepted commit or recorded review of this objective's tasks");
      }
      const now = new Date().toISOString();
      this.database.run("UPDATE objectives SET state = 'completed', completion_statements = ?, updated_at = ?, closed_at = ? WHERE id = ?",
        JSON.stringify([...statements].sort((a, b) => a.position - b.position)), now, now, id);
      const after = this.require(id);
      this.record(id, "complete", before, after, now);
      return after;
    });
  }
  private async transition(id: string, state: "open" | "abandoned"): Promise<Objective> {
    return this.database.transaction(() => {
      requireAuthority(this.database, this.caller, state === "open" ? "objectiveReopen" : "objectiveAbandon", { objectiveId: id });
      const before = state === "open" ? this.require(id) : this.requireOpen(id);
      if (before.state === state) reject(`Objective ${id} is already ${state}`);
      const now = new Date().toISOString();
      this.database.run("UPDATE objectives SET state = ?, completion_statements = '[]', updated_at = ?, closed_at = ? WHERE id = ?", state, now, state === "open" ? null : now, id);
      const after = this.require(id);
      this.record(id, state === "open" ? "reopen" : "abandon", before, after, now);
      return after;
    });
  }
  references(id: string): ObjectiveReference[] {
    const references: ObjectiveReference[] = [];
    for (const row of this.database.all(`SELECT n.* FROM attempt_numbers n JOIN tasks t ON t.id = n.task WHERE t.objective_id = ? ORDER BY n.context,n.task,n.number`, id)) {
      const ref = { contextId: String(row.context), taskId: String(row.task), attempt: Number(row.number) };
      const attempts = new AttemptStore(this.database, ref.contextId, this.caller);
      const live = attempts.findForTask(ref.taskId, ref.attempt);
      const archive = live ? undefined : this.database.get("SELECT summary FROM archived_attempts WHERE context = ? AND task = ? AND attempt = ?", ref.contextId, ref.taskId, ref.attempt);
      const saved = archive ? JSON.parse(String(archive.summary)) : undefined;
      const accepted: string[] = live ? attempts.acceptedCommits(ref) : saved?.acceptedCommits ?? (saved?.confirmations ?? []).filter((c: { fact: string }) => c.fact === "output_accepted").map((c: { scope: { commit: string } }) => c.scope.commit);
      for (const commit of accepted) references.push({ kind: "accepted_commit", ...ref, commit });
      const reviews = live ? live.entries.filter(entry => entry.kind === "review_recorded").map(entry => entry.data) : saved?.reviews ?? [];
      for (const data of reviews) {
        const review = reviewRecordSchema.parse(data);
        references.push({ kind: "review", ...ref, commit: review.commit, reviewTaskId: review.taskId, reviewAttempt: review.attempt });
      }
    }
    return references;
  }
  private record(id: string, action: string, before: Objective | null, after: Objective, now: string) {
    const changes = Object.fromEntries((Object.keys(after) as (keyof Objective)[]).filter(key => JSON.stringify(before?.[key]) !== JSON.stringify(after[key]))
      .map(key => [key, { before: before?.[key] ?? null, after: after[key] }]));
    this.database.run(`INSERT INTO objective_changes VALUES(?,(SELECT coalesce(max(sequence),0)+1 FROM objective_changes WHERE objective = ?),?,?,?,?)`,
      id, id, action, this.actor, now, JSON.stringify(changes));
    this.recordEvent(id);
    recordBudgetEvents(this.database, id);
  }
  private recordEvent(id: string) {
    const sequence = this.database.get("SELECT max(sequence) AS n FROM objective_changes WHERE objective = ?", id)!.n;
    recordPersonEvents(this.database, [id], `objective:${id}:${sequence}`);
  }
}
