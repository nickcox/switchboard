export class RuntimeFailure extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Observations may fail before their consumer begins waiting.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

export async function bounded<T>(
  promise: Promise<T>, ms: number, reason: string, signal?: AbortSignal,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error("Timeout must be positive");
  if (signal?.aborted) throw new RuntimeFailure("interrupted", "Operator interrupted the worker");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RuntimeFailure(reason, `Deadline exceeded: ${reason}`)), ms);
    if (signal) {
      onAbort = () => reject(new RuntimeFailure("interrupted", "Operator interrupted the worker"));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try { return await Promise.race([promise, limit]); }
  finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
