import type { AttemptEntry, AttemptRecord, AttemptRef } from "../attempts/log.ts";
import type { Dependencies } from "./dependencies.ts";
import type { AttemptObservation, ContextObservation, Observation } from "./observe.ts";
import { classifyFailure, OwnerReadError, readDiagnostics, type ReadFailure } from "./failure.ts";
import { result, type DispatchResult, type Stage } from "./result.ts";

export function effectBefore(record: AttemptRecord, sequence: number): AttemptEntry | undefined {
  return [...record.entries].reverse().find(e => e.sequence < sequence && (e.kind === "integration_started" || e.kind === "lease_return_started" || e.kind === "rebase_started"));
}

export function unsettledReads(record: AttemptRecord): AttemptEntry[] {
  if (record.entries.some(e => e.kind === "lease_returned") || record.confirmations?.some(c => c.fact === "lease_returned")) return [];
  return record.entries.filter(e => e.kind === "owner_read_failed" && e.data.classification === "effect_uncertain" &&
    !record.entries.some(r => r.kind === "owner_read_reconciled" && r.data.failureSequence === e.sequence) &&
    !record.confirmations?.some(c => c.fact === "owner_read_reconciled" && c.scope.failureSequence === e.sequence));
}

/** A return intent is cleared only by an absent lease or a failure-scoped operator confirmation. */
export function pendingReturn(record: AttemptRecord): AttemptEntry | undefined {
  return [...record.entries].reverse().find(e => e.kind === "lease_return_started" &&
    !record.entries.some(r => r.kind === "lease_returned" && r.data.returnId === e.data.returnId) &&
    !record.confirmations?.some(c => c.fact === "owner_read_reconciled" && c.scope.outcome === "not_happened" && c.scope.returnId === e.data.returnId));
}

/** Read boundaries declared by operations, not a general exception handler. */
export class OwnerReads {
  effectAttempted = false;
  record: AttemptRef | undefined;
  readonly deps: Dependencies;
  readonly operation: ReadFailure["operation"];
  readonly leaseId: string | undefined;
  constructor(deps: Dependencies, operation: ReadFailure["operation"], leaseId?: string) {
    this.deps = deps;
    this.operation = operation;
    this.leaseId = leaseId;
  }

  async current(): Promise<AttemptRecord | undefined> {
    return this.record ? this.deps.attempts.read(this.record) : this.leaseId ? this.deps.attempts.findByLease(this.leaseId) : undefined;
  }

  async failure(owner: string, step: string, error: unknown, record?: AttemptRecord, rejected = false): Promise<OwnerReadError> {
    record = await this.current().catch(() => undefined) ?? record;
    const acquisitionPending = record !== undefined && record.entries.some(e => e.kind === "requested") &&
      !record.entries.some(e => e.kind === "leased" || e.kind === "halted" && e.data.stage === "acquire" && e.data.reason !== "outcome_unknown");
    const integrationPending = record?.entries.some(e => e.kind === "integration_started" &&
      !record.entries.some(r => r.kind === "integrated" && r.data.commit === e.data.commit && r.data.targetBranch === e.data.targetBranch) &&
      !record.confirmations?.some(c => c.fact === "owner_read_reconciled" && c.scope.outcome === "not_happened" && effectBefore(record, c.scope.failureSequence)?.sequence === e.sequence));
    const rebasePending = record?.entries.some(e => e.kind === "rebase_started" &&
      !record.entries.some(r => r.sequence > e.sequence && (r.kind === "output_rebased" && r.data.rebasedFrom === e.data.original || r.kind === "rebase_aborted" && r.data.original === e.data.original) && r.data.onto === e.data.onto) &&
      !record.confirmations?.some(c => c.fact === "owner_read_reconciled" && c.scope.outcome === "not_happened" && effectBefore(record, c.scope.failureSequence)?.sequence === e.sequence));
    const effectAttempted = this.effectAttempted || (!!record && (!!pendingReturn(record) ||
      unsettledReads(record).length > 0 || acquisitionPending || integrationPending || rebasePending)) ||
      (!record && (this.operation === "finish" || this.operation === "discard"));
    const failure: ReadFailure = { owner, classification: classifyFailure(rejected && !effectAttempted ? { step: "rejection" } : { step: "read", effectAttempted }),
      operation: this.operation, step, failedAt: new Date().toISOString(), diagnostics: readDiagnostics(error) };
    const ref = record ?? this.record;
    if (ref) {
      try { await this.deps.attempts.append(ref, "owner_read_failed", failure); }
      catch (error) { failure.diagnostics.message += `. The failure record could not be written: ${readDiagnostics(error).message}`; }
    }
    return new OwnerReadError(failure);
  }

  async read<T>(owner: string, step: string, load: () => Promise<T> | T): Promise<T> {
    try { return await load(); }
    catch (error) {
      if (error instanceof OwnerReadError) throw error;
      throw await this.failure(owner, step, error);
    }
  }

  async observations(values: readonly (readonly [string, Observation<unknown>])[], step: string, record?: AttemptRecord): Promise<void> {
    const failures: ReadFailure[] = [];
    for (const [owner, value] of values) if (!value.known) failures.push((await this.failure(owner, step, value.error ?? value.reason, record)).failure);
    if (failures.length) throw new OwnerReadError(failures.at(-1)!, failures);
  }

  async attempt(observation: AttemptObservation, step: string): Promise<void> {
    const record = observation.record.known ? observation.record.value : undefined;
    if (record) this.record = record;
    await this.observations([["Attempt records", observation.record], ["Treehouse leases", observation.leases], ["Git workspace pool", observation.pool],
      ["Runtime records", observation.runtime], ["Task store", observation.task], ["Dispatcher heartbeat", observation.heartbeat]], step, record);
  }

  async context(observation: ContextObservation, step: string): Promise<void> {
    await this.observations([["Attempt records", observation.records], ["Runtime records", observation.runtime],
      ["Treehouse leases", observation.leases], ["Git workspace pool", observation.pool],
      ...observation.attempts.flatMap(a => [["Task store", a.task], ["Dispatcher heartbeat", a.heartbeat]] as const)], step);
  }

  /** A failed read after an effect or intent cannot authorise further effects on a later invocation. */
  async checkEffects(): Promise<void> {
    const record = await this.read("Attempt records", "check unsettled effects", () => this.current());
    const failed = record && unsettledReads(record)[0];
    if (failed) throw new OwnerReadError(failed.data as ReadFailure);
  }
}

export function readRefusal(error: unknown, stage?: Stage): DispatchResult | undefined {
  if (!(error instanceof OwnerReadError)) return undefined;
  const failure = error.failure;
  const uncertain = failure.classification === "effect_uncertain";
  return result({ ok: false, reason: uncertain ? "reconciliation_required" : "owner_read_retryable", stage: stage ?? (failure.operation === "discard" ? "finish" : failure.operation === "dispatch" ? "preflight" : failure.operation), lease: "unknown",
    observed: { readFailure: failure, ...(error.failures.length > 1 ? { readFailures: error.failures } : {}) }, detail: `${failure.owner} could not be read during ${failure.operation} (${failure.step}): ${failure.diagnostics.message}. ${uncertain
      ? "An effect was attempted or its intent was recorded – inspect the owner and reconcile the outcome; do not repeat the effect"
      : `No effect was attempted – this read can be tried again by running ${failure.operation} again`}`,
    nextAction: uncertain ? "reconcile_owner" : "retry_owner_read" });
}
