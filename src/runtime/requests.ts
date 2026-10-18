import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { identitySchema, sameIdentity } from "./contracts.ts";
import { isMissing, readJsonFile, writeOnce, type RuntimeRecord } from "./records.ts";

/**
 * Stop requests and operator messages for a running worker (ADR-0005). Any process may submit one; only the
 * dispatcher that owns the worker forwards it. Each request has a claim file created exclusively, so a request is
 * either forwarded once by the dispatcher or withdrawn by its sender, never both and never twice.
 */
export const requestSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  kind: z.enum(["stop", "steer", "follow_up"]),
  message: z.string().min(1).max(20000).optional(),
  /** Who sent it, for example "operator:alex" or a supervisor's name. */
  sender: z.string().min(1).max(200),
  identity: identitySchema,
  createdAt: z.iso.datetime(),
});
export type ControlRequest = z.infer<typeof requestSchema>;

const claimSchema = z.strictObject({ version: z.literal(1), by: z.enum(["dispatcher", "withdrawn"]), at: z.iso.datetime() });
const resultSchema = z.strictObject({
  version: z.literal(1),
  /** Pi's disposition for a message ("queued" or "handled"), or "stopping" for a stop request. */
  outcome: z.string().min(1),
  error: z.string().optional(),
  at: z.iso.datetime(),
});
export type RequestResult = z.infer<typeof resultSchema>;

const requestsDirectory = (record: Pick<RuntimeRecord, "directory">) => join(record.directory, "requests");
const file = (record: Pick<RuntimeRecord, "directory">, id: string, part: "request" | "claim" | "result") => join(requestsDirectory(record), `${id}.${part}.json`);

/** Submits a request for a worker. It is only a request: the owning dispatcher decides whether it can forward it. */
export async function submitRequest(
  record: Pick<RuntimeRecord, "directory" | "binding">, request: { kind: ControlRequest["kind"]; message?: string; sender: string },
): Promise<ControlRequest> {
  if (request.kind !== "stop" && !request.message) throw new Error("A message is required");
  await mkdir(requestsDirectory(record), { recursive: true, mode: 0o700 });
  const value = requestSchema.parse({
    version: 1, id: randomUUID(), kind: request.kind, ...(request.message ? { message: request.message } : {}),
    sender: request.sender, identity: record.binding.input.identity, createdAt: new Date().toISOString(),
  });
  await writeOnce(file(record, value.id, "request"), value);
  return value;
}

/** Requests for this worker that nobody has claimed yet, oldest first. Invalid or foreign requests are skipped. */
export async function unclaimedRequests(record: Pick<RuntimeRecord, "directory" | "binding">): Promise<ControlRequest[]> {
  let names: string[];
  try { names = await readdir(requestsDirectory(record)); } catch (error) { if (isMissing(error)) return []; throw error; }
  const claimed = new Set(names.filter(n => n.endsWith(".claim.json")).map(n => n.slice(0, -".claim.json".length)));
  const requests: ControlRequest[] = [];
  for (const name of names.filter(n => n.endsWith(".request.json"))) {
    const id = name.slice(0, -".request.json".length);
    if (claimed.has(id)) continue;
    try {
      const request = requestSchema.parse(await readJsonFile(join(requestsDirectory(record), name)));
      if (request.id === id && sameIdentity(request.identity, record.binding.input.identity)) requests.push(request);
    } catch { /* A partly written or invalid request is never forwarded. */ }
  }
  return requests.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Claims a request exclusively. Returns false when the sender or another dispatcher claimed it first. */
export async function claimRequest(record: Pick<RuntimeRecord, "directory">, id: string, by: "dispatcher" | "withdrawn"): Promise<boolean> {
  try {
    await writeOnce(file(record, id, "claim"), claimSchema.parse({ version: 1, by, at: new Date().toISOString() }));
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
}

export async function recordResult(record: Pick<RuntimeRecord, "directory">, id: string, result: Omit<RequestResult, "version" | "at">): Promise<void> {
  await writeOnce(file(record, id, "result"), resultSchema.parse({ version: 1, ...result, at: new Date().toISOString() }));
}

export type Delivery =
  | { state: "delivered"; result: RequestResult }
  /** The dispatcher claimed the request but has not recorded what happened. It is never forwarded again. */
  | { state: "claimed" }
  /** No dispatcher claimed the request in time; the sender withdrew it, so it will never be forwarded. */
  | { state: "undelivered" };

/** Waits for the owning dispatcher to forward a request; withdraws it if nobody claims it within `waitMs`. */
export async function awaitDelivery(record: Pick<RuntimeRecord, "directory">, id: string, waitMs: number, pollMs = 200): Promise<Delivery> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const result = await readJsonFile(file(record, id, "result")).then(value => resultSchema.parse(value), () => undefined);
    if (result) return { state: "delivered", result };
    const claim = await readJsonFile(file(record, id, "claim")).then(value => claimSchema.parse(value), () => undefined);
    if (claim?.by === "withdrawn") return { state: "undelivered" };
    // A claimed request gets one more wait period for the dispatcher to record what happened.
    if (claim && Date.now() >= deadline + waitMs) return { state: "claimed" };
    if (!claim && Date.now() >= deadline) {
      if (await claimRequest(record, id, "withdrawn")) return { state: "undelivered" };
      continue; // The dispatcher claimed it at the last moment; read its outcome.
    }
    await sleep(pollMs);
  }
}
