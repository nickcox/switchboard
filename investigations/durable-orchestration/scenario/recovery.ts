import type { ApplicationStore } from "../design-a/store.ts";
import { refuse, type Attempt, type Outcome } from "./contract.ts";

export const ownerReadLimit = 3;
export type ReadFailure = {
  kind: "owner_read" | "effect_uncertain";
  owner: string;
  diagnostics: unknown;
  attempt: number;
};

export class OwnerReadError extends Error {
  readonly failure: ReadFailure;
  readonly attemptId: string;
  constructor(failure: ReadFailure, attemptId: string) {
    super(`${failure.owner} read failed (${failure.attempt}/${ownerReadLimit})`);
    this.failure = failure;
    this.attemptId = attemptId;
  }
}

// Keep adapter fields such as WorkspaceError.detail, stdout, stderr and exit status, not just message.
function diagnostics(error: unknown, seen = new Set<unknown>()): unknown {
  if (error === null || typeof error !== "object") return String(error);
  if (seen.has(error)) return "[circular]";
  seen.add(error);
  return Object.fromEntries(Object.getOwnPropertyNames(error).map(key => {
    const value = (error as Record<string, unknown>)[key];
    return [key, value !== null && typeof value === "object" ? diagnostics(value, seen) : value];
  }));
}

// Only application-declared read calls enter here. An engine exception is never evidence that
// no effect was attempted. An outstanding return intent overrides even a known read-only call.
export async function readOwner<T>(store: ApplicationStore, attempt: Attempt, owner: string, read: () => Promise<T>): Promise<T> {
  const requestId = attempt.request.requestId;
  const exhausted = store.fact<ReadFailure>(requestId, "owner_read_exhausted");
  if (exhausted) throw new OwnerReadError(exhausted, attempt.id);
  try { return await read(); }
  catch (error) {
    let number = 1;
    while (store.fact(requestId, `owner_read_failure:${number}`)) number++;
    const uncertain = store.record(attempt).entries.some(entry => entry.kind === "lease_return_started");
    const failure: ReadFailure = { kind: uncertain ? "effect_uncertain" : "owner_read", owner,
      diagnostics: diagnostics(error), attempt: number };
    await store.addFact(requestId, `owner_read_failure:${number}`, failure);
    if (!uncertain && number >= ownerReadLimit) await store.addFact(requestId, "owner_read_exhausted", failure);
    throw new OwnerReadError(failure, attempt.id);
  }
}

export function recovery(error: unknown): { outcome: Outcome; retry: boolean } | null {
  // A's position-free runner adds step context without changing the operation's classification.
  if (error instanceof Error && !(error instanceof OwnerReadError) && error.cause) return recovery(error.cause);
  if (!(error instanceof OwnerReadError)) return null;
  const failure = error.failure;
  const uncertain = failure.kind === "effect_uncertain";
  const retry = !uncertain && failure.attempt < ownerReadLimit;
  return { retry, outcome: { ...refuse(uncertain ? "finalisation_uncertain" : "owner_unknown", error.attemptId),
    nextAction: `${failure.owner}: ${uncertain ? "Reconcile the return intent and owner; never repeat the effect automatically"
      : retry ? "Read the owner again on the next attempt" : `Read failed after ${ownerReadLimit} attempts; repair the owner and reconcile before continuing`}. Diagnostics: ${JSON.stringify(failure.diagnostics)}` } };
}
