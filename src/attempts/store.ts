import { isAbsolute } from "node:path";
import { attemptSpending, checkObjectiveBudget, objectiveBudget, type BudgetRefusal } from "../objectives/budget.ts";
import { requireRetainedStorage } from "../infra/storage.ts";
import { z } from "zod";
import { callerName, callerSchema, type Caller } from "../caller.ts";
import { latestChecks, type CheckCommand } from "./checks.ts";
import { recordedReviews } from "./reviews.ts";
import { requireAuthority, checkAcceptanceEvidence } from "../dispatch/safety.ts";
import { Database } from "../database.ts";
import { childExitSchema, type RuntimeBinding } from "../runtime/records.ts";
import { parseValidatedResult } from "../runtime/validated-result.ts";
import { reviewTargetSchema, validateWorkerResult, type ReviewTarget } from "../runtime/contracts.ts";
import { TaskStoreError, type Task, type TaskState } from "../tasks/store.ts";
import { attemptSpecificationSchema, startingPointSchema, storedSpecificationSchema, type AttemptSpecification, type StartingPoint } from "./specification.ts";
import { requestFingerprint, type RequestInputs } from "./requests.ts";
import { parseAttemptEntry, type AttemptEntry, type AttemptRecord, type AttemptRef, type EntryData, type EntryKind } from "./log.ts";
import { readQuestions } from "../runtime/questions-store.ts";
import { observeBudgetEvents, recordEntryEvents, recordEvent, recordPersonEvents, taskObjective } from "../supervise/events.ts";
import { interventionEntry } from "../objectives/interventions.ts";

const nonempty = z.string().trim().min(1);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const confirmationSchema = z.discriminatedUnion("fact", [
  z.strictObject({ fact: z.literal("owner_read_reconciled"), scope: z.strictObject({ failureSequence: z.number().int().nonnegative(), outcome: z.enum(["happened", "not_happened"]), returnId: z.uuid().optional() }) }),
  z.strictObject({ fact: z.literal("no_processes"), scope: z.strictObject({ leaseId: nonempty, returnId: z.uuid() }) }),
  z.strictObject({ fact: z.literal("output_accepted"), scope: z.union([z.strictObject({ commit }), z.strictObject({ commit, rebasedFrom: commit, onto: commit })]) }),
  z.strictObject({ fact: z.literal("discard"), scope: z.strictObject({ leaseId: nonempty }) }),
  z.strictObject({ fact: z.literal("worker_stopped"), scope: z.strictObject({ leaseId: nonempty, sessionId: z.uuid().optional() }) }),
  z.strictObject({ fact: z.literal("lease_returned"), scope: z.strictObject({ outputBranch: nonempty, leaseId: nonempty.optional() }) }),
]);
export type Confirmation = z.infer<typeof confirmationSchema>;
export type ConfirmationRecord = AttemptRef & Confirmation & { confirmedBy: string; confirmedAt: string };
export type PendingDeletion = AttemptRef & { directory: string };
export type ArchivedOutputBranch = AttemptRef & {
  branch: string; repository: string; commit?: string | undefined; targetBranch?: string | undefined; discarded: boolean;
};
export type ArchivedRequest = AttemptRef & { archived: true; summary: Record<string, unknown> };
export type StartingPointEvidence = {
  records: AttemptRecord[];
  unknown: string[];
  retainedCommit?: string;
};
type ExpectedTask = Pick<Task, "state" | "holdReason" | "holdRevision">;
const identity = (ref: AttemptRef): AttemptRef => ({ contextId: ref.contextId, taskId: ref.taskId, attempt: ref.attempt });

export class AttemptStoreError extends Error {
  readonly reason: BudgetRefusal["reason"] | "not_ready" | "capacity" | "request_reserved" | "request_input_mismatch" | "attempt_closed" | "task_changed" | "attempt_changed" | "task_definition_changed" | "specification_incomplete" | "starting_point_wrong_task" | "starting_point_unknown" | "possibly_running" | "output_not_recorded" | "not_retained" | "attempt_limit";
  readonly nextAction: "inspect_attempt" | "stop_worker" | "fix_or_discard" | "review_objective_budget";
  constructor(reason: AttemptStoreError["reason"], message: string, nextAction: AttemptStoreError["nextAction"] = "inspect_attempt") {
    super(message); this.reason = reason; this.nextAction = nextAction;
  }
}

/** Transactional task/attempt operations. External checks and directory deletion belong to the caller. */
export class AttemptStore {
  readonly database: Database;
  readonly contextId: string;
  readonly caller: Caller;
  readonly checks: Pick<CheckCommand, "name">[];
  constructor(database: Database, contextId: string, caller: Caller, checks: Pick<CheckCommand, "name">[] = []) {
    this.database = database; this.contextId = nonempty.parse(contextId); this.caller = callerSchema.parse(caller); this.checks = checks;
  }

  async checkStorage(roots: string[]): Promise<void> { await requireRetainedStorage(this.database.path, roots); }
  async forTask(taskId: string): Promise<AttemptRecord[]> {
    return this.database.all("SELECT number FROM attempts WHERE context = ? AND task = ? AND number IS NOT NULL ORDER BY number", this.contextId, taskId)
      .map(row => this.read({ contextId: this.contextId, taskId, attempt: Number(row.number) }));
  }
  async findByLease(leaseId: string): Promise<AttemptRecord | undefined> {
    const row = this.database.get(`SELECT task, attempt FROM attempt_entries WHERE context = ?
      AND json_extract(entry, '$.kind') IN ('leased', 'halted') AND json_extract(entry, '$.data.leaseId') = ?`, this.contextId, leaseId);
    return row ? this.read({ contextId: this.contextId, taskId: String(row.task), attempt: Number(row.attempt) }) : undefined;
  }
  findForTask(taskId: string, attempt?: number): AttemptRecord | undefined {
    const number = attempt ?? this.latestNumber(taskId);
    if (number === undefined || !this.database.get("SELECT 1 FROM attempts WHERE context = ? AND task = ? AND number = ?", this.contextId, taskId, number)) return undefined;
    return this.read({ contextId: this.contextId, taskId, attempt: number });
  }
  latestNumber(taskId: string): number | undefined {
    const row = this.database.get("SELECT max(number) AS n FROM attempts WHERE context = ? AND task = ?", this.contextId, taskId);
    return row?.n == null ? undefined : Number(row.n);
  }
  taskAttemptCount(taskId: string): number {
    return Number(this.database.get("SELECT count(*) AS n FROM attempt_numbers WHERE task = ?", taskId)!.n);
  }
  activeCount(): number {
    return Number(this.database.get("SELECT count(*) AS n FROM attempts WHERE context = ? AND number IS NOT NULL AND closed = 0", this.contextId)!.n);
  }
  async findByRequest(requestId: string, inputs?: RequestInputs): Promise<AttemptRecord | ArchivedRequest | undefined> {
    const row = this.request(requestId, inputs);
    if (!row) return undefined;
    if (row.attempt === null) throw new AttemptStoreError("request_reserved", "The request ID was imported without an attempt");
    const ref = { contextId: this.contextId, taskId: String(row.task), attempt: Number(row.attempt) };
    if (!row.archived) return this.read(ref);
    const archive = this.database.get("SELECT summary FROM archived_attempts WHERE context = ? AND task = ? AND attempt = ?", ref.contextId, ref.taskId, ref.attempt);
    if (!archive) throw new Error("The request record's archived attempt is missing");
    return { ...ref, archived: true, summary: JSON.parse(String(archive.summary)) };
  }

  private request(requestId: string, inputs?: RequestInputs) {
    nonempty.parse(requestId);
    const row = this.database.get("SELECT * FROM request_records WHERE context = ? AND request_id = ?", this.contextId, requestId);
    if (row && inputs) {
      if ((row.encoding_version === 1 && row.fingerprint !== requestFingerprint(inputs)) ||
        (row.encoding_version === 0 && inputs.taskId !== undefined && inputs.taskId !== row.task)) {
        throw new AttemptStoreError("request_input_mismatch", "The request ID has already been used with different explicit inputs");
      }
      if (row.encoding_version === 0) throw new AttemptStoreError("request_reserved", "The historical request ID is reserved, but its explicit inputs were not retained; inspect its original attempt");
    }
    return row;
  }

  async reserveAttempt(options: {
    taskId: string; requested: EntryData<"requested">; maximum: number; repo?: string | null;
    definitionRevision?: number;
    requestInputs?: RequestInputs;
    maximumPerTask?: number;
    dryRun?: boolean;
    startingPoint?: StartingPoint;
    startingPointEvidence?: StartingPointEvidence;
    reviewEvidence?: StartingPointEvidence;
    specification: (task: Task, ref: AttemptRef) => AttemptSpecification;
  }): Promise<{ created: boolean; ref: AttemptRef }> {
    z.number().int().positive().parse(options.maximum);
    const maximumPerTask = z.number().int().positive().parse(options.maximumPerTask ?? 3);
    const startingPoint = options.startingPoint && startingPointSchema.parse(options.startingPoint);
    const inputs = { ...(options.requestInputs ?? { taskId: options.taskId }), ...(startingPoint ? { startingPoint } : {}) };
    if (!options.dryRun) {
      await this.database.transaction(() => {
        requireAuthority(this.database, this.caller, "dispatch", { taskId: options.taskId });
        const objectiveId = taskObjective(this.database, options.taskId);
        if (objectiveId !== null) observeBudgetEvents(this.database, objectiveId);
      });
    }
    if (!startingPoint && inputs.startingPoint) throw new Error("Starting-point inputs require a starting point");
    if (startingPoint && !options.requested.requestId) throw new Error("Starting from an earlier attempt requires a stable request ID");
    return this.database.transaction(() => {
      requireAuthority(this.database, this.caller, "dispatch", { taskId: options.taskId });
      if (startingPoint) requireAuthority(this.database, this.caller, "continueAttempts", { taskId: options.taskId });
      const requestId = options.requested.requestId;
      if (requestId !== undefined) {
        nonempty.parse(requestId);
        const existing = this.request(requestId, inputs);
        if (existing) {
          if (existing.attempt === null) throw new AttemptStoreError("request_reserved", "The request ID was imported without an attempt");
          return { created: false, ref: { contextId: this.contextId, taskId: String(existing.task), attempt: Number(existing.attempt) } };
        }
      }
      const total = this.taskAttemptCount(options.taskId);
      if (total >= maximumPerTask) throw new AttemptStoreError("attempt_limit", `Task ${options.taskId} has reached its limit of ${maximumPerTask} attempts; review the earlier attempts before raising maxAttemptsPerTask`);
      const source = startingPoint ? this.checkStartingPoint(options.taskId, startingPoint, options.startingPointEvidence) : undefined;
      const count = this.activeCount();
      if (count >= options.maximum) throw new AttemptStoreError("capacity", "The context's attempt maximum has been reached");
      const task = this.task(options.taskId);
      if (!task || (options.repo != null && task.repo !== options.repo) || task.state !== "queued" || task.held || task.blocked ||
        this.database.get("SELECT 1 FROM attempts WHERE task = ? AND number IS NOT NULL AND closed = 0", options.taskId)) {
        throw new AttemptStoreError("not_ready", `Task ${options.taskId} is not available for an attempt`);
      }
      if (options.definitionRevision !== undefined && task.definitionRevision !== options.definitionRevision) {
        throw new AttemptStoreError("task_changed", "The task definition changed before reservation");
      }
      if (task.objectiveId !== null) {
        const refusal = checkObjectiveBudget(task.objectiveId, objectiveBudget(this.database, task.objectiveId));
        if (refusal) throw new AttemptStoreError(refusal.reason, refusal.detail, "review_objective_budget");
      }
      const number = Number(this.database.get("SELECT coalesce(max(number), 0) + 1 AS n FROM attempt_numbers WHERE context = ? AND task = ?", this.contextId, options.taskId)!.n);
      const ref = { contextId: this.contextId, taskId: options.taskId, attempt: number };
      if (options.dryRun) return { created: false, ref };
      this.database.run("INSERT INTO attempt_numbers VALUES(?,?,?)", ref.contextId, ref.taskId, ref.attempt);
      this.database.run("INSERT INTO attempts(context,task,number,request_id,reserved_at) VALUES(?,?,?,?,?)",
        ref.contextId, ref.taskId, ref.attempt, null, new Date().toISOString());
      if (requestId !== undefined) this.database.run("INSERT INTO request_records VALUES(?,?,?,?,?,?,?,0)", ref.contextId, requestId, ref.taskId, ref.attempt,
        new Date().toISOString(), 1, requestFingerprint(inputs));
      this.insert(ref, "requested", options.requested);
      const supplied = options.specification(task, ref);
      if (!source && supplied.startingPoint) throw new Error("A starting point requires a checked reservation");
      const review = this.reviewTask(task.id);
      if (review) {
        if (source) throw new Error("A review cannot start from another attempt");
        this.checkReviewSource(review.target, options.reviewEvidence);
        if (task.kind !== "review" || JSON.stringify(task.acceptanceCriteria) !== JSON.stringify(review.acceptanceCriteria) ||
          supplied.backingRepository !== review.backingRepository) throw new Error("The review task no longer matches its recorded target");
      } else if (supplied.reviewTarget) throw new Error("A review target requires a recorded review task");
      const specification = attemptSpecificationSchema.parse({ ...supplied, ...(source ? { startingPoint: source } : {}), ...(review ? { reviewTarget: review.target } : {}) });
      if (source) {
        const previous = this.findForTask(source.taskId, source.attempt)!;
        if (specification.outputBranch === previous.specification?.outputBranch || specification.outputBranch === previous.allocation?.outputBranch) {
          throw new Error("A new attempt must have its own output branch");
        }
      }
      if (specification.taskId !== task.id || specification.contextId !== ref.contextId || specification.definitionRevision !== task.definitionRevision ||
        specification.title !== task.title || specification.instructions !== (task.body.trim() === "" ? task.title : task.body) ||
        specification.repository !== task.repo || specification.kind !== task.kind ||
        specification.objectiveId !== undefined && specification.objectiveId !== task.objectiveId) throw new Error("Specification differs from the reserved task");
      this.database.run("INSERT INTO attempt_specifications VALUES(?,?,?,?)", ref.contextId, ref.taskId, ref.attempt, JSON.stringify(specification));
      return { created: true, ref };
    });
  }

  async startReservedTask(ref: AttemptRef): Promise<Task> {
    const started = await this.database.transaction(() => {
      requireAuthority(this.database, this.caller, "dispatch", { taskId: ref.taskId });
      this.requireOpen(ref);
      const task = this.task(ref.taskId);
      const record = this.read(ref);
      const parsed = attemptSpecificationSchema.safeParse(record.specification);
      if (!parsed.success) throw new AttemptStoreError("specification_incomplete", "The stored attempt specification is incomplete; resolve this attempt before dispatching again");
      if (task && task.definitionRevision !== parsed.data.definitionRevision) {
        if (task.state === "queued" && !task.held) this.writeOutcome(ref.taskId, "hold", "task_definition_changed");
        this.insert(ref, "halted", { stage: "start", reason: "task_definition_changed", detail: "The task definition changed during acquisition; return the unused lease, then release the task and dispatch a new attempt" });
        this.closeAttempt(ref);
        return undefined;
      }
      if (!task || task.state !== "queued" || task.held || task.blocked) throw new AttemptStoreError("not_ready", "The task stopped being ready");
      const entries = record.entries;
      if (!entries.some(e => e.kind === "leased") || entries.some(e => e.kind === "task_started")) {
        throw new AttemptStoreError("not_ready", "Starting requires a lease and an attempt that has not started");
      }
      this.database.run("UPDATE tasks SET state = 'in_flight', started_hold_revision = hold_revision WHERE id = ?", ref.taskId);
      this.insert(ref, "task_started", {});
      return this.task(ref.taskId)!;
    });
    if (!started) throw new AttemptStoreError("task_definition_changed", "The task definition changed during acquisition; return the unused lease, then release the task and dispatch a new attempt");
    return started;
  }

  async recordOutcome(ref: AttemptRef, outcome: Required<Pick<EntryData<"task_recorded">, "outcome" | "reason" | "category">>): Promise<{ task: Task; applied: boolean }> {
    return this.database.transaction(() => {
      this.requireOpen(ref);
      requireAuthority(this.database, this.caller, outcome.outcome === "done" ? "completeTasks" : "recordAttempt", { taskId: ref.taskId });
      if (outcome.outcome === "done") this.checkAcceptance(ref, this.startingPointCommit(this.read(ref)));
      if (!this.read(ref).entries.some(e => e.kind === "task_started")) throw new AttemptStoreError("not_ready", "The attempt has not started its task");
      const row = this.database.get("SELECT state, hold_revision, started_hold_revision FROM tasks WHERE id = ?", ref.taskId)!;
      const applied = row.state === "in_flight" && row.hold_revision === row.started_hold_revision;
      if (applied) this.writeOutcome(ref.taskId, outcome.outcome, outcome.reason);
      this.recordReview(ref);
      this.insert(ref, "task_recorded", { ...outcome, applied });
      this.closeAttempt(ref);
      return { task: this.task(ref.taskId)!, applied };
    });
  }

  async finishAttempt(ref: AttemptRef, expected: ExpectedTask, expectedRecord?: AttemptRecord, reviewRetained?: boolean): Promise<Task> {
    return this.database.transaction(() => {
      this.requireAttempt(ref);
      if (expectedRecord) this.expectRecord(expectedRecord);
      requireAuthority(this.database, this.caller, "completeTasks", { taskId: ref.taskId });
      this.checkAcceptance(ref, this.startingPointCommit(this.read(ref)));
      this.expectTask(ref.taskId, expected);
      this.writeOutcome(ref.taskId, "done", "finished");
      this.recordReview(ref, reviewRetained);
      this.insert(ref, "task_recorded", { outcome: "done", reason: "finished", category: "done", applied: true });
      this.closeAttempt(ref);
      return this.task(ref.taskId)!;
    });
  }

  async discardAttempt(ref: AttemptRef, expected: ExpectedTask, leaseId: string, note?: string, expectedRecord?: AttemptRecord): Promise<Task> {
    return this.database.transaction(() => {
      this.requireAttempt(ref);
      if (expectedRecord) this.expectRecord(expectedRecord);
      requireAuthority(this.database, this.caller, "returnLease", { taskId: ref.taskId });
      const task = this.expectTask(ref.taskId, expected);
      this.confirm(ref, { fact: "discard", scope: { leaseId } });
      if (task.state !== "done") this.writeOutcome(ref.taskId, "hold", `Switchboard attempt ${ref.attempt} discarded`);
      this.insert(ref, "discarded", note === undefined ? {} : { note });
      this.closeAttempt(ref);
      return this.task(ref.taskId)!;
    });
  }

  async append<K extends EntryKind>(ref: AttemptRef, kind: K, data: EntryData<K>): Promise<void> {
    if (["requested", "task_started", "task_recorded", "discarded", "output_accepted", "lease_return_started", "operator_resolved", "review_recorded"].includes(kind)) throw new Error("Use the transactional task/attempt operation");
    await this.database.transaction(() => {
      this.requireAttempt(ref);
      if (kind === "leased" && this.read(ref).entries.some(e => e.kind === "leased")) throw new Error("An attempt's allocation cannot be changed");
      if (kind === "lease_returned") {
        const value = data as EntryData<"lease_returned">;
        const intended = this.read(ref).entries.some(e => e.kind === "lease_return_started" && e.data.leaseId === value.leaseId && e.data.returnId === value.returnId && e.data.by === value.by);
        const confirmed = this.confirmations(ref).some(c => c.fact === "no_processes" && c.scope.leaseId === value.leaseId && c.scope.returnId === value.returnId);
        if (!intended || !confirmed) throw new Error("Lease return has no matching intent and confirmation");
      }
      this.insert(ref, kind, data);
      if (kind === "halted") this.closeAttempt(ref);
    });
  }

  async appendConfirmed<K extends "output_accepted" | "lease_return_started" | "operator_resolved">(ref: AttemptRef, kind: K, data: EntryData<K>, confirmation: Confirmation, expectedRecord?: AttemptRecord): Promise<void> {
    await this.database.transaction(() => {
      this.requireAttempt(ref);
      if (expectedRecord) this.expectRecord(expectedRecord);
      const payload = data as Record<string, unknown>;
      const matches = kind === "output_accepted" ? confirmation.fact === "output_accepted" && confirmation.scope.commit === payload.commit &&
          ("rebasedFrom" in confirmation.scope ? confirmation.scope.rebasedFrom === payload.rebasedFrom && confirmation.scope.onto === payload.onto : payload.rebasedFrom === undefined && payload.onto === undefined)
        : kind === "lease_return_started" ? confirmation.fact === "no_processes" && confirmation.scope.leaseId === payload.leaseId && confirmation.scope.returnId === payload.returnId
        : confirmation.fact === payload.action;
      if (!matches) throw new Error("The confirmation does not name this operation");
      if (kind === "lease_return_started" && this.read(ref).entries.some(e => e.kind === "lease_return_started" && e.data.returnId === payload.returnId)) {
        throw new Error("Each lease return requires its own confirmation");
      }
      if (confirmation.fact === "owner_read_reconciled") {
        const record = this.read(ref);
        const failure = record.entries.find(e => e.sequence === confirmation.scope.failureSequence && e.kind === "owner_read_failed" && e.data.classification === "effect_uncertain");
        const intent = [...record.entries].reverse().find(e => e.sequence < confirmation.scope.failureSequence && (e.kind === "lease_return_started" || e.kind === "integration_started" || e.kind === "rebase_started"));
        if (intent?.kind === "rebase_started") requireAuthority(this.database, this.caller, "rebase", { taskId: ref.taskId });
        if (!failure || typeof payload.note !== "string" || !payload.note.trim() ||
          confirmation.scope.returnId !== (intent?.kind === "lease_return_started" ? intent.data.returnId : undefined)) throw new Error("The confirmation does not name this failure and its effect");
        if (record.entries.some(e => e.kind === "owner_read_reconciled" && e.data.failureSequence === confirmation.scope.failureSequence) ||
          record.confirmations?.some(c => c.fact === "owner_read_reconciled" && c.scope.failureSequence === confirmation.scope.failureSequence)) {
          throw new AttemptStoreError("attempt_changed", "The read failure was already reconciled");
        }
      }
      this.confirm(ref, confirmation);
      this.insert(ref, kind, data);
      if (kind === "operator_resolved") this.closeAttempt(ref);
    });
  }

  /** The successful owner read and its integration record must not be separated by a crash. */
  async reconcileIntegration(ref: AttemptRef, failureSequence: number, targetBranch: string, commit: string): Promise<void> {
    await this.database.transaction(() => {
      const record = this.read(ref);
      const failed = record.entries.find(e => e.sequence === failureSequence && e.kind === "owner_read_failed" && e.data.classification === "effect_uncertain");
      const intent = [...record.entries].reverse().find(e => e.sequence < failureSequence && e.kind === "integration_started");
      if (!failed || intent?.data.targetBranch !== targetBranch || intent.data.commit !== commit) throw new Error("The reconciliation does not name this integration's failed read");
      if (!record.entries.some(e => e.kind === "owner_read_reconciled" && e.data.failureSequence === failureSequence)) {
        this.insert(ref, "owner_read_reconciled", { failureSequence, targetBranch, commit });
      }
      if (!record.entries.some(e => e.kind === "integrated" && e.data.targetBranch === targetBranch && e.data.commit === commit)) {
        this.insert(ref, "integrated", { policy: "local-merge", targetBranch, commit });
      }
    });
  }

  async recordConfirmation(ref: AttemptRef, confirmation: Confirmation): Promise<void> {
    await this.database.transaction(() => { this.requireAttempt(ref); this.confirm(ref, confirmation); });
  }

  confirmations(ref: AttemptRef): ConfirmationRecord[] {
    this.checkContext(ref);
    return this.database.all("SELECT fact, scope, confirmed_by, confirmed_at FROM confirmations WHERE context = ? AND task = ? AND attempt = ? ORDER BY id",
      ref.contextId, ref.taskId, ref.attempt).map(row => ({
      ...identity(ref), ...confirmationSchema.parse({ fact: row.fact, scope: JSON.parse(String(row.scope)) }),
      confirmedBy: String(row.confirmed_by), confirmedAt: String(row.confirmed_at),
    }));
  }

  read(ref: AttemptRef): AttemptRecord {
    this.requireAttempt(ref);
    const entries = this.database.all("SELECT entry FROM attempt_entries WHERE context = ? AND task = ? AND attempt = ? ORDER BY sequence",
      ref.contextId, ref.taskId, ref.attempt).map(row => parseAttemptEntry(JSON.parse(String(row.entry))));
    if (entries.length === 0 || entries[0]!.kind !== "requested" || entries.some((entry, sequence) => entry.sequence !== sequence ||
      (sequence > 0 && entry.kind === "requested") || entry.contextId !== ref.contextId || entry.taskId !== ref.taskId || entry.attempt !== ref.attempt)) throw new Error("Inconsistent attempt entries");
    const row = this.database.get("SELECT specification FROM attempt_specifications WHERE context = ? AND task = ? AND attempt = ?", ref.contextId, ref.taskId, ref.attempt);
    const allocation = entries.find(e => e.kind === "leased");
    const files = readQuestions(this.database, ref);
    return { ...identity(ref), entries, confirmations: this.confirmations(ref),
      ...(files.questions.length ? { questions: files.questions } : {}),
      ...(files.invalid.length ? { invalidQuestionFiles: files.invalid } : {}),
      ...(row ? { specification: storedSpecificationSchema.parse(JSON.parse(String(row.specification))) } : {}),
      ...(allocation ? { allocation: allocation.data as EntryData<"leased"> } : {}),
    };
  }

  list(): AttemptRecord[] {
    return this.database.all("SELECT task, number FROM attempts WHERE context = ? AND number IS NOT NULL ORDER BY task, number", this.contextId)
      .map(row => this.read({ contextId: this.contextId, taskId: String(row.task), attempt: Number(row.number) }));
  }

  archivedOutputBranches(): ArchivedOutputBranch[] {
    return this.database.all("SELECT task, attempt, summary FROM archived_attempts WHERE context = ? ORDER BY task, attempt", this.contextId).flatMap(row => {
      const archive = JSON.parse(String(row.summary));
      const branch = archive.allocation?.outputBranch ?? archive.summary?.outputBranch;
      if (!branch) return [];
      const accepted = [...(archive.confirmations ?? [])].reverse().find(c => c.fact === "output_accepted");
      return [{ contextId: this.contextId, taskId: String(row.task), attempt: Number(row.attempt), branch,
        repository: archive.allocation?.backingRepository ?? archive.specification?.backingRepository,
        commit: archive.outputBranchRecord?.commit ?? accepted?.scope.commit ?? archive.summary?.resultCommit,
        targetBranch: archive.outputBranchRecord?.targetBranch ?? archive.allocation?.baseRef ?? archive.specification?.baseRef,
        discarded: archive.outputBranchRecord?.discarded ?? false }];
    });
  }

  async appendArchivedOutputBranchCleanup(ref: AttemptRef, data: EntryData<"output_branch_cleanup">): Promise<void> {
    await this.database.transaction(() => {
      requireAuthority(this.database, this.caller, "returnLease", { taskId: ref.taskId });
      const row = this.database.get("SELECT summary FROM archived_attempts WHERE context = ? AND task = ? AND attempt = ?", ref.contextId, ref.taskId, ref.attempt);
      if (!row) throw new Error("The branch cleanup archive is missing");
      const archive = JSON.parse(String(row.summary));
      const entries = archive.outputBranchCleanup ??= [];
      entries.push({ sequence: entries.length, recordedAt: new Date().toISOString(), askedBy: callerName(this.caller), ...data });
      this.database.run("UPDATE archived_attempts SET summary = ? WHERE context = ? AND task = ? AND attempt = ?", JSON.stringify(archive), ref.contextId, ref.taskId, ref.attempt);
    });
  }

  async archiveAttempt(expected: AttemptRecord, summary: Record<string, unknown>, directories: string[], expectedTask?: { state: string; held: boolean; holdReason: string | null }): Promise<void> {
    if (directories.some(directory => !isAbsolute(directory))) throw new Error("Deletion paths must be absolute");
    await this.database.transaction(() => {
      requireAuthority(this.database, this.caller, "prune", { taskId: expected.taskId });
      const current = this.expectRecord(expected);
      if (expectedTask) {
        const task = this.task(expected.taskId);
        if (!task || task.state !== expectedTask.state || task.held !== expectedTask.held || task.holdReason !== expectedTask.holdReason) {
          throw new AttemptStoreError("task_changed", "The task changed after the archive was planned");
        }
      }
      const row = this.requireAttempt(expected);
      if (!row.closed) throw new AttemptStoreError("attempt_changed", "An open attempt cannot be archived");
      const reservation = this.database.get("SELECT request_id, reserved_at FROM request_records WHERE context = ? AND task = ? AND attempt = ?",
        expected.contextId, expected.taskId, expected.attempt);
      const archive = {
        ...identity(expected), summary, spending: attemptSpending(this.database, expected), entryCount: current.entries.length, finishedAt: current.entries.at(-1)!.recordedAt,
        archivedAt: new Date().toISOString(), archivedBy: callerName(this.caller), confirmations: this.confirmations(expected), acceptedCommits: this.acceptedCommits(expected),
        interventionEntries: current.entries.filter(interventionEntry),
        controlRequests: this.database.all(`SELECT r.* FROM control_requests r JOIN worker_claims c ON c.id = r.claim_id
          WHERE c.context = ? AND c.task = ? AND c.attempt = ? ORDER BY r.created_at,r.id`, expected.contextId, expected.taskId, expected.attempt),
        checks: latestChecks(current, this.startingPointCommit(expected)),
        retention: [...current.entries].reverse().find(entry => entry.kind === "retention_checked") ?? null,
        outputBranchRecord: { commit: this.startingPointCommit(expected),
          targetBranch: [...current.entries].reverse().find(e => e.kind === "integrated")?.data.targetBranch ?? current.allocation?.baseRef ?? current.specification?.baseRef,
          discarded: current.entries.some(e => e.kind === "discarded") },
        outputBranchCleanup: current.entries.filter(e => e.kind === "output_branch_cleanup").map((e, sequence) => ({ sequence, recordedAt: e.recordedAt, askedBy: e.askedBy, ...e.data })),
        ...(current.entries.some(e => e.kind === "owner_read_failed") ? { readFailures: current.entries.filter(e => e.kind === "owner_read_failed" || e.kind === "owner_read_reconciled") } : {}),
        ...(current.specification ? { specification: current.specification } : {}), ...(current.allocation ? { allocation: current.allocation } : {}),
        ...(current.entries.some(entry => entry.kind === "review_recorded") ? { reviews: current.entries.filter(entry => entry.kind === "review_recorded").map(entry => entry.data) } : {}),
        ...(reservation ? { reservation: { requestId: reservation.request_id, reservedAt: reservation.reserved_at } } : {}),
      };
      const existing = this.database.get("SELECT summary FROM archived_attempts WHERE context = ? AND task = ? AND attempt = ?", expected.contextId, expected.taskId, expected.attempt);
      if (existing) {
        const previous = JSON.parse(String(existing.summary)) as { finishedAt: string };
        if (previous.finishedAt !== archive.finishedAt) throw new AttemptStoreError("attempt_changed", "The attempt changed after its earlier archive");
      } else this.database.run("INSERT INTO archived_attempts VALUES(?,?,?,?)", expected.contextId, expected.taskId, expected.attempt, JSON.stringify(archive));
      for (const directory of new Set(directories)) this.database.run("INSERT INTO pending_attempt_deletions VALUES(?,?,?,?)", expected.contextId, expected.taskId, expected.attempt, directory);
      this.database.run("UPDATE request_records SET archived = 1 WHERE context = ? AND task = ? AND attempt = ?", expected.contextId, expected.taskId, expected.attempt);
      this.database.run("DELETE FROM attempts WHERE context = ? AND task = ? AND number = ?", expected.contextId, expected.taskId, expected.attempt);
    });
  }

  pendingDeletions(): PendingDeletion[] {
    return this.database.all("SELECT task, attempt, directory FROM pending_attempt_deletions WHERE context = ? ORDER BY task, attempt, directory", this.contextId)
      .map(row => ({ contextId: this.contextId, taskId: String(row.task), attempt: Number(row.attempt), directory: String(row.directory) }));
  }

  /** Cleanup evidence survives archiving, when the live attempt entries no longer exist. */
  cleanupEntries(deletion: PendingDeletion): { sequence: number; kind: string; data: Record<string, unknown> }[] {
    this.checkContext(deletion);
    const row = this.database.get("SELECT summary FROM archived_attempts WHERE context = ? AND task = ? AND attempt = ?", deletion.contextId, deletion.taskId, deletion.attempt);
    const archive = row ? JSON.parse(String(row.summary)) : {};
    return archive.cleanup?.[deletion.directory] ?? [];
  }

  async appendCleanup(deletion: PendingDeletion, kind: "deletion_started" | "deletion_confirmed" | "owner_read_failed", data: Record<string, unknown>): Promise<void> {
    this.checkContext(deletion);
    await this.database.transaction(() => {
      requireAuthority(this.database, this.caller, "prune", { taskId: deletion.taskId });
      const row = this.database.get("SELECT summary FROM archived_attempts WHERE context = ? AND task = ? AND attempt = ?", deletion.contextId, deletion.taskId, deletion.attempt);
      if (!row) throw new Error("The cleanup archive is missing");
      const archive = JSON.parse(String(row.summary));
      archive.cleanup ??= {};
      const entries = archive.cleanup[deletion.directory] ??= [];
      const sequence = entries.length, recordedAt = new Date().toISOString();
      entries.push({ sequence, kind, recordedAt, askedBy: callerName(this.caller), data });
      this.database.run("UPDATE archived_attempts SET summary = ? WHERE context = ? AND task = ? AND attempt = ?", JSON.stringify(archive), deletion.contextId, deletion.taskId, deletion.attempt);
      if (kind === "owner_read_failed") recordEvent(this.database, taskObjective(this.database, deletion.taskId),
        `cleanup:${JSON.stringify([deletion.contextId, deletion.taskId, deletion.attempt, deletion.directory, sequence])}`, "decision_needed", recordedAt,
        { directory: deletion.directory, ...data }, deletion);
    });
  }

  /** Called only after the caller has removed the directory or found it absent. */
  async completeDeletion(deletion: PendingDeletion): Promise<void> {
    this.checkContext(deletion);
    await this.database.transaction(() => {
      requireAuthority(this.database, this.caller, "prune", { taskId: deletion.taskId });
      this.database.run("DELETE FROM pending_attempt_deletions WHERE context = ? AND task = ? AND attempt = ? AND directory = ?",
        deletion.contextId, deletion.taskId, deletion.attempt, deletion.directory);
    });
  }

  reviewTask(taskId: string): { target: ReviewTarget; acceptanceCriteria: string[]; backingRepository: string } | undefined {
    const row = this.database.get("SELECT * FROM review_tasks WHERE task = ?", taskId);
    if (!row) return undefined;
    if (row.context !== this.contextId) throw new Error("The review task belongs to another context");
    return { target: reviewTargetSchema.parse(JSON.parse(String(row.target))),
      acceptanceCriteria: JSON.parse(String(row.acceptance_criteria)), backingRepository: String(row.backing_repository) };
  }

  async createReviewTask(taskId: string, target: ReviewTarget, evidence: StartingPointEvidence): Promise<Task> {
    return this.database.transaction(() => {
      requireAuthority(this.database, this.caller, "manageTasks", { taskId: target.taskId });
      this.checkReviewSource(target, evidence);
      const source = this.read({ contextId: this.contextId, taskId: target.taskId, attempt: target.attempt });
      const specification = attemptSpecificationSchema.parse(source.specification);
      if (!/^[a-zA-Z0-9._-]+$/.test(taskId) || this.task(taskId)) throw new Error("The review task ID is invalid or already used");
      const instructions = [
        `Review task ${target.taskId}, attempt ${target.attempt}, at exact commit ${target.commit}.`,
        "Judge each acceptance criterion against that commit, not a later branch head. Report each as met or not_met in criteriaReport, with your findings in evidence.",
        "This is an independent review, not an implementation task. Do not repair the code or change the reviewed branch.",
        `Include a Git work reference named reviewed-output, branch ${target.outputBranch}, commit ${target.commit}.`,
        "Report completed when the review is complete, including when criteria are not met. Switchboard derives a passed verdict only when every criterion is met.",
        `Reviewed instructions:\n${specification.instructions}`,
      ].join("\n\n");
      const objectiveId = this.task(target.taskId)!.objectiveId;
      if (objectiveId !== null && this.database.get("SELECT state FROM objectives WHERE id = ?", objectiveId)?.state !== "open") {
        throw new Error(`Objective ${objectiveId} must be reopened before adding a review task`);
      }
      this.database.run(`INSERT INTO tasks(id,title,body,repo,kind,acceptance_criteria,objective_id,position)
        VALUES(?,?,?,?, 'review',?,?,(SELECT coalesce(max(position),0)+1 FROM tasks))`,
        taskId, `Review ${target.taskId} attempt ${target.attempt}`, instructions, specification.repository, JSON.stringify(specification.acceptanceCriteria), objectiveId);
      this.database.run("INSERT INTO review_tasks VALUES(?,?,?,?,?,?,?)", taskId, this.contextId, target.taskId, target.attempt, JSON.stringify(target),
        JSON.stringify(specification.acceptanceCriteria), specification.backingRepository);
      const added = this.task(taskId)!;
      const inserted = this.database.run("INSERT INTO task_changes(task,action,changed_by,changed_at,changes) VALUES(?,?,?,?,?)",
        taskId, "review", callerName(this.caller), new Date().toISOString(), JSON.stringify({ before: null, after: added }));
      recordPersonEvents(this.database, [objectiveId], `task:${inserted.lastInsertRowid}`);
      return added;
    });
  }

  private checkReviewSource(target: ReviewTarget, evidence?: StartingPointEvidence) {
    reviewTargetSchema.parse(target);
    const checked = this.checkStartingPoint(target.taskId, target, evidence);
    const source = this.read({ contextId: this.contextId, taskId: target.taskId, attempt: target.attempt });
    const sessionId = this.workerSession(source);
    if (checked.commit !== target.commit || source.allocation?.outputBranch !== target.outputBranch || sessionId !== target.sessionId) {
      throw new AttemptStoreError("attempt_changed", "The reviewed attempt no longer matches the exact recorded review target");
    }
  }

  /** Written with the review attempt's outcome, using only its immutable validated result. */
  private recordReview(ref: AttemptRef, reviewRetained?: boolean) {
    const review = this.read(ref);
    const target = review.specification?.reviewTarget;
    if (!target) return;
    const launch = this.database.get("SELECT directory, binding FROM launches WHERE context = ? AND task = ? AND attempt = ? AND kind = 'launch'", ref.contextId, ref.taskId, ref.attempt);
    if (!launch) return;
    const result = this.database.get("SELECT value FROM worker_observations WHERE directory = ? AND kind = 'validated_result'", String(launch.directory));
    const exit = this.database.get("SELECT value FROM worker_observations WHERE directory = ? AND kind = 'exit'", String(launch.directory));
    if (!result || !exit) return;
    const child = childExitSchema.parse(JSON.parse(String(exit.value)));
    if (!child.started || child.code !== 0 || child.signal !== null) return;
    const binding = JSON.parse(String(launch.binding)) as RuntimeBinding;
    const validated = validateWorkerResult(parseValidatedResult(JSON.parse(String(result.value)), binding).content, binding.input);
    const source = this.findForTask(target.taskId, target.attempt);
    if (!source || this.startingPointCommit(source) !== target.commit || review.allocation?.startingCommit !== target.commit ||
      binding.input.identity.sessionId === this.workerSession(source) || JSON.stringify(binding.input.reviewTarget) !== JSON.stringify(target) ||
      JSON.stringify(binding.input.acceptanceCriteria) !== JSON.stringify(review.specification!.acceptanceCriteria)) {
      throw new AttemptStoreError("attempt_changed", "The review does not name the reviewed attempt's exact output commit in a separate session");
    }
    if (source.entries.some(entry => entry.kind === "review_recorded" && entry.data.taskId === ref.taskId && entry.data.attempt === ref.attempt)) return;
    const retained = reviewRetained ?? [...review.entries].reverse().find(entry => entry.kind === "retention_checked")?.data.retained === true;
    const findings = validated.criteriaReport ?? [];
    this.insert(source, "review_recorded", { taskId: ref.taskId, attempt: ref.attempt, commit: target.commit,
      verdict: retained && validated.outcome === "completed" && findings.every(finding => finding.status === "met") ? "passed" : "failed", findings });
  }

  private workerSession(record: AttemptRecord): string | undefined {
    const launch = this.database.get("SELECT binding FROM launches WHERE context = ? AND task = ? AND attempt = ? AND kind = 'launch'", record.contextId, record.taskId, record.attempt);
    return launch ? (JSON.parse(String(launch.binding)) as RuntimeBinding).input.identity.sessionId
      : record.entries.find(entry => entry.kind === "launched")?.data.sessionId as string | undefined;
  }

  /** Only immutable, recorded output is a starting point – never today's branch head or result file. */
  startingPointCommit(ref: AttemptRef): string | undefined {
    const record = this.read(ref);
    const output = [...record.entries].reverse().find(e => e.kind === "output_rebased" || e.kind === "output_accepted" &&
      record.confirmations?.some(c => c.fact === "output_accepted" && c.scope.commit === e.data.commit));
    if (output) return output.data.commit as string;
    const launch = this.database.get("SELECT directory, binding FROM launches WHERE context = ? AND task = ? AND attempt = ? AND kind = 'launch'", ref.contextId, ref.taskId, ref.attempt);
    if (!launch) return undefined;
    const result = this.database.get("SELECT value FROM worker_observations WHERE directory = ? AND kind = 'validated_result'", String(launch.directory));
    if (!result) return undefined;
    const binding = JSON.parse(String(launch.binding)) as RuntimeBinding;
    const validated = parseValidatedResult(JSON.parse(String(result.value)), binding);
    const reference = validated.content.workReferences.find(w => w.kind === "git" && w.branch === binding.input.delivery.outputBranch);
    return reference?.kind === "git" ? reference.commit : undefined;
  }

  /** Commits explicitly accepted, integrated, or recorded done under the attempt's delivery contract. */
  acceptedCommits(ref: AttemptRef): string[] {
    const record = this.read(ref);
    const commits = record.entries.flatMap(entry => entry.kind === "integrated" ? [String(entry.data.commit)]
      : entry.kind === "output_accepted" && record.confirmations?.some(c => c.fact === "output_accepted" && c.scope.commit === entry.data.commit) ? [String(entry.data.commit)] : []);
    if (record.entries.some(entry => entry.kind === "task_recorded" && entry.data.outcome === "done" && entry.data.applied !== false)) {
      const commit = this.startingPointCommit(ref);
      if (commit) commits.push(commit);
    }
    return [...new Set(commits)];
  }

  private checkStartingPoint(taskId: string, point: StartingPoint, evidence?: StartingPointEvidence) {
    if (point.taskId !== taskId) throw new AttemptStoreError("starting_point_wrong_task", "The starting attempt belongs to another task; name an earlier attempt of this task");
    const source = this.findForTask(point.taskId, point.attempt);
    if (!source || !evidence || evidence.unknown.length) throw new AttemptStoreError("starting_point_unknown", evidence?.unknown.join("; ") || "The starting attempt's state is unknown; inspect its owner records");
    const current = this.list().filter(r => r.taskId === taskId);
    const expected = evidence.records.filter(r => r.taskId === taskId);
    if (current.length !== expected.length) throw new AttemptStoreError("attempt_changed", "The task's attempts changed before reservation; inspect them and retry");
    for (const record of expected) this.expectRecord(record);
    const taskRecords = this.database.all("SELECT context, number FROM attempts WHERE task = ? AND number IS NOT NULL", taskId)
      .map(row => new AttemptStore(this.database, String(row.context), this.caller, this.checks).read({ contextId: String(row.context), taskId, attempt: Number(row.number) }));
    for (const record of taskRecords) {
      const launch = this.database.get("SELECT * FROM launches WHERE context = ? AND task = ? AND attempt = ? AND kind = 'launch'", record.contextId, taskId, record.attempt);
      const leaseId = launch ? String(launch.lease_id) : record.allocation?.leaseId;
      const sessionId = launch ? (JSON.parse(String(launch.binding)) as RuntimeBinding).input.identity.sessionId : record.entries.find(e => e.kind === "launched")?.data.sessionId;
      const confirmed = record.confirmations?.some(c => c.fact === "worker_stopped" && c.scope.leaseId === leaseId &&
        (c.scope.sessionId === undefined || c.scope.sessionId === sessionId));
      const exit = launch && this.database.get("SELECT value FROM worker_observations WHERE directory = ? AND kind = 'exit'", String(launch.directory));
      const exited = exit && childExitSchema.safeParse(JSON.parse(String(exit.value))).success;
      if (!confirmed && !exited && (record.contextId === this.contextId && record.attempt === point.attempt || launch || record.entries.some(e => e.kind === "launched"))) {
        throw new AttemptStoreError("possibly_running", "A worker for this task has neither an observed exit nor a confirmed stop", "stop_worker");
      }
    }
    const output = this.startingPointCommit(source);
    if (!output) throw new AttemptStoreError("output_not_recorded", "The earlier attempt has no recorded output commit; inspect its result or explicitly accept its output");
    if (evidence.retainedCommit !== output) throw new AttemptStoreError("not_retained", "The earlier attempt's exact recorded output commit is not retained", "fix_or_discard");
    return { ...point, commit: output };
  }

  private expectRecord(expected: AttemptRecord): AttemptRecord {
    const current = this.read(expected);
    if (JSON.stringify(current.entries) !== JSON.stringify(expected.entries) || JSON.stringify(current.confirmations) !== JSON.stringify(expected.confirmations)) {
      throw new AttemptStoreError("attempt_changed", "The attempt changed after the operation was planned");
    }
    return current;
  }
  private checkContext(ref: AttemptRef) {
    if (ref.contextId !== this.contextId) throw new Error("Attempt belongs to another context");
  }
  private requireAttempt(ref: AttemptRef) {
    this.checkContext(ref);
    const row = this.database.get("SELECT closed FROM attempts WHERE context = ? AND task = ? AND number = ?", ref.contextId, ref.taskId, ref.attempt);
    if (!row) throw new Error("Attempt does not exist");
    return row;
  }
  private requireOpen(ref: AttemptRef) {
    if (this.requireAttempt(ref).closed) throw new AttemptStoreError("attempt_closed", "The attempt is already closed");
  }
  private closeAttempt(ref: AttemptRef) {
    this.database.run("UPDATE attempts SET closed = 1 WHERE context = ? AND task = ? AND number = ?", ref.contextId, ref.taskId, ref.attempt);
  }
  private insert<K extends EntryKind>(ref: AttemptRef, kind: K, data: EntryData<K>) {
    requireAuthority(this.database, this.caller, kind === "lease_returned" || kind === "lease_return_started" || kind === "discarded" || kind === "output_branch_cleanup" ? "returnLease"
      : kind === "integrated" || kind === "integration_started" || kind === "owner_read_reconciled" ? "integrate"
      : kind === "output_rebased" || kind === "rebase_started" || kind === "rebase_aborted" ? "rebase"
      : kind === "output_accepted" || kind === "check_finished" ? "acceptOutput"
      : ["requested", "leased", "task_started", "launched"].includes(kind) ? "dispatch" : "recordAttempt", { taskId: ref.taskId });
    const sequence = Number(this.database.get("SELECT coalesce(max(sequence), -1) + 1 AS n FROM attempt_entries WHERE context = ? AND task = ? AND attempt = ?",
      ref.contextId, ref.taskId, ref.attempt)!.n);
    const entry: AttemptEntry = parseAttemptEntry({ version: 1, ...identity(ref), sequence, kind, recordedAt: new Date().toISOString(), askedBy: callerName(this.caller), data });
    if (kind === "task_recorded" && entry.data.category === undefined) throw new Error("New outcomes require an explicit category");
    this.database.run("INSERT INTO attempt_entries VALUES(?,?,?,?,?)", ref.contextId, ref.taskId, ref.attempt, sequence, JSON.stringify(entry));
    recordEntryEvents(this.database, entry);
  }
  private confirm(ref: AttemptRef, confirmation: Confirmation) {
    const value = confirmationSchema.parse(confirmation);
    if (value.fact === "output_accepted") this.checkAcceptance(ref, value.scope.commit);
    if (value.fact === "owner_read_reconciled" && value.scope.returnId) requireAuthority(this.database, this.caller, "returnLease", { taskId: ref.taskId });
    requireAuthority(this.database, this.caller, ["no_processes", "lease_returned", "discard"].includes(value.fact) ? "returnLease"
      : value.fact === "output_accepted" ? "acceptOutput" : value.fact === "worker_stopped" ? "stopWorkers" : "integrate", { taskId: ref.taskId });
    this.database.run("INSERT INTO confirmations(context,task,attempt,fact,confirmed_by,confirmed_at,scope) VALUES(?,?,?,?,?,?,?)",
      ref.contextId, ref.taskId, ref.attempt, value.fact, callerName(this.caller), new Date().toISOString(), JSON.stringify(value.scope));
    const index = Number(this.database.get("SELECT count(*) AS n FROM confirmations WHERE context = ? AND task = ? AND attempt = ?", ref.contextId, ref.taskId, ref.attempt)!.n) - 1;
    recordPersonEvents(this.database, [taskObjective(this.database, ref.taskId)], `confirmation:${JSON.stringify([ref.contextId, ref.taskId, ref.attempt])}:${index}`);
  }
  private checkAcceptance(ref: AttemptRef, commit: string | undefined) {
    if (this.caller.kind === "person") return;
    requireAuthority(this.database, this.caller, "acceptOutput", { taskId: ref.taskId });
    const record = this.read(ref);
    const permission = checkAcceptanceEvidence(commit, this.checks, latestChecks(record, commit), recordedReviews(record, commit));
    if (!permission.allowed) throw new TaskStoreError("rejected", `${permission.reason}: ${permission.detail}`);
  }
  private task(id: string): Task | undefined {
    const row = this.database.get(`SELECT *, EXISTS(SELECT 1 FROM dependencies d JOIN tasks b ON b.id = d.blocker
      WHERE d.task = tasks.id AND b.state <> 'done') AS blocked FROM tasks WHERE id = ?`, id);
    return row ? { id: String(row.id), title: String(row.title), body: String(row.body), acceptanceCriteria: JSON.parse(String(row.acceptance_criteria)) as string[], repo: row.repo as string | null,
      kind: row.kind as string | null, objectiveId: row.objective_id as string | null, definitionRevision: Number(row.definition_revision), state: row.state as TaskState, held: row.hold_reason !== null,
      holdReason: row.hold_reason as string | null, holdRevision: Number(row.hold_revision), blocked: Boolean(row.blocked) } : undefined;
  }
  private expectTask(id: string, expected: ExpectedTask): Task {
    const task = this.task(id);
    if (!task || task.state !== expected.state || task.holdReason !== expected.holdReason ||
      (expected.holdRevision !== undefined && task.holdRevision !== expected.holdRevision)) {
      throw new AttemptStoreError("task_changed", "The task changed after finalisation was planned");
    }
    return task;
  }
  private writeOutcome(id: string, outcome: "done" | "hold", reason: string) {
    if (outcome === "done") this.database.run("UPDATE tasks SET state = 'done', hold_reason = NULL WHERE id = ?", id);
    else {
      if (!reason || reason.length > 200 || /[\r\n]/.test(reason)) throw new Error("Hold reason must be one line of 1–200 characters");
      this.database.run("UPDATE tasks SET state = 'queued', hold_reason = ?, hold_revision = hold_revision + 1 WHERE id = ?", reason, id);
    }
  }
}
