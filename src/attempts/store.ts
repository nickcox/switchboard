import { isAbsolute } from "node:path";
import { requireRetainedStorage } from "../infra/storage.ts";
import { z } from "zod";
import { Database } from "../database.ts";
import type { Task, TaskState } from "../tasks/store.ts";
import { attemptSpecificationSchema, storedSpecificationSchema, type AttemptSpecification } from "./specification.ts";
import { requestFingerprint, type RequestInputs } from "./requests.ts";
import { parseAttemptEntry, type AttemptEntry, type AttemptRecord, type AttemptRef, type EntryData, type EntryKind } from "./log.ts";

const nonempty = z.string().trim().min(1);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const confirmationSchema = z.discriminatedUnion("fact", [
  z.strictObject({ fact: z.literal("owner_read_reconciled"), scope: z.strictObject({ failureSequence: z.number().int().nonnegative(), outcome: z.enum(["happened", "not_happened"]), returnId: z.uuid().optional() }) }),
  z.strictObject({ fact: z.literal("no_processes"), scope: z.strictObject({ leaseId: nonempty, returnId: z.uuid() }) }),
  z.strictObject({ fact: z.literal("output_accepted"), scope: z.strictObject({ commit }) }),
  z.strictObject({ fact: z.literal("discard"), scope: z.strictObject({ leaseId: nonempty }) }),
  z.strictObject({ fact: z.literal("worker_stopped"), scope: z.strictObject({ leaseId: nonempty, sessionId: z.uuid().optional() }) }),
  z.strictObject({ fact: z.literal("lease_returned"), scope: z.strictObject({ outputBranch: nonempty, leaseId: nonempty.optional() }) }),
]);
export type Confirmation = z.infer<typeof confirmationSchema>;
export type ConfirmationRecord = AttemptRef & Confirmation & { confirmedBy: string; confirmedAt: string };
export type PendingDeletion = AttemptRef & { directory: string };
export type ArchivedRequest = AttemptRef & { archived: true; summary: Record<string, unknown> };
type ExpectedTask = Pick<Task, "state" | "holdReason" | "holdRevision">;
const identity = (ref: AttemptRef): AttemptRef => ({ contextId: ref.contextId, taskId: ref.taskId, attempt: ref.attempt });

export class AttemptStoreError extends Error {
  readonly reason: "not_ready" | "capacity" | "request_reserved" | "request_input_mismatch" | "attempt_closed" | "task_changed" | "attempt_changed" | "task_definition_changed" | "specification_incomplete";
  constructor(reason: AttemptStoreError["reason"], message: string) { super(message); this.reason = reason; }
}

/** Transactional task/attempt operations. External checks and directory deletion belong to the caller. */
export class AttemptStore {
  readonly database: Database;
  readonly contextId: string;
  constructor(database: Database, contextId: string) { this.database = database; this.contextId = nonempty.parse(contextId); }

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
    specification: (task: Task, ref: AttemptRef) => AttemptSpecification;
  }): Promise<{ created: boolean; ref: AttemptRef }> {
    z.number().int().positive().parse(options.maximum);
    return this.database.transaction(() => {
      const requestId = options.requested.requestId;
      if (requestId !== undefined) {
        nonempty.parse(requestId);
        const existing = this.request(requestId, options.requestInputs ?? { taskId: options.taskId });
        if (existing) {
          if (existing.attempt === null) throw new AttemptStoreError("request_reserved", "The request ID was imported without an attempt");
          return { created: false, ref: { contextId: this.contextId, taskId: String(existing.task), attempt: Number(existing.attempt) } };
        }
      }
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
      const number = Number(this.database.get("SELECT coalesce(max(number), 0) + 1 AS n FROM attempt_numbers WHERE context = ? AND task = ?", this.contextId, options.taskId)!.n);
      const ref = { contextId: this.contextId, taskId: options.taskId, attempt: number };
      this.database.run("INSERT INTO attempt_numbers VALUES(?,?,?)", ref.contextId, ref.taskId, ref.attempt);
      this.database.run("INSERT INTO attempts(context,task,number,request_id,reserved_at) VALUES(?,?,?,?,?)",
        ref.contextId, ref.taskId, ref.attempt, null, new Date().toISOString());
      if (requestId !== undefined) this.database.run("INSERT INTO request_records VALUES(?,?,?,?,?,?,?,0)", ref.contextId, requestId, ref.taskId, ref.attempt,
        new Date().toISOString(), 1, requestFingerprint(options.requestInputs ?? { taskId: options.taskId }));
      this.insert(ref, "requested", options.requested);
      const specification = attemptSpecificationSchema.parse(options.specification(task, ref));
      if (specification.taskId !== task.id || specification.contextId !== ref.contextId || specification.definitionRevision !== task.definitionRevision ||
        specification.title !== task.title || specification.instructions !== (task.body.trim() === "" ? task.title : task.body) ||
        specification.repository !== task.repo || specification.kind !== task.kind) throw new Error("Specification differs from the reserved task");
      this.database.run("INSERT INTO attempt_specifications VALUES(?,?,?,?)", ref.contextId, ref.taskId, ref.attempt, JSON.stringify(specification));
      return { created: true, ref };
    });
  }

  async startReservedTask(ref: AttemptRef): Promise<Task> {
    const started = await this.database.transaction(() => {
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
      if (!this.read(ref).entries.some(e => e.kind === "task_started")) throw new AttemptStoreError("not_ready", "The attempt has not started its task");
      const row = this.database.get("SELECT state, hold_revision, started_hold_revision FROM tasks WHERE id = ?", ref.taskId)!;
      const applied = row.state === "in_flight" && row.hold_revision === row.started_hold_revision;
      if (applied) this.writeOutcome(ref.taskId, outcome.outcome, outcome.reason);
      this.insert(ref, "task_recorded", { ...outcome, applied });
      this.closeAttempt(ref);
      return { task: this.task(ref.taskId)!, applied };
    });
  }

  async finishAttempt(ref: AttemptRef, expected: ExpectedTask, expectedRecord?: AttemptRecord): Promise<Task> {
    return this.database.transaction(() => {
      this.requireAttempt(ref);
      if (expectedRecord) this.expectRecord(expectedRecord);
      this.expectTask(ref.taskId, expected);
      this.writeOutcome(ref.taskId, "done", "finished");
      this.insert(ref, "task_recorded", { outcome: "done", reason: "finished", category: "done", applied: true });
      this.closeAttempt(ref);
      return this.task(ref.taskId)!;
    });
  }

  async discardAttempt(ref: AttemptRef, expected: ExpectedTask, confirmedBy: string, leaseId: string, note?: string, expectedRecord?: AttemptRecord): Promise<Task> {
    return this.database.transaction(() => {
      this.requireAttempt(ref);
      if (expectedRecord) this.expectRecord(expectedRecord);
      const task = this.expectTask(ref.taskId, expected);
      this.confirm(ref, { fact: "discard", scope: { leaseId } }, confirmedBy);
      if (task.state !== "done") this.writeOutcome(ref.taskId, "hold", `Switchboard attempt ${ref.attempt} discarded`);
      this.insert(ref, "discarded", note === undefined ? {} : { note });
      this.closeAttempt(ref);
      return this.task(ref.taskId)!;
    });
  }

  async append<K extends EntryKind>(ref: AttemptRef, kind: K, data: EntryData<K>): Promise<void> {
    if (["requested", "task_started", "task_recorded", "discarded", "output_accepted", "lease_return_started", "operator_resolved"].includes(kind)) throw new Error("Use the transactional task/attempt operation");
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

  async appendConfirmed<K extends "output_accepted" | "lease_return_started" | "operator_resolved">(ref: AttemptRef, kind: K, data: EntryData<K>, confirmation: Confirmation, confirmedBy: string, expectedRecord?: AttemptRecord): Promise<void> {
    await this.database.transaction(() => {
      this.requireAttempt(ref);
      if (expectedRecord) this.expectRecord(expectedRecord);
      const payload = data as Record<string, unknown>;
      const matches = kind === "output_accepted" ? confirmation.fact === "output_accepted" && confirmation.scope.commit === payload.commit
        : kind === "lease_return_started" ? confirmation.fact === "no_processes" && confirmation.scope.leaseId === payload.leaseId && confirmation.scope.returnId === payload.returnId
        : confirmation.fact === payload.action;
      if (!matches) throw new Error("The confirmation does not name this operation");
      if (kind === "lease_return_started" && this.read(ref).entries.some(e => e.kind === "lease_return_started" && e.data.returnId === payload.returnId)) {
        throw new Error("Each lease return requires its own confirmation");
      }
      this.confirm(ref, confirmation, confirmedBy);
      this.insert(ref, kind, data);
      if (kind === "operator_resolved") this.closeAttempt(ref);
    });
  }

  async recordConfirmation(ref: AttemptRef, confirmation: Confirmation, confirmedBy: string): Promise<void> {
    await this.database.transaction(() => { this.requireAttempt(ref); this.confirm(ref, confirmation, confirmedBy); });
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
    return { ...identity(ref), entries, confirmations: this.confirmations(ref),
      ...(row ? { specification: storedSpecificationSchema.parse(JSON.parse(String(row.specification))) } : {}),
      ...(allocation ? { allocation: allocation.data as EntryData<"leased"> } : {}),
    };
  }

  list(): AttemptRecord[] {
    return this.database.all("SELECT task, number FROM attempts WHERE context = ? AND number IS NOT NULL ORDER BY task, number", this.contextId)
      .map(row => this.read({ contextId: this.contextId, taskId: String(row.task), attempt: Number(row.number) }));
  }

  async archiveAttempt(expected: AttemptRecord, summary: Record<string, unknown>, directories: string[], expectedTask?: { state: string; held: boolean; holdReason: string | null }): Promise<void> {
    if (directories.some(directory => !isAbsolute(directory))) throw new Error("Deletion paths must be absolute");
    await this.database.transaction(() => {
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
        ...identity(expected), summary, entryCount: current.entries.length, finishedAt: current.entries.at(-1)!.recordedAt,
        archivedAt: new Date().toISOString(), confirmations: this.confirmations(expected),
        ...(current.specification ? { specification: current.specification } : {}), ...(current.allocation ? { allocation: current.allocation } : {}),
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
  cleanupEntries(deletion: PendingDeletion): { kind: string; data: Record<string, unknown> }[] {
    this.checkContext(deletion);
    const row = this.database.get("SELECT summary FROM archived_attempts WHERE context = ? AND task = ? AND attempt = ?", deletion.contextId, deletion.taskId, deletion.attempt);
    const archive = row ? JSON.parse(String(row.summary)) : {};
    return archive.cleanup?.[deletion.directory] ?? [];
  }

  async appendCleanup(deletion: PendingDeletion, kind: "deletion_started" | "owner_read_failed", data: Record<string, unknown>): Promise<void> {
    this.checkContext(deletion);
    await this.database.transaction(() => {
      const row = this.database.get("SELECT summary FROM archived_attempts WHERE context = ? AND task = ? AND attempt = ?", deletion.contextId, deletion.taskId, deletion.attempt);
      if (!row) throw new Error("The cleanup archive is missing");
      const archive = JSON.parse(String(row.summary));
      archive.cleanup ??= {};
      const entries = archive.cleanup[deletion.directory] ??= [];
      entries.push({ sequence: entries.length, kind, recordedAt: new Date().toISOString(), data });
      this.database.run("UPDATE archived_attempts SET summary = ? WHERE context = ? AND task = ? AND attempt = ?", JSON.stringify(archive), deletion.contextId, deletion.taskId, deletion.attempt);
    });
  }

  /** Called only after the caller has removed the directory or found it absent. */
  async completeDeletion(deletion: PendingDeletion): Promise<void> {
    this.checkContext(deletion);
    await this.database.transaction(() => this.database.run("DELETE FROM pending_attempt_deletions WHERE context = ? AND task = ? AND attempt = ? AND directory = ?",
      deletion.contextId, deletion.taskId, deletion.attempt, deletion.directory));
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
    const sequence = Number(this.database.get("SELECT coalesce(max(sequence), -1) + 1 AS n FROM attempt_entries WHERE context = ? AND task = ? AND attempt = ?",
      ref.contextId, ref.taskId, ref.attempt)!.n);
    const entry: AttemptEntry = parseAttemptEntry({ version: 1, ...identity(ref), sequence, kind, recordedAt: new Date().toISOString(), data });
    if (kind === "task_recorded" && entry.data.category === undefined) throw new Error("New outcomes require an explicit category");
    this.database.run("INSERT INTO attempt_entries VALUES(?,?,?,?,?)", ref.contextId, ref.taskId, ref.attempt, sequence, JSON.stringify(entry));
  }
  private confirm(ref: AttemptRef, confirmation: Confirmation, confirmedBy: string) {
    const value = confirmationSchema.parse(confirmation);
    this.database.run("INSERT INTO confirmations(context,task,attempt,fact,confirmed_by,confirmed_at,scope) VALUES(?,?,?,?,?,?,?)",
      ref.contextId, ref.taskId, ref.attempt, value.fact, nonempty.parse(confirmedBy), new Date().toISOString(), JSON.stringify(value.scope));
  }
  private task(id: string): Task | undefined {
    const row = this.database.get(`SELECT *, EXISTS(SELECT 1 FROM dependencies d JOIN tasks b ON b.id = d.blocker
      WHERE d.task = tasks.id AND b.state <> 'done') AS blocked FROM tasks WHERE id = ?`, id);
    return row ? { id: String(row.id), title: String(row.title), body: String(row.body), repo: row.repo as string | null,
      kind: row.kind as string | null, definitionRevision: Number(row.definition_revision), state: row.state as TaskState, held: row.hold_reason !== null,
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
