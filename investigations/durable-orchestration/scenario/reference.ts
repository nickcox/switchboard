import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { acknowledge, refuse, uninterrupted, validResult } from "./contract.ts";
import type { Attempt, Interrupt, Outcome, Request, ScenarioDriver, Snapshot } from "./contract.ts";
import { approvalFor, FakeOwners } from "./owners.ts";

// A contract exerciser only: no persistent execution state, host, transport or restart recovery.
// Serialisation here qualifies only the in-process fixture, not cross-process admission.
export class InProcessScenario implements ScenarioDriver {
  private readonly attempts = new Map<string, Attempt>();
  private readonly outcomes = new Map<string, Outcome>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly owners: FakeOwners;
  private readonly interrupt: Interrupt;
  private readonly now: () => number;
  private readonly maximum: number;

  constructor(owners: FakeOwners, options: { maxAttempts?: number; interrupt?: Interrupt; now?: () => number } = {}) {
    this.owners = owners;
    this.maximum = options.maxAttempts ?? 1;
    if (!Number.isInteger(this.maximum) || this.maximum < 1) throw new Error("maxAttempts must be a positive integer");
    this.interrupt = options.interrupt ?? uninterrupted;
    this.now = options.now ?? Date.now;
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(action);
    this.queue = pending.catch(() => {});
    return pending;
  }

  private active(): number {
    return [...this.attempts.values()].filter(attempt => attempt.result === null).length;
  }

  private async ack(name: Parameters<typeof acknowledge>[0], record: () => void): Promise<void> {
    await acknowledge(name, this.interrupt, record);
  }

  submit(request: Request): Promise<Outcome> {
    return this.serial(async () => {
      if (!request.requestId.trim() || !request.taskId.trim() || !request.delivery.outputBranch.trim()) return refuse("invalid_request");
      const previous = this.attempts.get(request.requestId);
      if (previous) return isDeepStrictEqual(previous.request, request)
        ? structuredClone(this.outcomes.get(request.requestId) ?? refuse("host_unavailable", previous.id))
        : refuse("request_conflict", previous.id);
      let controls = await this.owners.controls();
      if (controls.unknown) return refuse("owner_unknown");
      if (!controls.ready || [...this.attempts.values()].some(attempt => attempt.request.taskId === request.taskId)) {
        return refuse("not_ready");
      }
      if (this.active() >= this.maximum) return refuse("capacity");
      const attempt: Attempt = {
        id: randomUUID(), request: structuredClone(request), identity: null, started: false,
        launched: false, prompted: false, result: null, reviewAccepted: false, accepted: false, done: false, returned: false,
      };
      await this.ack("reserved", () => { this.attempts.set(request.requestId, attempt); });
      // This runner does not retry after an adapter error or lost acknowledgement.
      this.outcomes.set(request.requestId, refuse("acquisition_uncertain", attempt.id));
      const identity = await this.owners.acquire("scenario", request.taskId, attempt.id);
      await this.ack("workspace", () => { attempt.identity = identity; });
      controls = await this.owners.controls();
      if (controls.unknown) return this.remember(attempt, refuse("owner_unknown", attempt.id));
      if (!controls.ready) return this.remember(attempt, refuse("not_ready", attempt.id));
      await this.ack("started", () => { attempt.started = true; });
      this.outcomes.set(request.requestId, refuse("possibly_running", attempt.id));
      await this.owners.launch(identity);
      await this.ack("launched", () => { attempt.launched = true; });
      await this.owners.prompt(identity);
      await this.ack("prompted", () => { attempt.prompted = true; });
      return this.remember(attempt, { status: "waiting", attemptId: attempt.id, waitingFor: "worker" });
    });
  }

  private remember(attempt: Attempt, outcome: Outcome): Outcome {
    this.outcomes.set(attempt.request.requestId, outcome);
    return structuredClone(outcome);
  }

  advance(requestId: string): Promise<Outcome> {
    return this.serial(async () => {
      const attempt = this.attempts.get(requestId);
      if (!attempt) return refuse("invalid_request");
      if (attempt.returned) return this.remember(attempt, { status: "completed", attemptId: attempt.id, waitingFor: null });
      const previous = this.outcomes.get(requestId);
      if (previous?.status === "refused" && ["acquisition_uncertain", "possibly_running", "finalisation_uncertain", "cancelled"].includes(previous.code)) return previous;
      if (!attempt.prompted) return this.remember(attempt, refuse("possibly_running", attempt.id));
      let controls = await this.owners.controls();
      if (controls.unknown) return this.remember(attempt, refuse("owner_unknown", attempt.id));
      const records = await this.owners.forAttempt(attempt.id);
      if (!attempt.result) {
        const exits = records.filter(record => record.effect === "worker_exit");
        if (!exits.length) return this.remember(attempt, { status: "waiting", attemptId: attempt.id, waitingFor: "worker" });
        const result = exits[0]?.result;
        if (exits.length !== 1 || !result || !validResult(result, attempt)) return this.remember(attempt, refuse("invalid_result", attempt.id));
        await this.ack("result", () => { attempt.result = structuredClone(result); });
      }
      const result = attempt.result!;
      if (!attempt.reviewAccepted) {
        const signals = records.filter(record => record.commit === result.commit &&
          record.effect === (attempt.request.delivery.acceptance === "review" ? "review" : "merge"));
        if (signals.some(record => record.decision === "rejected")) return this.remember(attempt, refuse("review_rejected", attempt.id));
        if (!signals.length) return this.remember(attempt, { status: "waiting", attemptId: attempt.id, waitingFor: "review" });
        await this.ack("review", () => { attempt.reviewAccepted = true; });
      }
      // Read owner state again at each protected action; cached workflow state is not authority.
      controls = await this.owners.controls();
      if (controls.unknown) return this.remember(attempt, refuse("owner_unknown", attempt.id));
      if (!controls.clean || controls.retainedCommit !== result.commit) return this.remember(attempt, refuse("not_retained", attempt.id));
      const acceptanceApproval = approvalFor(attempt, this.now(), controls);
      if (!acceptanceApproval) return this.remember(attempt, refuse("approval_required", attempt.id));
      if (!acceptanceApproval.noProcesses) return this.remember(attempt, refuse("process_confirmation_required", attempt.id));
      if (!attempt.accepted) await this.ack("accepted", () => { attempt.accepted = true; });
      controls = await this.owners.controls();
      if (controls.unknown) return this.remember(attempt, refuse("owner_unknown", attempt.id));
      if (!approvalFor(attempt, this.now(), controls)) return this.remember(attempt, refuse("approval_required", attempt.id));
      if (!attempt.done) await this.ack("done", () => { attempt.done = true; });
      controls = await this.owners.controls();
      if (controls.unknown) return this.remember(attempt, refuse("owner_unknown", attempt.id));
      if (!controls.clean || controls.retainedCommit !== result.commit) return this.remember(attempt, refuse("not_retained", attempt.id));
      const approval = approvalFor(attempt, this.now(), controls);
      if (!approval) return this.remember(attempt, refuse("approval_required", attempt.id));
      if (!approval.noProcesses) return this.remember(attempt, refuse("process_confirmation_required", attempt.id));
      this.outcomes.set(requestId, refuse("finalisation_uncertain", attempt.id));
      await this.owners.returnWorkspace(attempt.identity!);
      await this.ack("returned", () => { attempt.returned = true; });
      return this.remember(attempt, { status: "completed", attemptId: attempt.id, waitingFor: null });
    });
  }

  cancel(requestId: string): Promise<Outcome> {
    return this.serial(async () => {
      const attempt = this.attempts.get(requestId);
      if (!attempt) return refuse("invalid_request");
      if (attempt.returned) return this.outcomes.get(requestId)!;
      const previous = this.outcomes.get(requestId);
      if (previous?.status === "refused" && previous.code === "cancelled") return previous;
      this.outcomes.set(requestId, refuse("cancelled", attempt.id));
      if (attempt.identity && attempt.launched && !attempt.result) await this.owners.cancel(attempt.identity);
      await this.ack("cancelled", () => {});
      return this.outcomes.get(requestId)!;
    });
  }

  async inspect(): Promise<Snapshot> {
    await this.queue;
    return structuredClone({ attempts: [...this.attempts.values()], active: this.active(), maxAttempts: this.maximum });
  }
}
