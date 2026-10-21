import { isAbsolute } from "node:path";
import { requireRetainedStorage } from "../infra/storage.ts";
import { z } from "zod";
import { Database } from "../database.ts";
import type { Task, TaskState } from "../tasks/store.ts";
import { parseAttemptEntry, type AttemptEntry, type AttemptRecord, type AttemptRef, type EntryData, type EntryKind } from "./log.ts";

const nonempty = z.string().trim().min(1);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const confirmationSchema = z.discriminatedUnion("fact", [
  z.strictObject({ fact: z.literal("no_processes"), scope: z.strictObject({ leaseId: nonempty, returnId: z.uuid() }) }),
  z.strictObject({ fact: z.literal("output_accepted"), scope: z.strictObject({ commit }) }),
  z.strictObject({ fact: z.literal("discard"), scope: z.strictObject({ leaseId: nonempty }) }),
  z.strictObject({ fact: z.literal("worker_stopped"), scope: z.strictObject({ leaseId: nonempty, sessionId: z.uuid().optional() }) }),
  z.strictObject({ fact: z.literal("lease_returned"), scope: z.strictObject({ outputBranch: nonempty, leaseId: nonempty.optional() }) }),
]);
export type Confirmation = z.infer<typeof confirmationSchema>;
export type ConfirmationRecord = AttemptRef & Confirmation & { confirmedBy: string; confirmedAt: string };
export type PendingDeletion = AttemptRef & { directory: string };
type ExpectedTask = Pick<Task, "state" | "holdReason" | "holdRevision">;
const identity = (ref: AttemptRef): AttemptRef => ({ contextId: ref.contextId, taskId: ref.taskId, attempt: ref.attempt });

export class AttemptStoreError extends Error {
  readonly reason: "not_ready" | "capacity" | "request_reserved" | "attempt_closed" | "task_changed" | "attempt_changed";
  constructor(reason: AttemptStoreError["reason"], message: string) { super(message); this.reason = reason; }
}

/** Transactional task/attempt operations. External checks and directory deletion belong to the caller. */
export class AttemptStore {
  readonly database: Database;
  readonly contextId: string;
  constructor(database: Database, contextId: string) { this.database = database; this.contextId = nonempty.parse(contextId); }

  async checkStorage(roots: string[]): Promise<void> { await requireRetainedStorage(this.database.path, roots); }
  async forTask(taskId: string): Promise<AttemptRecord[]> { return this.list().filter(record => record.taskId === taskId); }
  activeCount(): number {
    return Number(this.database.get("SELECT count(*) AS n FROM attempts WHERE context = ? AND number IS NOT NULL AND closed = 0", this.contextId)!.n);
  }
  async findByRequest(requestId: string): Promise<AttemptRecord | undefined> {
    const row = this.database.get("SELECT task, number FROM attempts WHERE context = ? AND request_id = ?", this.contextId, requestId);
    return row && row.number !== null ? this.read({ contextId: this.contextId, taskId: String(row.task), attempt: Number(row.number) }) : undefined;
  }

  async reserveAttempt(options: {
    taskId: string; requested: EntryData<"requested">; maximum: number; repo?: string | null;
  }): Promise<{ created: boolean; ref: AttemptRef }> {
    z.number().int().positive().parse(options.maximum);
    return this.database.transaction(() => {
      const requestId = options.requested.requestId;
      if (requestId !== undefined) {
        nonempty.parse(requestId);
        const existing = this.database.get("SELECT task, number FROM attempts WHERE context = ? AND request_id = ?", this.contextId, requestId);
        if (existing) {
          if (existing.number === null) throw new AttemptStoreError("request_reserved", "The request ID was imported without an attempt");
          return { created: false, ref: { contextId: this.contextId, taskId: String(existing.task), attempt: Number(existing.number) } };
        }
      }
      const count = this.activeCount();
      if (count >= options.maximum) throw new AttemptStoreError("capacity", "The context's attempt maximum has been reached");
      const task = this.task(options.taskId);
      if (!task || (options.repo != null && task.repo !== options.repo) || task.state !== "queued" || task.held || task.blocked ||
        this.database.get("SELECT 1 FROM attempts WHERE task = ? AND number IS NOT NULL AND closed = 0", options.taskId)) {
        throw new AttemptStoreError("not_ready", `Task ${options.taskId} is not available for an attempt`);
      }
      const number = Number(this.database.get("SELECT coalesce(max(number), 0) + 1 AS n FROM attempt_numbers WHERE context = ? AND task = ?", this.contextId, options.taskId)!.n);
      const ref = { contextId: this.contextId, taskId: options.taskId, attempt: number };
      this.database.run("INSERT INTO attempt_numbers VALUES(?,?,?)", ref.contextId, ref.taskId, ref.attempt);
      this.database.run("INSERT INTO attempts(context,task,number,request_id,reserved_at) VALUES(?,?,?,?,?)",
        ref.contextId, ref.taskId, ref.attempt, requestId ?? null, new Date().toISOString());
      this.insert(ref, "requested", options.requested);
      return { created: true, ref };
    });
  }

  async startReservedTask(ref: AttemptRef): Promise<Task> {
    return this.database.transaction(() => {
      this.requireOpen(ref);
      const task = this.task(ref.taskId);
      if (!task || task.state !== "queued" || task.held || task.blocked) throw new AttemptStoreError("not_ready", "The task stopped being ready");
      const entries = this.read(ref).entries;
      if (!entries.some(e => e.kind === "leased") || entries.some(e => e.kind === "task_started")) {
        throw new AttemptStoreError("not_ready", "Starting requires a lease and an attempt that has not started");
      }
      this.database.run("UPDATE tasks SET state = 'in_flight', started_hold_revision = hold_revision WHERE id = ?", ref.taskId);
      this.insert(ref, "task_started", {});
      return this.task(ref.taskId)!;
    });
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

  async finishAttempt(ref: AttemptRef, expected: ExpectedTask): Promise<Task> {
    return this.database.transaction(() => {
      this.requireAttempt(ref);
      this.expectTask(ref.taskId, expected);
      this.writeOutcome(ref.taskId, "done", "finished");
      this.insert(ref, "task_recorded", { outcome: "done", reason: "finished", category: "done", applied: true });
      this.closeAttempt(ref);
      return this.task(ref.taskId)!;
    });
  }

  async discardAttempt(ref: AttemptRef, expected: ExpectedTask, confirmedBy: string, leaseId: string, note?: string): Promise<Task> {
    return this.database.transaction(() => {
      this.requireAttempt(ref);
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

  async appendConfirmed<K extends "output_accepted" | "lease_return_started" | "operator_resolved">(ref: AttemptRef, kind: K, data: EntryData<K>, confirmation: Confirmation, confirmedBy: string): Promise<void> {
    await this.database.transaction(() => {
      this.requireAttempt(ref);
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
    return { ...identity(ref), entries, confirmations: this.confirmations(ref) };
  }

  list(): AttemptRecord[] {
    return this.database.all("SELECT task, number FROM attempts WHERE context = ? AND number IS NOT NULL ORDER BY task, number", this.contextId)
      .map(row => this.read({ contextId: this.contextId, taskId: String(row.task), attempt: Number(row.number) }));
  }

  async archiveAttempt(expected: AttemptRecord, summary: Record<string, unknown>, directories: string[]): Promise<void> {
    if (directories.some(directory => !isAbsolute(directory))) throw new Error("Deletion paths must be absolute");
    await this.database.transaction(() => {
      const current = this.read(expected);
      if (JSON.stringify(current.entries) !== JSON.stringify(expected.entries) || JSON.stringify(current.confirmations) !== JSON.stringify(expected.confirmations)) {
        throw new AttemptStoreError("attempt_changed", "The attempt changed after the archive was planned");
      }
      const row = this.requireAttempt(expected);
      if (!row.closed) throw new AttemptStoreError("attempt_changed", "An open attempt cannot be archived");
      const reservation = this.database.get("SELECT request_id, reserved_at FROM attempts WHERE context = ? AND task = ? AND number = ?",
        expected.contextId, expected.taskId, expected.attempt)!;
      const archive = {
        ...identity(expected), summary, entryCount: current.entries.length, finishedAt: current.entries.at(-1)!.recordedAt,
        archivedAt: new Date().toISOString(), confirmations: this.confirmations(expected),
        ...(reservation.request_id === null ? {} : { reservation: { requestId: reservation.request_id, reservedAt: reservation.reserved_at } }),
      };
      const existing = this.database.get("SELECT summary FROM archived_attempts WHERE context = ? AND task = ? AND attempt = ?", expected.contextId, expected.taskId, expected.attempt);
      if (existing) {
        const previous = JSON.parse(String(existing.summary)) as { finishedAt: string };
        if (previous.finishedAt !== archive.finishedAt) throw new AttemptStoreError("attempt_changed", "The attempt changed after its earlier archive");
      } else this.database.run("INSERT INTO archived_attempts VALUES(?,?,?,?)", expected.contextId, expected.taskId, expected.attempt, JSON.stringify(archive));
      for (const directory of new Set(directories)) this.database.run("INSERT INTO pending_attempt_deletions VALUES(?,?,?,?)", expected.contextId, expected.taskId, expected.attempt, directory);
      this.database.run("DELETE FROM attempts WHERE context = ? AND task = ? AND number = ?", expected.contextId, expected.taskId, expected.attempt);
    });
  }

  pendingDeletions(): PendingDeletion[] {
    return this.database.all("SELECT task, attempt, directory FROM pending_attempt_deletions WHERE context = ? ORDER BY task, attempt, directory", this.contextId)
      .map(row => ({ contextId: this.contextId, taskId: String(row.task), attempt: Number(row.attempt), directory: String(row.directory) }));
  }

  /** Called only after the caller has removed the directory or found it absent. */
  async completeDeletion(deletion: PendingDeletion): Promise<void> {
    this.checkContext(deletion);
    await this.database.transaction(() => this.database.run("DELETE FROM pending_attempt_deletions WHERE context = ? AND task = ? AND attempt = ? AND directory = ?",
      deletion.contextId, deletion.taskId, deletion.attempt, deletion.directory));
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
      kind: row.kind as string | null, state: row.state as TaskState, held: row.hold_reason !== null,
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
