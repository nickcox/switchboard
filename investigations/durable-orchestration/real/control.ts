import { rm } from "node:fs/promises";
import { join } from "node:path";
import { HostClient } from "../design-b/client.ts";
import type { Outcome } from "../scenario/contract.ts";
import { settingsAt } from "./fixture.ts";
import { RealOwners } from "./owners.ts";

export async function inspect(directory: string): Promise<unknown> {
  const owners = await RealOwners.open(directory, await settingsAt(directory));
  try {
    const receipts = await owners.records();
    const attemptIds = [...new Set(receipts.map(receipt => receipt.attemptId))];
    return { host: await new HostClient(directory).call("inspect"), leases: await owners.provider.leases(),
      pool: await owners.provider.pool(), receipts,
      counters: Object.fromEntries(await Promise.all(attemptIds.map(async id => [id, await owners.counters(id)]))),
      controls: await owners.controls() };
  } finally { await owners.close(); }
}

export async function review(directory: string, attemptId: string, commit: string, decision: "accepted" | "rejected"): Promise<void> {
  const owners = await RealOwners.open(directory, await settingsAt(directory));
  try {
    if (!(await owners.forAttempt(attemptId)).some(receipt => receipt.effect === "worker_exit" && receipt.result?.commit === commit)) {
      throw new Error("Review must name an observed worker result commit");
    }
    await owners.review(attemptId, commit, decision);
  } finally { await owners.close(); }
}

export async function approve(directory: string, scope: {
  attemptId: string; leaseId: string; commit: string; accept: boolean; noProcesses: boolean; expiresMs: number;
}): Promise<void> {
  if (!scope.accept || !Number.isFinite(scope.expiresMs) || scope.expiresMs <= 0) throw new Error("Grant explicit acceptance with a positive expiry");
  const owners = await RealOwners.open(directory, await settingsAt(directory));
  try {
    const result = (await owners.forAttempt(scope.attemptId)).find(receipt => receipt.effect === "worker_exit")?.result;
    if (!result || result.identity.leaseId !== scope.leaseId || result.commit !== scope.commit) throw new Error("Approval scope differs from observed result");
    const controls = await owners.controls();
    await owners.setControls({ ...controls, approvals: [...controls.approvals, {
      id: crypto.randomUUID(), by: "operator", attemptId: scope.attemptId, leaseId: scope.leaseId,
      commit: scope.commit, expiresAt: Date.now() + scope.expiresMs, accept: true, noProcesses: scope.noProcesses,
    }] });
  } finally { await owners.close(); }
}

export async function waitForWorker(directory: string, timeoutMs: number): Promise<Outcome> {
  const settings = await settingsAt(directory);
  const client = new HostClient(directory);
  const deadline = Date.now() + timeoutMs;
  let result: Outcome = await client.advance(settings.request.requestId);
  while (result.status === "waiting" && result.waitingFor === "worker" && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    result = await client.advance(settings.request.requestId);
  }
  return result;
}

export async function recoverClaim(directory: string, confirmedHostStopped: boolean, confirmedNoProcesses: boolean): Promise<void> {
  if (!confirmedHostStopped || !confirmedNoProcesses) throw new Error("Inspect host and worker/tool processes, then explicitly confirm both stopped");
  // Only the fixture claim is removed. No lease, intent, runtime fence or task state changes.
  await rm(join(directory, "host", "owner"), { recursive: true });
}
