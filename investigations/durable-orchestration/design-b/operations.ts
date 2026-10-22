import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AttemptStoreError } from "../../../src/attempts/store.ts";
import { checkCanAcceptOutput, checkCanFinish, checkCanReturnLease, type Permission } from "../../../src/dispatch/safety.ts";
import { ApplicationStore } from "../design-a/store.ts";
import { acknowledge, refuse, uninterrupted } from "../scenario/contract.ts";
import type { Acknowledgement, Attempt, Interrupt, Outcome, Request } from "../scenario/contract.ts";
import { approvalFor, FakeOwners } from "../scenario/owners.ts";

export const phases = ["reserve", "acquire", "start", "launch", "prompt", "observe", "review", "accept", "done", "return"] as const;
export type Phase = typeof phases[number];
export type StepResult = { next: Phase } | { outcome: Outcome; retry?: boolean };
export type Options = { maxAttempts?: number; interrupt?: Interrupt; now?: () => number };

// Application operations, not an execution loop. Durable alone chooses the next phase and owns waits.
// The bridge and process adapter are shared with A; duplicated domain glue is counted in the README.
export class Operations {
  readonly store: ApplicationStore;
  readonly owners: FakeOwners;
  readonly maximum: number;
  private readonly interrupt: Interrupt;
  private readonly now: () => number;
  private readonly launchedHere = new Set<string>();
  private readonly claims = new Map<string, string>();

  constructor(store: ApplicationStore, owners: FakeOwners, options: Options = {}) {
    this.store = store;
    this.owners = owners;
    this.maximum = options.maxAttempts ?? 1;
    if (!Number.isInteger(this.maximum) || this.maximum < 1) throw new Error("maxAttempts must be a positive integer");
    this.interrupt = options.interrupt ?? uninterrupted;
    this.now = options.now ?? Date.now;
  }

  private ack(name: Acknowledgement, record: () => Promise<unknown>): Promise<unknown> {
    return acknowledge(name, this.interrupt, record);
  }

  async run(phase: Phase, request: Request): Promise<StepResult> {
    if (phase === "reserve") {
      const previous = this.store.byRequest(request.requestId);
      if (previous) {
        if (!isDeepStrictEqual(previous.request, request)) return { outcome: refuse("request_conflict", previous.id) };
        return { next: "acquire" };
      }
      const controls = await this.owners.controls();
      if (controls.unknown) return { outcome: refuse("owner_unknown") };
      if (!controls.ready) return { outcome: refuse("not_ready") };
      for (const attempt of this.store.list()) {
        if (!attempt.result && !this.launchedHere.has(attempt.id)) return { outcome: refuse("possibly_running", attempt.id) };
      }
      await this.interrupt("reserved:ack:before");
      const reservation = await this.store.reserve(request, this.maximum);
      if ("outcome" in reservation) return { outcome: reservation.outcome };
      await this.interrupt("reserved:ack:after");
      return { next: "acquire" };
    }
    const attempt = this.store.byRequest(request.requestId);
    if (!attempt) return { outcome: refuse("invalid_request") };
    if (attempt.returned) return { outcome: { status: "completed", attemptId: attempt.id, waitingFor: null } };
    if (this.store.fact(request.requestId, "cancel_intent")) return { outcome: refuse("cancelled", attempt.id) };
    if (phase === "acquire") {
      if (attempt.identity || !await this.store.addFact(request.requestId, "acquire_intent", true)) {
        return { outcome: refuse("acquisition_uncertain", attempt.id) };
      }
      const identity = await this.owners.acquire("scenario", request.taskId, attempt.id);
      await this.ack("workspace", () => this.store.recordWorkspace(attempt, identity));
      return { next: "start" };
    }
    if (!attempt.identity) return { outcome: refuse("acquisition_uncertain", attempt.id) };
    if (phase === "start") {
      const controls = await this.owners.controls();
      if (controls.unknown) return { outcome: refuse("owner_unknown", attempt.id) };
      if (!controls.ready) return { outcome: refuse("not_ready", attempt.id) };
      if (!attempt.started) {
        try { await this.ack("started", () => this.store.attempts.startReservedTask(this.store.ref(attempt))); }
        catch (error) {
          if (error instanceof AttemptStoreError && error.reason === "not_ready") return { outcome: refuse("not_ready", attempt.id) };
          throw error;
        }
      }
      return { next: "launch" };
    }
    if (phase === "launch") {
      const binding = this.store.binding(attempt);
      const claimId = await this.store.runtime.claimLaunch({ context: "scenario", task: request.taskId,
        attempt: this.store.ref(attempt).attempt, leaseId: attempt.identity.leaseId,
        directory: this.store.runtimeDirectory(attempt), createdAt: binding.createdAt }, binding);
      if (!claimId) return { outcome: refuse("possibly_running", attempt.id) };
      this.claims.set(attempt.id, claimId);
      await this.owners.launch(attempt.identity);
      await this.ack("launched", () => this.store.attempts.append(this.store.ref(attempt), "launched", { sessionId: attempt.identity!.sessionId }));
      return { next: "prompt" };
    }
    if (phase === "prompt") {
      if (!await this.store.addFact(request.requestId, "prompt_intent", true)) return { outcome: refuse("possibly_running", attempt.id) };
      await this.owners.prompt(attempt.identity);
      await this.ack("prompted", () => this.store.addFact(request.requestId, "prompted", true));
      this.launchedHere.add(attempt.id);
      return { next: "observe" };
    }
    const controls = await this.owners.controls();
    if (controls.unknown) return { outcome: refuse("owner_unknown", attempt.id) };
    const records = await this.owners.forAttempt(attempt.id);
    if (phase === "observe") {
      if (attempt.result) return { next: "review" };
      if (!attempt.prompted) return { outcome: refuse("possibly_running", attempt.id) };
      const exits = records.filter(record => record.effect === "worker_exit");
      if (!exits.length) return { outcome: this.launchedHere.has(attempt.id)
        ? { status: "waiting", attemptId: attempt.id, waitingFor: "worker" } : refuse("possibly_running", attempt.id),
        retry: this.launchedHere.has(attempt.id) };
      const result = exits[0]?.result;
      if (exits.length !== 1 || !this.store.validate(result, attempt)) return { outcome: refuse("invalid_result", attempt.id) };
      await this.ack("result", async () => {
        const directory = this.store.runtimeDirectory(attempt);
        if (!await this.store.runtime.observation(directory, "exit")) {
          await this.store.runtime.recordObservation(directory, "exit", { started: true, code: 0, signal: null });
        }
        const claim = this.claims.get(attempt.id);
        if (claim) { await this.store.runtime.releaseClaim(claim); this.claims.delete(attempt.id); }
        if (!this.store.record(attempt).entries.some(entry => entry.kind === "worker_finished")) {
          await this.store.attempts.append(this.store.ref(attempt), "worker_finished", {
            status: "reported", runtimeDirectory: directory, outcome: "completed", resultCommit: result.commit,
          });
        }
        if (!this.store.record(attempt).entries.some(entry => entry.kind === "task_recorded")) {
          await this.store.attempts.recordOutcome(this.store.ref(attempt), { outcome: "hold", reason: "review required", category: "review_required" });
        }
        await this.store.addFact(request.requestId, "result", result);
      });
      return { next: "review" };
    }
    if (!attempt.result) return { outcome: refuse("invalid_result", attempt.id) };
    if (phase === "review") {
      const signals = records.filter(record => record.commit === attempt.result!.commit &&
        record.effect === (request.delivery.acceptance === "review" ? "review" : "merge"));
      if (signals.some(record => record.decision === "rejected")) return { outcome: refuse("review_rejected", attempt.id) };
      if (!signals.length) return { outcome: { status: "waiting", attemptId: attempt.id, waitingFor: "review" }, retry: true };
      if (!attempt.reviewAccepted) await this.ack("review", () => this.store.addFact(request.requestId, "review", attempt.result!.commit));
      return { next: "accept" };
    }
    const refusal = await this.permission(attempt);
    if (refusal) return { outcome: refusal, retry: true };
    const snapshot = await this.store.assessment(attempt, records);
    if (phase === "accept") {
      if (!attempt.accepted) {
        const denied = this.domainRefusal(checkCanAcceptOutput(snapshot.facts, attempt.result.commit !== "0".repeat(40)), attempt);
        if (denied) return { outcome: denied };
        await this.ack("accepted", () => this.store.attempts.appendConfirmed(this.store.ref(attempt), "output_accepted",
          { commit: attempt.result!.commit }, { fact: "output_accepted", scope: { commit: attempt.result!.commit } }, "operator", snapshot.record));
      }
      return { next: "done" };
    }
    if (phase === "done") {
      if (!attempt.done) {
        const denied = this.domainRefusal(checkCanFinish(snapshot.facts, false), attempt);
        if (denied) return { outcome: denied };
        if (!snapshot.task) return { outcome: refuse("owner_unknown", attempt.id) };
        await this.ack("done", () => this.store.attempts.finishAttempt(this.store.ref(attempt), snapshot.task!, snapshot.record));
      }
      return { next: "return" };
    }
    if (snapshot.record.entries.some(entry => entry.kind === "lease_return_started") || records.some(record => record.effect === "return")) {
      return { outcome: refuse("finalisation_uncertain", attempt.id) };
    }
    const denied = this.domainRefusal(checkCanReturnLease(snapshot.facts,
      { by: "finish", noProcesses: true, retained: true, confirmedDiscard: false }), attempt);
    if (denied) return { outcome: denied };
    const returnId = randomUUID();
    await this.store.attempts.appendConfirmed(this.store.ref(attempt), "lease_return_started",
      { leaseId: attempt.identity.leaseId, by: "finish", returnId },
      { fact: "no_processes", scope: { leaseId: attempt.identity.leaseId, returnId } }, "operator", snapshot.record);
    const fresh = await this.permission(attempt);
    if (fresh) return { outcome: fresh };
    const current = await this.store.assessment(attempt, await this.owners.forAttempt(attempt.id));
    const blocked = this.domainRefusal(checkCanReturnLease(current.facts,
      { by: "finish", noProcesses: true, retained: true, confirmedDiscard: false }), attempt);
    if (blocked) return { outcome: blocked };
    await this.owners.returnWorkspace(attempt.identity);
    const returns = (await this.owners.forAttempt(attempt.id)).filter(record => record.effect === "return");
    if (returns.length !== 1 || !isDeepStrictEqual(returns[0]!.identity, attempt.identity)) return { outcome: refuse("finalisation_uncertain", attempt.id) };
    await this.ack("returned", () => this.store.attempts.append(this.store.ref(attempt), "lease_returned", { leaseId: attempt.identity!.leaseId, by: "finish", returnId }));
    return { outcome: { status: "completed", attemptId: attempt.id, waitingFor: null } };
  }

  private async permission(attempt: Attempt): Promise<Outcome | null> {
    const controls = await this.owners.controls();
    if (controls.unknown) return refuse("owner_unknown", attempt.id);
    if (!controls.clean || controls.retainedCommit !== attempt.result!.commit) return refuse("not_retained", attempt.id);
    const approval = approvalFor(attempt, this.now(), controls);
    if (!approval) return refuse("approval_required", attempt.id);
    if (!approval.noProcesses) return refuse("process_confirmation_required", attempt.id);
    return null;
  }

  private domainRefusal(permission: Permission, attempt: Attempt): Outcome | null {
    if (permission.allowed) return null;
    return refuse(permission.reason === "possibly_running" ? "possibly_running" : permission.reason === "not_retained"
      ? "not_retained" : permission.reason === "no_completed_output" ? "not_ready" : "owner_unknown", attempt.id);
  }

  async cancel(requestId: string): Promise<Outcome> {
    const attempt = this.store.byRequest(requestId);
    if (!attempt) return refuse("invalid_request");
    if (attempt.returned) return { status: "completed", attemptId: attempt.id, waitingFor: null };
    if (await this.store.addFact(requestId, "cancel_intent", true)) {
      if (attempt.identity && attempt.launched && !attempt.result) await this.owners.cancel(attempt.identity);
      await this.ack("cancelled", () => this.store.addFact(requestId, "cancelled", true));
    }
    return refuse("cancelled", attempt.id);
  }
}
