import type { RuntimeAddress } from "./store.ts";

const freshMs = 30_000;

/** A heartbeat dated in the future is not fresh. */
export function heartbeatFresh(heartbeatAt: string, now = Date.now()): boolean {
  const age = now - Date.parse(heartbeatAt);
  return age >= 0 && age < freshMs;
}

/** Diagnostic only: absence or staleness never proves that the worker has stopped. */
export async function dispatcherRunning(record: RuntimeAddress, now?: number): Promise<boolean> {
  try { return await readDispatcherHeartbeat(record, now); }
  catch { return false; }
}

/** Unlike the diagnostic helper, owner observation must distinguish an unreadable claim from a missing one. */
export async function readDispatcherHeartbeat(record: RuntimeAddress, now?: number): Promise<boolean> {
  const claim = await record.storage.heartbeat(record.claimId);
  if (!claim || claim.released_at !== null) return false;
  return heartbeatFresh(String(claim.heartbeat_at), now);
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
