import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { inside, requireRetainedStorage } from "../infra/storage.ts";
export { inside } from "../infra/storage.ts";
import { identitySchema, sameIdentity, workerInputSchema, type WorkerInput } from "./contracts.ts";

export const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
const sessionStartSchema = z.strictObject({
  version: z.literal(1), identity: identitySchema, observedAt: z.iso.datetime(), thinkingLevel: thinkingLevelSchema,
});

export const bindingSchema = z.strictObject({
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  input: workerInputSchema,
  sessionDirectory: z.string(),
  /** Where the worker writes reports and other artefacts, outside the recyclable workspace. Absent in older records. */
  artefactDirectory: z.string().optional(),
  resultPath: z.string(),
});
export type RuntimeBinding = z.infer<typeof bindingSchema>;
export const childExitSchema = z.strictObject({
  started: z.boolean(),
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
});
export type ChildExit = z.infer<typeof childExitSchema>;
const receiptSchema = z.strictObject({
  version: z.literal(1),
  identity: identitySchema,
  observedAt: z.iso.datetime(),
  childExit: childExitSchema,
});
const operatorStopSchema = z.strictObject({
  version: z.literal(1),
  identity: identitySchema,
  confirmedAt: z.iso.datetime(),
  note: z.string().max(2000).optional(),
});
export type RuntimeRecord = {
  directory: string;
  binding: RuntimeBinding;
  thinkingLevel?: z.infer<typeof thinkingLevelSchema>;
  /**
   * `exited` is an observed direct-child exit. `operator_confirmed_stopped` means no exit was observed and an operator
   * confirmed the worker had stopped; it is a statement by the operator, not an observation by the runtime.
   */
  child:
    | { status: "exited"; exit: ChildExit }
    | { status: "operator_confirmed_stopped"; confirmedAt: string; note?: string }
    | { status: "unknown" };
};

export function key(value: string): string { return createHash("sha256").update(value).digest("hex"); }

const maxRecordBytes = 1024 * 1024;

/** Bounded, regular-file JSON read. A worker result is data, never executable content. */
export async function readJsonFile(path: string, maxBytes = maxRecordBytes): Promise<unknown> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Expected a regular JSON file");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.ino !== before.ino || actual.dev !== before.dev) {
      throw new Error("JSON file identity changed during open");
    }
    // Size the buffer from the file, not the limit, and grow it if the file is longer than its size said.
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
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { await handle.close(); }
}

/**
 * Writes a file that must never be replaced. The content is written to a temporary file first and then hard-linked to
 * its final name, which fails with EEXIST if the name exists, so a reader sees either no file or the complete file.
 * Temporary files start with "." and readers ignore them.
 */
export async function writeOnce(path: string, value: unknown): Promise<void> {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(data, "utf8") > maxRecordBytes) throw new Error("Runtime record exceeds byte limit");
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally { await file.close(); }
  try { await link(temporary, path); }
  finally { await unlink(temporary).catch(() => {}); }
}

/** Runtime-owned identity/input and observed child-exit facts, not dispatcher lifecycle state. */
export class RuntimeRecords {
  private readonly root: string;
  private readonly write: typeof writeOnce;
  constructor(root: string, write: typeof writeOnce = writeOnce) {
    if (!isAbsolute(root)) throw new Error("Runtime storage root must be absolute");
    this.root = root;
    this.write = write;
  }

  /** Whether `directory`, once its links are resolved, is strictly inside this runtime root. */
  async owns(directory: string): Promise<boolean> {
    const root = await realpath(this.root).catch(error => { if (isMissing(error)) return undefined; throw error; });
    if (root === undefined) return false;
    const path = await realpath(directory);
    return path !== root && inside(root, path);
  }

  async checkStorage(recyclableRoots: string[]): Promise<void> {
    await requireRetainedStorage(this.root, recyclableRoots);
  }

  /** Check the configured filesystem, not just the host OS, before dispatch can select work. */
  async probeExclusiveCreation(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // Keep probes outside context directories, where runtime readers never look.
    const path = join(this.root, `exclusive-probe-${randomUUID()}.json`);
    try {
      await this.write(path, { probe: 1 });
      try { await this.write(path, { probe: 2 }); }
      catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return;
        throw error;
      }
      throw new Error("Exclusive creation did not fail with EEXIST when the probe already existed");
    } finally {
      await unlink(path).catch(error => { if (!isMissing(error)) throw error; });
    }
  }

  /**
   * `beforeBinding` runs once the directory is claimed and before the binding is written, so a dispatcher heartbeat can
   * exist for as long as the directory does.
   */
  async reserve(value: WorkerInput, beforeBinding?: (directory: string) => Promise<void>): Promise<{ directory: string; binding: RuntimeBinding }> {
    const input = workerInputSchema.parse(value);
    if (!isAbsolute(input.workspace)) throw new Error("Worker workspace must be absolute");
    const workspace = await realpath(input.workspace);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.root);
    if (inside(workspace, root)) throw new Error("Runtime evidence must be outside the worker workspace");
    const context = join(root, key(input.identity.contextId));
    try { await mkdir(context, { mode: 0o700 }); }
    catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
      const existing = await lstat(context);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Unsafe runtime context directory");
    }
    const directory = join(context, key(input.identity.leaseId));
    // Exclusive allocation prevents another session from reusing this lease, even after a crash.
    await mkdir(directory, { mode: 0o700 });
    await beforeBinding?.(directory);
    const sessionDirectory = join(directory, "sessions");
    await mkdir(sessionDirectory, { mode: 0o700 });
    const artefactDirectory = join(directory, "artefacts");
    await mkdir(artefactDirectory, { mode: 0o700 });
    const binding = bindingSchema.parse({
      version: 1, createdAt: new Date().toISOString(),
      input: { ...input, workspace }, sessionDirectory, artefactDirectory, resultPath: join(directory, "result.json"),
    });
    await this.write(join(directory, "binding.json"), binding);
    return { directory, binding };
  }

  /**
   * Claims a lease's runtime directory without starting a worker, so that a dispatcher that has not yet reserved it
   * can no longer do so: reserve() creates the same directory exclusively. Returns false if it already exists.
   */
  async fence(contextId: string, leaseId: string): Promise<boolean> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const context = join(await realpath(this.root), key(contextId));
    await mkdir(context, { recursive: true, mode: 0o700 });
    const existing = await lstat(context);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Unsafe runtime context directory");
    try {
      await mkdir(join(context, key(leaseId)), { mode: 0o700 });
      return true;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return false;
      throw error;
    }
  }

  async recordSessionStart(record: Pick<RuntimeRecord, "directory" | "binding">, thinkingLevel: z.infer<typeof thinkingLevelSchema>): Promise<void> {
    await this.write(join(record.directory, "session-start.json"), sessionStartSchema.parse({
      version: 1, identity: record.binding.input.identity, observedAt: new Date().toISOString(), thinkingLevel,
    }));
  }

  async recordChildExit(record: Pick<RuntimeRecord, "directory" | "binding">, exit: ChildExit): Promise<void> {
    await this.write(join(record.directory, "child-exit.json"), receiptSchema.parse({
      version: 1, identity: record.binding.input.identity,
      observedAt: new Date().toISOString(), childExit: exit,
    }));
  }

  /** Records an operator's confirmation that a worker with no observed exit has stopped. Written once. */
  async recordOperatorStop(record: Pick<RuntimeRecord, "directory" | "binding">, note?: string): Promise<void> {
    await this.write(join(record.directory, "operator-stopped.json"), operatorStopSchema.parse({
      version: 1, identity: record.binding.input.identity, confirmedAt: new Date().toISOString(),
      ...(note === undefined ? {} : { note }),
    }));
  }

  async discover(contextId: string): Promise<RuntimeRecord[]> {
    let root: string;
    try { root = await realpath(this.root); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const context = join(root, key(contextId));
    let entries;
    try {
      const selected = await lstat(context);
      if (!selected.isDirectory() || selected.isSymbolicLink()) throw new Error("Unsafe runtime context directory");
      entries = await readdir(context, { withFileTypes: true });
    }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const records: RuntimeRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) {
        throw new Error("Uninspectable runtime storage entry");
      }
      const directory = join(context, entry.name);
      let bindingValue: unknown;
      try { bindingValue = await readJsonFile(join(directory, "binding.json")); }
      catch (error) {
        // reserve() is still creating this directory. The worker is only started after its binding is written,
        // so no worker can exist for a directory without one.
        if (isMissing(error)) continue;
        throw error;
      }
      const binding = bindingSchema.parse(bindingValue);
      if (binding.input.identity.contextId !== contextId || key(binding.input.identity.leaseId) !== entry.name ||
        binding.resultPath !== join(directory, "result.json") || binding.sessionDirectory !== join(directory, "sessions") ||
        (binding.artefactDirectory !== undefined && binding.artefactDirectory !== join(directory, "artefacts"))) {
        throw new Error("Runtime binding does not match its storage identity");
      }
      let child: RuntimeRecord["child"] = { status: "unknown" };
      try {
        const receipt = receiptSchema.parse(await readJsonFile(join(directory, "child-exit.json")));
        if (!sameIdentity(receipt.identity, binding.input.identity)) throw new Error("Stale child-exit receipt");
        child = { status: "exited", exit: receipt.childExit };
      } catch (error) { if (!isMissing(error)) throw error; }
      if (child.status === "unknown") {
        try {
          const stop = operatorStopSchema.parse(await readJsonFile(join(directory, "operator-stopped.json")));
          if (!sameIdentity(stop.identity, binding.input.identity)) throw new Error("Stale operator stop record");
          child = { status: "operator_confirmed_stopped", confirmedAt: stop.confirmedAt, ...(stop.note === undefined ? {} : { note: stop.note }) };
        } catch (error) { if (!isMissing(error)) throw error; }
      }
      let thinkingLevel: RuntimeRecord["thinkingLevel"];
      try {
        const start = sessionStartSchema.parse(await readJsonFile(join(directory, "session-start.json")));
        if (!sameIdentity(start.identity, binding.input.identity)) throw new Error("Stale session-start record");
        thinkingLevel = start.thinkingLevel;
      } catch (error) { if (!isMissing(error)) throw error; }
      records.push({ directory, binding, child, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) });
    }
    return records;
  }
}

export function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
