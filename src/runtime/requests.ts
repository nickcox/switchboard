import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { identitySchema, sameIdentity } from "./contracts.ts";
import type { RuntimeRecord } from "./records.ts";
import type { RuntimeAddress } from "./store.ts";

/** Requests target one claim. A conditional update makes forwarding and withdrawal mutually exclusive. */
export const requestSchema = z.strictObject({
  version: z.literal(1), id: z.uuid(), kind: z.enum(["stop", "steer", "follow_up"]),
  message: z.string().min(1).max(20000).optional(), sender: z.string().min(1).max(200), label: z.string().min(1).max(200).optional(),
  identity: identitySchema, createdAt: z.iso.datetime(),
});
export type ControlRequest = z.infer<typeof requestSchema>;
const resultSchema = z.strictObject({
  version: z.literal(1), outcome: z.string().min(1), error: z.string().optional(), at: z.iso.datetime(),
});
export type RequestResult = z.infer<typeof resultSchema>;

export async function submitRequest(record: RuntimeAddress & Pick<RuntimeRecord, "binding">,
  request: { kind: ControlRequest["kind"]; message?: string; sender: string; label?: string }): Promise<ControlRequest> {
  if (request.kind !== "stop" && !request.message) throw new Error("A message is required");
  const value = requestSchema.parse({ version: 1, id: randomUUID(), ...request,
    identity: record.binding.input.identity, createdAt: new Date().toISOString() });
  await record.storage.submit(record.claimId, value);
  return value;
}

export async function unclaimedRequests(record: RuntimeAddress & Pick<RuntimeRecord, "binding">): Promise<ControlRequest[]> {
  return (await record.storage.unclaimed(record.claimId)).map(value => requestSchema.parse(value))
    .filter(request => sameIdentity(request.identity, record.binding.input.identity));
}
export async function claimRequest(record: RuntimeAddress, id: string, by: "dispatcher" | "withdrawn"): Promise<boolean> {
  return record.storage.claimRequest(record.claimId, id, by);
}
export async function recordResult(record: RuntimeAddress, id: string, result: Omit<RequestResult, "version" | "at">): Promise<void> {
  await record.storage.recordResult(record.claimId, id, resultSchema.parse({ version: 1, ...result, at: new Date().toISOString() }));
}
export type Delivery =
  | { state: "delivered"; result: RequestResult }
  | { state: "claimed" }
  | { state: "undelivered" };

/** Withdraw only if nobody claimed it; a claimed request is never forwarded again, even after a crash. */
export async function awaitDelivery(record: RuntimeAddress, id: string, waitMs: number, pollMs = 200): Promise<Delivery> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const row = await record.storage.delivery(record.claimId, id);
    if (row?.result) return { state: "delivered", result: resultSchema.parse(JSON.parse(String(row.result))) };
    if (row?.claimed_by === "withdrawn") return { state: "undelivered" };
    if (row?.claimed_by && Date.now() >= deadline + waitMs) return { state: "claimed" };
    if (!row?.claimed_by && Date.now() >= deadline) {
      if (await claimRequest(record, id, "withdrawn")) return { state: "undelivered" };
    }
    await sleep(pollMs);
  }
}
