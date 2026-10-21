import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AttemptLog, AttemptRecord } from "./log.ts";
import { isMissing, key, readJsonFile, writeOnce } from "../runtime/records.ts";
import { summarise } from "../dispatch/dispatch.ts";

export const reservationSchema = z.strictObject({
  version: z.literal(1), requestId: z.string(), taskId: z.string(), reservedAt: z.iso.datetime(),
});
export const archiveSchema = z.strictObject({
  version: z.literal(1), contextId: z.string(), taskId: z.string(), attempt: z.number().int().positive(),
  archivedAt: z.iso.datetime(), finishedAt: z.iso.datetime(), leaseId: z.string().optional(), pool: z.string().optional(),
  requestId: z.string().optional(), reservation: reservationSchema.optional(),
  summary: z.record(z.string(), z.unknown()),
});
export type ArchivedAttempt = z.infer<typeof archiveSchema>;

/** Immutable summaries also identify cleanup left partway through by an interrupted operator command. */
export class AttemptPruner {
  private readonly log: AttemptLog;
  constructor(log: AttemptLog) { this.log = log; }

  archivePath(ref: { taskId: string; attempt: number }): string {
    return join(this.log.root, "archive", key(this.log.contextId), key(ref.taskId), `${ref.attempt}.json`);
  }

  private directory(ref: { taskId: string; attempt: number }): string {
    return join(this.log.root, "attempts", key(this.log.contextId), key(ref.taskId), String(ref.attempt));
  }

  private reservationPath(requestId: string): string {
    return join(this.log.root, "request-ids", key(this.log.contextId), `${key(requestId)}.json`);
  }

  async archive(record: AttemptRecord, dryRun = false): Promise<ArchivedAttempt> {
    const summary = summarise(record);
    let reservation;
    if (summary.requestId !== undefined) {
      try { reservation = reservationSchema.parse(await readJsonFile(this.reservationPath(summary.requestId))); }
      catch (error) { if (!isMissing(error)) throw error; }
      if (reservation && (reservation.taskId !== record.taskId || reservation.requestId !== summary.requestId)) {
        throw new Error("The request-ID reservation does not point to this attempt");
      }
      if ((await this.log.list()).filter(r => r.entries[0]?.data.requestId === summary.requestId).length !== 1) {
        throw new Error("The request ID does not identify exactly one attempt");
      }
    }
    const pool = record.entries.find(e => e.kind === "leased")?.data.pool ?? record.entries[0]?.data.pool;
    const value = archiveSchema.parse({
      version: 1, contextId: record.contextId, taskId: record.taskId, attempt: record.attempt,
      archivedAt: new Date().toISOString(), finishedAt: record.entries.at(-1)!.recordedAt,
      ...(summary.leaseId ? { leaseId: summary.leaseId } : {}), ...(pool ? { pool } : {}),
      ...(summary.requestId !== undefined ? { requestId: summary.requestId } : {}), ...(reservation ? { reservation } : {}),
      summary: {
        ...summary, entryCount: record.entries.length,
        facts: Object.fromEntries(record.entries.filter(e => e.kind !== "operator_request")
          .map(({ kind, recordedAt, data }) => [kind, { recordedAt, data }])),
      },
    });
    const path = this.archivePath(record);
    await this.checkArchiveDirectory(key(record.taskId));
    const existingArchive = async () => {
      const existing = archiveSchema.parse(await readJsonFile(path));
      if (existing.finishedAt !== value.finishedAt || JSON.stringify(existing.summary) !== JSON.stringify(value.summary)
        || JSON.stringify(existing.reservation) !== JSON.stringify(value.reservation)) throw new Error("The attempt changed after it was archived");
      return existing;
    };
    try { return await existingArchive(); }
    catch (error) { if (!isMissing(error)) throw error; }
    if (dryRun) return value;
    let directory = this.log.root;
    for (const part of ["archive", key(this.log.contextId), key(record.taskId)]) {
      directory = join(directory, part);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await safeDirectory(directory);
    }
    try { await writeOnce(path, value); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      return existingArchive();
    }
    return value;
  }

  async pending(): Promise<ArchivedAttempt[]> {
    const context = join(this.log.root, "attempts", key(this.log.contextId));
    const pending: ArchivedAttempt[] = [];
    let tasks;
    try { tasks = await readdir(context); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    for (const task of tasks) {
      for (const name of await readdir(join(context, task))) {
        const match = /^\.(\d+)\.pruned$/.exec(name);
        if (!match) continue;
        const directory = join(context, task, name);
        await safeDirectory(directory);
        if (await lstat(join(directory, ".complete")).then(() => true, () => false)) continue;
        await this.checkArchiveDirectory(task);
        const value = archiveSchema.parse(await readJsonFile(join(this.log.root, "archive", key(this.log.contextId), task, `${match[1]}.json`)));
        if (value.contextId !== this.log.contextId || key(value.taskId) !== task || String(value.attempt) !== match[1]) throw new Error("Archive identity does not match its location");
        pending.push(value);
      }
    }
    return pending;
  }

  private async checkArchiveDirectory(task: string): Promise<void> {
    let directory = this.log.root;
    for (const part of ["archive", key(this.log.contextId), task]) {
      directory = join(directory, part);
      try { await safeDirectory(directory); }
      catch (error) { if (isMissing(error)) return; throw error; }
    }
  }

  /** The context's prune lock, held by one prune run at a time so two runs never complete the same cleanup. */
  lockPath(): string {
    return join(this.log.root, `prune-lock-${key(this.log.contextId)}`);
  }

  /** Takes the prune lock by creating it exclusively, or returns false if another run holds it. */
  async lock(): Promise<boolean> {
    try { await mkdir(this.lockPath(), { mode: 0o700 }); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
      throw error;
    }
    await writeOnce(join(this.lockPath(), "owner.json"), { version: 1, pid: process.pid, startedAt: new Date().toISOString() });
    return true;
  }

  async unlock(): Promise<void> {
    await rm(this.lockPath(), { recursive: true, force: true });
  }

  async remove(value: ArchivedAttempt): Promise<void> {
    const source = this.directory(value);
    const tombstone = join(source, "..", `.${value.attempt}.pruned`);
    try { await safeDirectory(source); await rename(source, tombstone); }
    catch (error) { if (!isMissing(error)) throw error; await safeDirectory(tombstone); }
    // Runtime readers accept only complete lease directories. Move the whole directory out of their namespace first.
    if (value.leaseId) {
      const runtime = join(this.log.root, key(value.contextId), key(value.leaseId));
      const trash = join(tombstone, ".runtime");
      try { await safeDirectory(runtime); await rename(runtime, trash); }
      catch (error) { if (!isMissing(error)) throw error; }
      await rm(trash, { recursive: true, force: true });
    }
    if (value.reservation && value.requestId !== undefined) {
      const path = this.reservationPath(value.requestId);
      try {
        const current = reservationSchema.parse(await readJsonFile(path));
        // A reused request ID belongs to a new attempt and must not be released by an old cleanup.
        const stillReferenced = await this.log.findByRequest(value.requestId);
        if (!stillReferenced && JSON.stringify(current) === JSON.stringify(value.reservation)) await rm(path);
      } catch (error) { if (!isMissing(error)) throw error; }
    }
    for (const name of await readdir(tombstone)) await rm(join(tombstone, name), { recursive: true, force: true });
    // Keep an empty marker (apart from this receipt) so later attempts never reuse the number or output branch.
    await writeOnce(join(tombstone, ".complete"), { version: 1 });
  }
}

async function safeDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe pruning directory");
}
