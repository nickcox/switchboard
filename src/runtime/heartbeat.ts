import type { RuntimeAddress } from "./store.ts";

const freshMs = 30_000;

/** Diagnostic only: absence or staleness never proves that the worker has stopped. */
export async function dispatcherRunning(record: RuntimeAddress, now?: number): Promise<boolean> {
  try {
    const claim = await record.storage.heartbeat(record.claimId);
    if (!claim || claim.released_at !== null) return false;
    const age = (now ?? Date.now()) - Date.parse(String(claim.heartbeat_at));
    return age >= 0 && age < freshMs;
  } catch { return false; }
}

/** Refresh only this dispatcher's claim. Releasing it never removes launch permission or permits a takeover. */
export async function startHeartbeat(record: RuntimeAddress, intervalMs = 5000): Promise<() => Promise<void>> {
  const refresh = () => record.storage.refreshClaim(record.claimId).catch(() => {});
  await refresh();
  let pending = Promise.resolve();
  const timer = setInterval(() => { pending = pending.then(refresh); }, intervalMs);
  return async () => {
    clearInterval(timer);
    await pending;
    await record.storage.releaseClaim(record.claimId);
  };
}
