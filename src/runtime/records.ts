import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { identitySchema, sameIdentity, workerInputSchema, type WorkerInput } from "./contracts.ts";

export const bindingSchema = z.strictObject({
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  input: workerInputSchema,
  sessionDirectory: z.string(),
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
export type RuntimeRecord = {
  directory: string;
  binding: RuntimeBinding;
  child: { status: "exited"; exit: ChildExit } | { status: "unknown" };
};

export function key(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function inside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

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
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > maxBytes) throw new Error("JSON file exceeds byte limit");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { await handle.close(); }
}

export async function writeOnce(path: string, value: unknown): Promise<void> {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(data, "utf8") > maxRecordBytes) throw new Error("Runtime record exceeds byte limit");
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally { await file.close(); }
}

/** Runtime-owned identity/input and observed child-exit facts, not dispatcher lifecycle state. */
export class RuntimeRecords {
  constructor(private readonly root: string) {
    if (!isAbsolute(root)) throw new Error("Runtime storage root must be absolute");
  }

  async reserve(value: WorkerInput): Promise<{ directory: string; binding: RuntimeBinding }> {
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
    const sessionDirectory = join(directory, "sessions");
    await mkdir(sessionDirectory, { mode: 0o700 });
    const binding = bindingSchema.parse({
      version: 1, createdAt: new Date().toISOString(),
      input: { ...input, workspace }, sessionDirectory, resultPath: join(directory, "result.json"),
    });
    await writeOnce(join(directory, "binding.json"), binding);
    return { directory, binding };
  }

  async recordChildExit(record: Pick<RuntimeRecord, "directory" | "binding">, exit: ChildExit): Promise<void> {
    await writeOnce(join(record.directory, "child-exit.json"), receiptSchema.parse({
      version: 1, identity: record.binding.input.identity,
      observedAt: new Date().toISOString(), childExit: exit,
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
      const binding = bindingSchema.parse(await readJsonFile(join(directory, "binding.json")));
      if (binding.input.identity.contextId !== contextId || key(binding.input.identity.leaseId) !== entry.name ||
        binding.resultPath !== join(directory, "result.json") || binding.sessionDirectory !== join(directory, "sessions")) {
        throw new Error("Runtime binding does not match its storage identity");
      }
      let child: RuntimeRecord["child"] = { status: "unknown" };
      try {
        const receipt = receiptSchema.parse(await readJsonFile(join(directory, "child-exit.json")));
        if (!sameIdentity(receipt.identity, binding.input.identity)) throw new Error("Stale child-exit receipt");
        child = { status: "exited", exit: receipt.childExit };
      } catch (error) { if (!isMissing(error)) throw error; }
      records.push({ directory, binding, child });
    }
    return records;
  }
}

export function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
