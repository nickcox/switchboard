import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AttemptStore, AttemptStoreError } from "../../../src/attempts/store.ts";
import type { AttemptRecord, AttemptRef } from "../../../src/attempts/log.ts";
import { SqliteTaskStore } from "../../../src/tasks/sqlite.ts";
import { bindingSchema, type RuntimeBinding } from "../../../src/runtime/records.ts";
import { RuntimeStore } from "../../../src/runtime/store.ts";
import { validateWorkerResult } from "../../../src/runtime/contracts.ts";
import { assessAttempt } from "../../../src/dispatch/assess.ts";
import type { AttemptFacts } from "../../../src/dispatch/assess.ts";
import type { ChildExit, RuntimeRecord } from "../../../src/runtime/records.ts";
import type { EffectRecord } from "../scenario/owners.ts";
import { refuse, validResult } from "../scenario/contract.ts";
import type { Attempt, Identity, Outcome, Request, WorkerResult } from "../scenario/contract.ts";

const contextId = "scenario";
const startingCommit = "0".repeat(40);
type Reservation = { attempt: Attempt; created: boolean } | { outcome: Outcome };

// Production entries remain authoritative. These tables hold only contract fields and facts the
// current application schema cannot express, not a workflow position or a second attempt journal.
export class ApplicationStore {
  readonly tasks: SqliteTaskStore;
  readonly attempts: AttemptStore;
  readonly runtime: RuntimeStore;
  readonly directory: string;

  private constructor(tasks: SqliteTaskStore, directory: string) {
    this.tasks = tasks;
    this.attempts = new AttemptStore(tasks.database, contextId);
    this.runtime = new RuntimeStore(tasks.database);
    this.directory = directory;
  }

  static async open(directory: string): Promise<ApplicationStore> {
    const tasks = await SqliteTaskStore.open({ path: join(directory, "switchboard.db") });
    const store = new ApplicationStore(tasks, directory);
    try {
      await tasks.database.transaction(() => {
        tasks.database.run(`CREATE TABLE IF NOT EXISTS prototype_requests (
          request_id TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, input TEXT NOT NULL CHECK(json_valid(input)))`);
        tasks.database.run(`CREATE TABLE IF NOT EXISTS prototype_facts (
          request_id TEXT NOT NULL REFERENCES prototype_requests(request_id), name TEXT NOT NULL,
          value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(request_id, name))`);
        tasks.database.run(`CREATE TABLE IF NOT EXISTS prototype_responses (
          request_id TEXT PRIMARY KEY REFERENCES prototype_requests(request_id), value TEXT NOT NULL CHECK(json_valid(value)))`);
      });
      return store;
    } catch (error) { tasks.close(); throw error; }
  }

  close(): void { this.tasks.close(); }

  // Only fixtures create tasks. Requests cannot create or change authoritative project work.
  async seed(taskIds: string[]): Promise<void> {
    for (const id of taskIds) await this.tasks.add({ id, title: id, body: "Disposable scenario work" });
  }

  async reserve(request: Request, maximum: number): Promise<Reservation> {
    const frozen = await this.tasks.database.transaction(() => {
      const existing = this.tasks.database.get("SELECT input FROM prototype_requests WHERE request_id = ?", request.requestId);
      if (existing) return isDeepStrictEqual(JSON.parse(String(existing.input)), request);
      this.tasks.database.run("INSERT INTO prototype_requests VALUES(?,?,?)", request.requestId, randomUUID(), JSON.stringify(request));
      return true;
    });
    if (!frozen) return { outcome: refuse("request_conflict", this.byRequest(request.requestId)?.id ?? null) };
    try {
      const reservation = await this.attempts.reserveAttempt({ taskId: request.taskId, maximum, requested: {
        requestId: request.requestId, contract: { name: "scenario", kind: "code", acceptance: "review_or_integration",
          requiredEvidence: request.delivery.requiredEvidence, requiredDeliverables: request.delivery.requiredDeliverables },
      } });
      return { attempt: this.fromRecord(this.attempts.read(reservation.ref)), created: reservation.created };
    } catch (error) {
      if (error instanceof AttemptStoreError && (error.reason === "not_ready" || error.reason === "capacity")) {
        return { outcome: refuse(error.reason) };
      }
      throw error;
    }
  }

  ref(attempt: Attempt): AttemptRef {
    const record = this.attempts.findForTask(attempt.request.taskId);
    if (!record || record.entries[0]!.data.requestId !== attempt.request.requestId) throw new Error("Attempt identity changed");
    return { contextId, taskId: record.taskId, attempt: record.attempt };
  }

  record(attempt: Attempt): AttemptRecord { return this.attempts.read(this.ref(attempt)); }

  private fromRecord(record: AttemptRecord): Attempt {
    const requestId = String(record.entries[0]!.data.requestId);
    const row = this.tasks.database.get("SELECT id, input FROM prototype_requests WHERE request_id = ?", requestId);
    if (!row) throw new Error("Attempt has no frozen scenario request");
    const request = JSON.parse(String(row.input)) as Request;
    const leased = record.entries.find(entry => entry.kind === "leased");
    const session = this.fact<string>(requestId, "session");
    const identity: Identity | null = leased && session ? { contextId, taskId: record.taskId, attemptId: String(row.id),
      leaseId: String(leased.data.leaseId), sessionId: session } : null;
    return {
      id: String(row.id), request, identity,
      started: record.entries.some(entry => entry.kind === "task_started"),
      launched: record.entries.some(entry => entry.kind === "launched"),
      prompted: this.fact<boolean>(requestId, "prompted") ?? false,
      result: this.fact<WorkerResult>(requestId, "result") ?? null,
      reviewAccepted: this.fact<string>(requestId, "review") !== undefined,
      accepted: record.confirmations?.some(confirmation => confirmation.fact === "output_accepted") ?? false,
      done: record.entries.some(entry => entry.kind === "task_recorded" && entry.data.outcome === "done"),
      returned: record.entries.some(entry => entry.kind === "lease_returned"),
    };
  }

  list(): Attempt[] { return this.attempts.list().map(record => this.fromRecord(record)); }
  byRequest(requestId: string): Attempt | undefined { return this.list().find(attempt => attempt.request.requestId === requestId); }

  fact<T>(requestId: string, name: string): T | undefined {
    const row = this.tasks.database.get("SELECT value FROM prototype_facts WHERE request_id = ? AND name = ?", requestId, name);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }

  async addFact(requestId: string, name: string, value: unknown): Promise<boolean> {
    return this.tasks.database.transaction(() => Boolean(this.tasks.database.run(
      "INSERT OR IGNORE INTO prototype_facts VALUES(?,?,?)", requestId, name, JSON.stringify(value)).changes));
  }

  response(requestId: string): Outcome | undefined {
    const row = this.tasks.database.get("SELECT value FROM prototype_responses WHERE request_id = ?", requestId);
    return row ? JSON.parse(String(row.value)) as Outcome : undefined;
  }

  async respond(attempt: Attempt, outcome: Outcome): Promise<Outcome> {
    await this.tasks.database.transaction(() => this.tasks.database.run(
      "INSERT INTO prototype_responses VALUES(?,?) ON CONFLICT(request_id) DO UPDATE SET value = excluded.value",
      attempt.request.requestId, JSON.stringify(outcome)));
    return outcome;
  }

  workspace(attempt: Attempt): string { return join(this.directory, "workspaces", attempt.id); }
  runtimeDirectory(attempt: Attempt): string { return join(this.directory, "workers", attempt.id); }

  binding(attempt: Attempt): RuntimeBinding {
    if (!attempt.identity) throw new Error("A binding requires a recorded workspace identity");
    const { attemptId: _, ...identity } = attempt.identity;
    const directory = this.runtimeDirectory(attempt);
    return bindingSchema.parse({ version: 1, createdAt: new Date().toISOString(), input: {
      identity, workspace: this.workspace(attempt), instructions: "Disposable scenario work", acceptanceCriteria: [],
      delivery: { ...attempt.request.delivery, acceptance: "review_or_integration", baseRef: "main", startingCommit, kind: "code" },
    }, sessionDirectory: join(directory, "sessions"), artefactDirectory: join(directory, "artefacts"), resultPath: join(directory, "result.json") });
  }

  validate(result: unknown, attempt: Attempt): result is WorkerResult {
    if (!validResult(result, attempt)) return false;
    // Translate the shared abbreviated fake report at the adapter boundary, then run the real validator.
    try {
      const { attemptId: _, ...identity } = result.identity;
      validateWorkerResult({ version: 1, identity, outcome: result.outcome, summary: "Synthetic worker result",
        validationEvidence: result.evidence.map(name => ({ name, summary: "Synthetic evidence" })),
        workReferences: result.deliverables.map(name => ({ kind: "git", name, branch: result.branch, commit: result.commit })),
      }, this.binding(attempt).input);
      return true;
    } catch { return false; }
  }

  async assessment(attempt: Attempt, receipts: EffectRecord[]): Promise<{ facts: AttemptFacts; record: AttemptRecord;
    task: NonNullable<Awaited<ReturnType<SqliteTaskStore["read"]>>> | undefined }> {
    const record = this.record(attempt);
    const task = await this.tasks.read(attempt.request.taskId);
    const launch = this.tasks.database.get("SELECT * FROM launches WHERE context = ? AND task = ? AND attempt = ?",
      contextId, record.taskId, record.attempt);
    const exit = launch ? await this.runtime.observation(String(launch.directory), "exit") as ChildExit | undefined : undefined;
    const runtime: RuntimeRecord | undefined = launch ? {
      directory: String(launch.directory), storage: this.runtime, claimId: String(launch.claim_id),
      binding: bindingSchema.parse(JSON.parse(String(launch.binding))),
      child: exit ? { status: "exited", exit } : { status: "unknown" },
    } : undefined;
    const returned = receipts.some(receipt => receipt.effect === "return");
    const acquisitions = receipts.filter(receipt => receipt.effect === "acquire");
    const leases = returned ? [] : acquisitions.map(receipt => ({ leaseId: receipt.identity!.leaseId,
      holder: receipt.identity!.taskId, path: this.workspace(attempt), branch: attempt.request.delivery.outputBranch }));
    const assessment = assessAttempt({
      attempt: { contextId, taskId: record.taskId, attempt: record.attempt,
        ...(attempt.identity ? { leaseId: attempt.identity.leaseId, sessionId: attempt.identity.sessionId } : {}) },
      record: { known: true, value: record }, runtime: { known: true, value: runtime },
      leases: { known: true, value: leases }, pool: { known: true, value: "scenario" },
      task: { known: true, value: task ?? "missing" }, heartbeat: { known: true, value: false },
      latest: true, taskWorkerMayBeRunning: runtime?.child.status === "unknown",
    });
    return { facts: assessment.facts, record, task };
  }

  async recordWorkspace(attempt: Attempt, identity: Identity): Promise<void> {
    await this.addFact(attempt.request.requestId, "session", identity.sessionId);
    await this.attempts.append(this.ref(attempt), "leased", { leaseId: identity.leaseId, workspace: this.workspace(attempt),
      outputBranch: attempt.request.delivery.outputBranch, baseRef: "main", startingCommit });
  }
}
