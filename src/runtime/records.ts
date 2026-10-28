import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { Caller } from "../caller.ts";
import type { Database } from "../database.ts";
import { inside, requireRetainedStorage } from "../infra/storage.ts";
export { inside } from "../infra/storage.ts";
import { workerInputSchema, type WorkerInput } from "./contracts.ts";
import { RuntimeStore, type RuntimeAddress } from "./store.ts";
import { parseValidatedResult, recordValidatedResult, resultDiscrepancy, type ValidatedResult } from "./validated-result.ts";

import { thinkingLevelSchema, type ThinkingLevel } from "./settings.ts";
export { thinkingLevelSchema, type ThinkingLevel } from "./settings.ts";
export const bindingSchema = z.strictObject({
  version: z.literal(1), createdAt: z.iso.datetime(), input: workerInputSchema,
  sessionDirectory: z.string(), artefactDirectory: z.string(), resultPath: z.string(),
});
export type RuntimeBinding = z.infer<typeof bindingSchema>;
export const childExitSchema = z.strictObject({ started: z.boolean(), code: z.number().int().nullable(), signal: z.string().nullable() });
export type ChildExit = z.infer<typeof childExitSchema>;
export type RuntimeRecord = RuntimeAddress & {
  binding: RuntimeBinding;
  thinkingLevel?: ThinkingLevel;
  validatedResult?: ValidatedResult;
  resultDiscrepancy?: string;
  /** A direct-child exit is an observation; an operator confirmation is not. */
  child:
    | { status: "exited"; exit: ChildExit }
    | { status: "operator_confirmed_stopped"; confirmedAt: string; note?: string }
    | { status: "unknown" };
};
export function key(value: string): string { return createHash("sha256").update(value).digest("hex"); }
const maxRecordBytes = 1024 * 1024;

/** Bounded, regular-file JSON read. A worker result is data, never executable content. */
export async function readJsonFile(path: string, maxBytes = maxRecordBytes): Promise<unknown> {
  return (await readJsonDocument(path, maxBytes)).value;
}

export async function readJsonDocument(path: string, maxBytes = maxRecordBytes): Promise<{ value: unknown; digest: string }> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Expected a regular JSON file");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.ino !== before.ino || actual.dev !== before.dev) throw new Error("JSON file identity changed during open");
    let bytes = Buffer.allocUnsafe(Math.min(actual.size, maxBytes) + 1);
    let length = 0;
    while (true) {
      if (length === bytes.length) {
        if (length > maxBytes) break;
        const grown = Buffer.allocUnsafe(Math.min(bytes.length * 2, maxBytes + 1));
        bytes.copy(grown, 0, 0, length);
        bytes = grown;
      }
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > maxBytes) throw new Error("JSON file exceeds byte limit");
    const content = bytes.subarray(0, length);
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)), digest: createHash("sha256").update(content).digest("hex") };
  } finally { await handle.close(); }
}

/** Exclusive filesystem probe, also used by the legacy import fixtures. */
export async function writeOnce(path: string, value: unknown): Promise<void> {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(data, "utf8") > maxRecordBytes) throw new Error("Runtime record exceeds byte limit");
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  try { await link(temporary, path); } finally { await unlink(temporary).catch(() => {}); }
}

/** Worker-written files live under root; all dispatcher records live in the shared database. */
export class RuntimeRecords {
  readonly storage: RuntimeStore;
  private readonly write: typeof writeOnce;
  private readonly root: string;
  constructor(root: string, source: Database | string = join(root, "switchboard.db"), write: typeof writeOnce = writeOnce) {
    if (!isAbsolute(root)) throw new Error("Runtime storage root must be absolute");
    this.root = root;
    this.storage = new RuntimeStore(source);
    this.write = write;
  }

  async owns(directory: string): Promise<boolean> {
    const root = await realpath(this.root).catch(error => { if (isMissing(error)) return undefined; throw error; });
    if (root === undefined) return false;
    const path = await realpath(directory);
    return path !== root && inside(root, path);
  }
  async checkStorage(recyclableRoots: string[]): Promise<void> { await requireRetainedStorage(this.root, recyclableRoots); }
  async probeExclusiveCreation(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, `exclusive-probe-${randomUUID()}.json`);
    try {
      await this.write(path, { probe: 1 });
      try { await this.write(path, { probe: 2 }); }
      catch (error) { if ((error as { code?: string }).code === "EEXIST") return; throw error; }
      throw new Error("Exclusive creation did not fail with EEXIST when the probe already existed");
    } finally { await unlink(path).catch(error => { if (!isMissing(error)) throw error; }); }
  }

  async reserve(value: WorkerInput, beforeLaunch?: (record: RuntimeRecord) => Promise<void>): Promise<RuntimeRecord> {
    const input = workerInputSchema.parse(value);
    if (!isAbsolute(input.workspace)) throw new Error("Worker workspace must be absolute");
    const workspace = await realpath(input.workspace);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.root);
    if (inside(workspace, root)) throw new Error("Runtime evidence must be outside the worker workspace");
    const context = join(root, key(input.identity.contextId));
    await mkdir(context, { recursive: true, mode: 0o700 });
    const existing = await lstat(context);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Unsafe runtime context directory");
    const directory = join(context, key(input.identity.leaseId));
    const binding = bindingSchema.parse({ version: 1, createdAt: new Date().toISOString(), input: { ...input, workspace },
      sessionDirectory: join(directory, "sessions"), artefactDirectory: join(directory, "artefacts"), resultPath: join(directory, "result.json") });
    if (Buffer.byteLength(JSON.stringify(binding), "utf8") > maxRecordBytes) throw new Error("Runtime binding exceeds byte limit");
    const attempt = await this.storage.attempt(input.identity.contextId, input.identity.leaseId);
    if (attempt.task !== input.identity.taskId) throw new Error("Launch task differs from its attempt");
    const claimId = (await this.storage.claimLaunch({ context: input.identity.contextId, ...attempt, leaseId: input.identity.leaseId, directory, createdAt: binding.createdAt }, binding))!;
    // Permission is committed before any worker can start. A failure after this point never permits another launch.
    await mkdir(directory, { mode: 0o700 });
    await mkdir(binding.sessionDirectory, { mode: 0o700 });
    await mkdir(binding.artefactDirectory, { mode: 0o700 });
    const record: RuntimeRecord = { directory, binding, storage: this.storage, claimId, child: { status: "unknown" } };
    await beforeLaunch?.(record);
    return record;
  }

  async fence(contextId: string, leaseId: string): Promise<boolean> {
    const attempt = await this.storage.attempt(contextId, leaseId);
    const directory = join(this.root, key(contextId), key(leaseId));
    return (await this.storage.claimLaunch({ context: contextId, ...attempt, leaseId, directory, createdAt: new Date().toISOString() })) !== undefined;
  }
  async recordSessionStart(record: Pick<RuntimeRecord, "directory">, thinkingLevel: ThinkingLevel): Promise<void> {
    await this.storage.recordObservation(record.directory, "session_start", thinkingLevelSchema.parse(thinkingLevel));
  }
  async recordValidatedResult(record: Pick<RuntimeRecord, "storage" | "directory" | "binding">): Promise<ValidatedResult> {
    return recordValidatedResult(record);
  }
  async recordChildExit(record: Pick<RuntimeRecord, "directory">, exit: ChildExit): Promise<void> {
    await this.storage.recordObservation(record.directory, "exit", childExitSchema.parse(exit));
  }
  async recordOperatorStop(record: Pick<RuntimeRecord, "directory">, caller: Caller, note?: string): Promise<void> {
    await this.storage.confirmStopped(record.directory, caller, note);
  }
  async discover(contextId: string, selector: { leaseId?: string; taskId?: string } = {}): Promise<RuntimeRecord[]> {
    const context = await lstat(join(this.root, key(contextId))).catch(error => { if (!isMissing(error)) throw error; });
    if (context && (!context.isDirectory() || context.isSymbolicLink())) throw new Error("Unsafe runtime context directory");
    const records: RuntimeRecord[] = [];
    for (const row of await this.storage.discover(contextId, selector)) {
      const binding = bindingSchema.parse(JSON.parse(String(row.binding)));
      const directory = String(row.directory);
      if (binding.input.identity.contextId !== contextId || binding.input.identity.leaseId !== row.lease_id ||
        binding.resultPath !== join(directory, "result.json") || binding.sessionDirectory !== join(directory, "sessions") ||
        binding.artefactDirectory !== join(directory, "artefacts")) throw new Error("Runtime binding does not match its storage identity");
      const exit = await this.storage.observation(directory, "exit");
      const stop = await this.storage.stopConfirmation(directory);
      const thinking = await this.storage.observation(directory, "session_start");
      const value = await this.storage.observation(directory, "validated_result");
      const validated = value === undefined ? undefined : parseValidatedResult(value, binding);
      const discrepancy = validated === undefined ? undefined : await resultDiscrepancy(validated);
      records.push({ directory, binding, storage: this.storage, claimId: String(row.claim_id),
        ...(validated === undefined ? {} : { validatedResult: validated }),
        ...(discrepancy === undefined ? {} : { resultDiscrepancy: discrepancy }),
        child: exit !== undefined ? { status: "exited", exit: childExitSchema.parse(exit) } : stop ? { status: "operator_confirmed_stopped", ...stop } : { status: "unknown" },
        ...(thinking === undefined ? {} : { thinkingLevel: thinkingLevelSchema.parse(thinking) }) });
    }
    return records;
  }
}
export function isMissing(error: unknown): boolean { return (error as { code?: string } | null)?.code === "ENOENT"; }
