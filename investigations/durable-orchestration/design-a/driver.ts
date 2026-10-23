import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AttemptStoreError } from "../../../src/attempts/store.ts";
import { checkCanAcceptOutput, checkCanFinish, checkCanReturnLease } from "../../../src/dispatch/safety.ts";
import type { Permission } from "../../../src/dispatch/safety.ts";
import { acknowledge, refuse, uninterrupted } from "../scenario/contract.ts";
import type { Acknowledgement, Attempt, Interrupt, Outcome, Request, ScenarioDriver, Snapshot } from "../scenario/contract.ts";
import { approvalFor, FakeOwners } from "../scenario/owners.ts";
import { ApplicationStore } from "./store.ts";
import { runSteps } from "./steps.ts";
import { readOwner, recovery } from "../scenario/recovery.ts";

export type Options = { maxAttempts?: number; interrupt?: Interrupt; now?: () => number };

// Foreground, Switchboard-owned composition. Owner evidence and application facts, not a
// checkpoint, decide what may happen on each explicit submit/advance call.
export class SwitchboardScenario implements ScenarioDriver {
  readonly store: ApplicationStore;
  private readonly owners: FakeOwners;
  private readonly interrupt: Interrupt;
  private readonly maximum: number;
  private readonly now: () => number;
  private readonly launchedHere = new Set<string>();
  private readonly claims = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(store: ApplicationStore, owners: FakeOwners, options: Options = {}) {
    this.store = store;
    this.owners = owners;
    this.interrupt = options.interrupt ?? uninterrupted;
    this.now = options.now ?? Date.now;
    this.maximum = options.maxAttempts ?? 1;
    if (!Number.isInteger(this.maximum) || this.maximum < 1) throw new Error("maxAttempts must be a positive integer");
  }

  private serial(action: () => Promise<Outcome>, requestId?: string): Promise<Outcome> {
    const pending = this.queue.then(async () => {
      if (this.closed) return refuse("host_unavailable");
      try { return await action(); }
      catch (error) {
        const classified = recovery(error);
        if (classified && requestId) {
          const attempt = this.store.byRequest(requestId);
          if (attempt) return this.respond(attempt, classified.outcome);
        }
        const refusal = refuse("host_unavailable");
        return { ...refusal, nextAction: `${refusal.nextAction}: ${error instanceof Error ? error.message : String(error)}` };
      }
    });
    this.queue = pending;
    return pending;
  }

  private ack(name: Acknowledgement, record: () => Promise<unknown>): Promise<unknown> {
    return acknowledge(name, this.interrupt, record);
  }

  private current(attempt: Attempt): Attempt {
    const current = this.store.byRequest(attempt.request.requestId);
    if (!current) throw new Error("The reserved attempt disappeared");
    return current;
  }

  private respond(attempt: Attempt, outcome: Outcome): Promise<Outcome> { return this.store.respond(attempt, outcome); }

  private async existing(attempt: Attempt): Promise<Outcome> {
    const response = this.store.response(attempt.request.requestId);
    if (attempt.returned) return { status: "completed", attemptId: attempt.id, waitingFor: null };
    if (response?.status === "waiting" && !attempt.result && !this.launchedHere.has(attempt.id)) {
      return refuse("possibly_running", attempt.id);
    }
    if (response) return response;
    return refuse(attempt.started ? "possibly_running" : "acquisition_uncertain", attempt.id);
  }

  submit(request: Request): Promise<Outcome> {
    return this.serial(async () => {
      if (!request.requestId.trim() || !request.taskId.trim() || !request.delivery.outputBranch.trim()) return refuse("invalid_request");
      const previous = this.store.byRequest(request.requestId);
      if (previous) return isDeepStrictEqual(previous.request, request) ? this.existing(previous) : refuse("request_conflict", previous.id);
      const controls = await this.owners.controls();
      if (controls.unknown) return refuse("owner_unknown");
      if (!controls.ready) return refuse("not_ready");
      // A restarted foreground owner never adopts a possibly live worker. It blocks the context,
      // even if capacity remains; positive exit evidence can later be inspected by advance().
      for (const attempt of this.store.list()) {
        if (!attempt.result && !this.launchedHere.has(attempt.id)) return refuse("possibly_running", attempt.id);
      }
      await this.interrupt("reserved:ack:before");
      const reservation = await this.store.reserve(request, this.maximum);
      if ("outcome" in reservation) return reservation.outcome;
      let attempt = reservation.attempt;
      if (!reservation.created) return this.existing(attempt);
      await this.interrupt("reserved:ack:after");
      // Commit uncertainty BEFORE calling the owner. The intent is exclusion, not evidence of success.
      await this.respond(attempt, refuse("acquisition_uncertain", attempt.id));
      if (!await this.store.addFact(request.requestId, "acquire_intent", true)) return refuse("acquisition_uncertain", attempt.id);
      const identity = await this.owners.acquire("scenario", request.taskId, attempt.id);
      await this.ack("workspace", () => this.store.recordWorkspace(attempt, identity));
      attempt = this.current(attempt);
      const fresh = await this.owners.controls();
      if (fresh.unknown) return this.respond(attempt, refuse("owner_unknown", attempt.id));
      if (!fresh.ready) return this.respond(attempt, refuse("not_ready", attempt.id));
      try { await this.ack("started", () => this.store.attempts.startReservedTask(this.store.ref(attempt))); }
      catch (error) {
        if (error instanceof AttemptStoreError && error.reason === "not_ready") return this.respond(attempt, refuse("not_ready", attempt.id));
        throw error;
      }
      attempt = this.current(attempt);
      await this.respond(attempt, refuse("possibly_running", attempt.id));
      const binding = this.store.binding(attempt);
      const claimId = await this.store.runtime.claimLaunch({ context: "scenario", task: request.taskId, attempt: this.store.ref(attempt).attempt,
        leaseId: identity.leaseId, directory: this.store.runtimeDirectory(attempt), createdAt: binding.createdAt }, binding);
      if (!claimId) throw new Error("Launch permission was not granted");
      this.claims.set(attempt.id, claimId);
      await this.owners.launch(identity);
      await this.ack("launched", () => this.store.attempts.append(this.store.ref(attempt), "launched", { sessionId: identity.sessionId }));
      if (!await this.store.addFact(request.requestId, "prompt_intent", true)) return refuse("possibly_running", attempt.id);
      await this.owners.prompt(identity);
      await this.ack("prompted", () => this.store.addFact(request.requestId, "prompted", true));
      this.launchedHere.add(attempt.id);
      return this.respond(attempt, { status: "waiting", attemptId: attempt.id, waitingFor: "worker" });
    });
  }

  advance(requestId: string): Promise<Outcome> {
    return this.serial(async () => {
      let attempt = this.store.byRequest(requestId);
      if (!attempt) return refuse("invalid_request");
      if (attempt.returned) return this.existing(attempt);
      if (this.store.fact(requestId, "cancel_intent")) return refuse("cancelled", attempt.id);
      const controls = await this.readControls(attempt);
      if (controls.unknown) return this.respond(attempt, refuse("owner_unknown", attempt.id));
      const records = await this.readRecords(attempt);
      if (!attempt.identity) return this.respond(attempt, refuse("acquisition_uncertain", attempt.id));
      if (!attempt.prompted) return this.respond(attempt, refuse("possibly_running", attempt.id));
      if (!attempt.result) {
        const exits = records.filter(record => record.effect === "worker_exit");
        if (!exits.length) return this.respond(attempt, this.launchedHere.has(attempt.id)
          ? { status: "waiting", attemptId: attempt.id, waitingFor: "worker" } : refuse("possibly_running", attempt.id));
        const result = exits[0]?.result;
        if (exits.length !== 1 || !this.store.validate(result, attempt)) return this.respond(attempt, refuse("invalid_result", attempt.id));
        const observed = attempt;
        await this.ack("result", async () => {
          const directory = this.store.runtimeDirectory(observed);
          if (!await this.store.runtime.observation(directory, "exit")) {
            await this.store.runtime.recordObservation(directory, "exit", { started: true, code: 0, signal: null });
          }
          const claimId = this.claims.get(observed.id);
          if (claimId) {
            await this.store.runtime.releaseClaim(claimId);
            this.claims.delete(observed.id);
          }
          if (!this.store.record(observed).entries.some(entry => entry.kind === "worker_finished")) {
            await this.store.attempts.append(this.store.ref(observed), "worker_finished", {
              status: "reported", runtimeDirectory: directory, outcome: "completed", resultCommit: result.commit,
            });
          }
          // Worker completion releases capacity but leaves the task held for review, as production does.
          if (!this.store.record(observed).entries.some(entry => entry.kind === "task_recorded")) {
            await this.store.attempts.recordOutcome(this.store.ref(observed), {
              outcome: "hold", reason: "review required", category: "review_required",
            });
          }
          await this.store.addFact(requestId, "result", result);
        });
        attempt = this.current(attempt);
      }
      const completed = attempt;
      const signals = records.filter(record => record.commit === completed.result!.commit &&
        record.effect === (completed.request.delivery.acceptance === "review" ? "review" : "merge"));
      if (signals.some(record => record.decision === "rejected")) return this.respond(attempt, refuse("review_rejected", attempt.id));
      if (!signals.length) return this.respond(attempt, { status: "waiting", attemptId: attempt.id, waitingFor: "review" });
      if (!attempt.reviewAccepted) {
        await this.ack("review", () => this.store.addFact(requestId, "review", attempt!.result!.commit));
        attempt = this.current(attempt);
      }
      return this.finalise(attempt);
    }, requestId);
  }

  private readControls(attempt: Attempt) {
    return readOwner(this.store, attempt, "Treehouse", () => this.owners.controls());
  }

  private readRecords(attempt: Attempt) {
    return readOwner(this.store, attempt, "Treehouse", () => this.owners.forAttempt(attempt.id));
  }

  private async permission(attempt: Attempt): Promise<Outcome | null> {
    const controls = await this.readControls(attempt);
    if (controls.unknown) return refuse("owner_unknown", attempt.id);
    if (!controls.clean || controls.retainedCommit !== attempt.result!.commit) return refuse("not_retained", attempt.id);
    const approval = approvalFor(attempt, this.now(), controls);
    if (!approval) return refuse("approval_required", attempt.id);
    if (!approval.noProcesses) return refuse("process_confirmation_required", attempt.id);
    return null;
  }

  private domainRefusal(permission: Permission, attempt: Attempt): Outcome | null {
    if (permission.allowed) return null;
    if (permission.reason === "possibly_running") return refuse("possibly_running", attempt.id);
    if (permission.reason === "not_retained") return refuse("not_retained", attempt.id);
    return refuse(permission.reason === "no_completed_output" ? "not_ready" : "owner_unknown", attempt.id);
  }

  private async finalise(attempt: Attempt): Promise<Outcome> {
    const stopped = await runSteps([
      { description: "record accepted output", happened: () => this.current(attempt).accepted, run: async () => {
        const refusal = await this.permission(attempt);
        if (refusal) return refusal;
        const snapshot = await this.store.assessment(attempt, await this.readRecords(attempt));
        const denied = this.domainRefusal(checkCanAcceptOutput(snapshot.facts, attempt.result!.commit !== "0".repeat(40)), attempt);
        if (denied) return denied;
        await this.ack("accepted", () => this.store.attempts.appendConfirmed(this.store.ref(attempt), "output_accepted",
          { commit: attempt.result!.commit }, { fact: "output_accepted", scope: { commit: attempt.result!.commit } }, "operator",
          snapshot.record));
        return null;
      } },
      { description: "record the task as done", happened: () => this.current(attempt).done, run: async () => {
        const refusal = await this.permission(attempt);
        if (refusal) return refusal;
        const snapshot = await this.store.assessment(attempt, await this.readRecords(attempt));
        const denied = this.domainRefusal(checkCanFinish(snapshot.facts, false), attempt);
        if (denied) return denied;
        if (!snapshot.task) return refuse("owner_unknown", attempt.id);
        await this.ack("done", () => this.store.attempts.finishAttempt(this.store.ref(attempt), snapshot.task!, snapshot.record));
        return null;
      } },
      { description: "return the exact retained lease", happened: () => this.current(attempt).returned, run: async () => {
        const refusal = await this.permission(attempt);
        if (refusal) return refusal;
        const record = this.store.record(attempt);
        // Inspect owner evidence on every run. A lost return receipt is not permission to call again.
        const records = await this.readRecords(attempt);
        const intent = record.entries.find(entry => entry.kind === "lease_return_started");
        if (intent) return refuse("finalisation_uncertain", attempt.id);
        if (records.some(receipt => receipt.effect === "return")) return refuse("finalisation_uncertain", attempt.id);
        const snapshot = await this.store.assessment(attempt, records);
        const denied = this.domainRefusal(checkCanReturnLease(snapshot.facts,
          { by: "finish", noProcesses: true, retained: true, confirmedDiscard: false }), attempt);
        if (denied) return denied;
        const returnId = randomUUID();
        await this.store.attempts.appendConfirmed(this.store.ref(attempt), "lease_return_started",
          { leaseId: attempt.identity!.leaseId, by: "finish", returnId },
          { fact: "no_processes", scope: { leaseId: attempt.identity!.leaseId, returnId } }, "operator", snapshot.record);
        const fresh = await this.permission(attempt);
        if (fresh) return fresh;
        const current = await this.store.assessment(attempt, await this.readRecords(attempt));
        const blocked = this.domainRefusal(checkCanReturnLease(current.facts,
          { by: "finish", noProcesses: true, retained: true, confirmedDiscard: false }), attempt);
        if (blocked) return blocked;
        await this.respond(attempt, refuse("finalisation_uncertain", attempt.id));
        await this.owners.returnWorkspace(attempt.identity!);
        const returns = (await this.readRecords(attempt)).filter(receipt => receipt.effect === "return");
        if (returns.length !== 1 || !isDeepStrictEqual(returns[0]!.identity, attempt.identity)) {
          return refuse("finalisation_uncertain", attempt.id);
        }
        await this.ack("returned", () => this.store.attempts.append(this.store.ref(attempt), "lease_returned",
          { leaseId: attempt.identity!.leaseId, by: "finish", returnId }));
        return null;
      } },
    ]);
    return this.respond(attempt, stopped ?? { status: "completed", attemptId: attempt.id, waitingFor: null });
  }

  cancel(requestId: string): Promise<Outcome> {
    return this.serial(async () => {
      const attempt = this.store.byRequest(requestId);
      if (!attempt) return refuse("invalid_request");
      if (attempt.returned) return this.existing(attempt);
      // The durable marker excludes repeated cancellation delivery. It proves no termination.
      if (await this.store.addFact(requestId, "cancel_intent", true)) {
        await this.respond(attempt, refuse("cancelled", attempt.id));
        if (attempt.identity && attempt.launched && !attempt.result) await this.owners.cancel(attempt.identity);
        await this.ack("cancelled", () => this.store.addFact(requestId, "cancelled", true));
      }
      return refuse("cancelled", attempt.id);
    });
  }

  async inspect(): Promise<Snapshot> {
    await this.queue;
    return { attempts: this.store.list(), active: this.store.attempts.activeCount(), maxAttempts: this.maximum };
  }

  async close(): Promise<void> {
    await this.queue;
    this.closed = true;
    this.store.close();
  }
}
