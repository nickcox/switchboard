import type { AttemptRecord } from "../attempts/log.ts";
import type { Dependencies } from "./dependencies.ts";
import { classifyFailure, OwnerReadError, readDiagnostics, type ReadFailure } from "./failure.ts";
import { result, type DispatchResult } from "./result.ts";

/** Read boundaries declared by finish/discard, not a general exception handler. */
export class OwnerReads {
  effectAttempted = false;
  readonly deps: Dependencies;
  readonly operation: "finish" | "discard";
  readonly leaseId: string;
  constructor(deps: Dependencies, operation: "finish" | "discard", leaseId: string) {
    this.deps = deps;
    this.operation = operation;
    this.leaseId = leaseId;
  }

  async failure(owner: string, step: string, error: unknown, record?: AttemptRecord, rejected = false): Promise<OwnerReadError> {
    record = await this.deps.attempts.findByLease(this.leaseId) ?? record;
    const effectAttempted = this.effectAttempted || !record || record.entries.some(e => e.kind === "lease_return_started");
    const failure: ReadFailure = { owner, classification: classifyFailure(rejected && !effectAttempted ? { step: "rejection" } : { step: "read", effectAttempted }),
      operation: this.operation, step, failedAt: new Date().toISOString(), diagnostics: readDiagnostics(error) };
    if (record) await this.deps.attempts.append(record, "owner_read_failed", failure);
    return new OwnerReadError(failure);
  }

  async read<T>(owner: string, step: string, load: () => Promise<T>): Promise<T> {
    try { return await load(); }
    catch (error) {
      if (error instanceof OwnerReadError) throw error;
      throw await this.failure(owner, step, error);
    }
  }

  /** A failed read after an effect or intent cannot authorise further effects on a later invocation. */
  async checkEffects(): Promise<void> {
    const record = await this.deps.attempts.findByLease(this.leaseId);
    if (record?.entries.some(e => e.kind === "lease_returned") || record?.confirmations?.some(c => c.fact === "lease_returned")) return;
    const failed = [...(record?.entries ?? [])].reverse().find(e => e.kind === "owner_read_failed" && e.data.classification === "effect_uncertain");
    if (failed) throw new OwnerReadError(failed.data as ReadFailure);
  }
}

export function readRefusal(error: unknown): DispatchResult | undefined {
  if (!(error instanceof OwnerReadError)) return undefined;
  const failure = error.failure;
  const uncertain = failure.classification === "effect_uncertain";
  return result({ ok: false, reason: uncertain ? "reconciliation_required" : "owner_read_retryable", stage: "finish", lease: "unknown",
    observed: { readFailure: failure }, detail: `${failure.owner} could not be read during ${failure.operation} (${failure.step}): ${failure.diagnostics.message}. ${uncertain
      ? "An effect was attempted or its intent was recorded – inspect the owner and reconcile the outcome; do not repeat the effect"
      : `No effect was attempted – this read can be tried again by running ${failure.operation} again`}`,
    nextAction: uncertain ? "reconcile_owner" : "retry_owner_read" });
}
