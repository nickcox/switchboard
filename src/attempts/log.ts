import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { requireRetainedStorage } from "../infra/storage.ts";
import { isMissing, key, readJsonFile, writeOnce } from "../runtime/records.ts";

const nonempty = z.string().min(1).refine(value => value.trim().length > 0);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

/** Why a task outcome was recorded. The attempt's state is classified from this, never from the task store's text. */
export const outcomeCategories = ["done", "review_required", "not_retained", "held_by_worker", "failed", "interrupted", "over_budget"] as const;
export type OutcomeCategory = (typeof outcomeCategories)[number];
/** The end of each hold reason dispatch writes, by category. Entries written before categories are read with it. */
export const holdLabels: Record<OutcomeCategory, string> = {
  done: "done", review_required: "review required", not_retained: "not retained", held_by_worker: "held by worker",
  failed: "failed", interrupted: "interrupted", over_budget: "over budget",
};

/** Entry payloads by kind. New kinds are added as dispatch stages are implemented. */
const entrySchemas = {
  requested: z.strictObject({
    requestId: nonempty.optional(),
    /** The workspace pool acquisition will use. Absent in older entries. */
    pool: nonempty.optional(),
    /** The delivery contract resolved before acquisition: "default" or the task kind that selected it. */
    contract: z.strictObject({
      name: nonempty, kind: z.enum(["code", "artefact"]), acceptance: z.enum(["review_or_integration", "independent_deliverable"]),
      requiredEvidence: z.array(nonempty), requiredDeliverables: z.array(nonempty),
    }).optional(),
  }),
  leased: z.strictObject({
    leaseId: nonempty, workspace: nonempty, baseRef: nonempty, outputBranch: nonempty, startingCommit: commit,
    /** The workspace pool the lease was acquired in. Absent in entries written before it was recorded. */
    pool: nonempty.optional(),
  }),
  task_started: z.strictObject({}),
  launched: z.strictObject({ sessionId: z.uuid() }),
  worker_finished: z.strictObject({
    status: nonempty, runtimeDirectory: nonempty, reason: nonempty.optional(), detail: nonempty.optional(), outcome: nonempty.optional(), resultCommit: commit.optional(),
  }),
  task_recorded: z.strictObject({
    outcome: z.enum(["done", "hold"]),
    /** The hold reason written to the task store, or why the task was recorded as done. */
    reason: nonempty,
    /** Absent in entries written before it was recorded; those are classified from `reason`. */
    category: z.enum(outcomeCategories).optional(),
  }),
  retention_checked: z.strictObject({ retained: z.boolean(), findings: z.array(nonempty), notes: z.array(nonempty) }),
  halted: z.strictObject({
    stage: nonempty, reason: nonempty, detail: nonempty.optional(),
    leaseId: nonempty.optional(), workspace: nonempty.optional(), outputBranch: nonempty.optional(),
  }),
  /** A stop request or operator message the dispatcher forwarded to the running worker, with what happened. */
  operator_request: z.strictObject({
    id: z.uuid(), kind: z.enum(["stop", "steer", "follow_up"]), sender: nonempty, outcome: nonempty,
    message: nonempty.optional(), error: nonempty.optional(),
  }),
  /**
   * An operator confirmed the attempt's worker had stopped although no exit was observed, or that its lease, which
   * is in a workspace pool the provider no longer lists, has been returned.
   */
  operator_resolved: z.strictObject({ action: z.enum(["worker_stopped", "lease_returned"]), note: nonempty.optional() }),
  /** `finish --accept-output`: the operator accepted committed output instead of a worker result. */
  output_accepted: z.strictObject({ commit, acceptedBy: z.literal("operator") }),
  /** `finish` under the local-merge policy fast-forwarded the target branch to the output branch. */
  integrated: z.strictObject({ policy: z.literal("local-merge"), targetBranch: nonempty, commit }),
  /** `discard`: the operator chose to discard the attempt's work. */
  discarded: z.strictObject({ note: nonempty.optional() }),
  /**
   * `finish` or `discard` is about to ask the workspace provider to return the lease, after the operator confirmed no
   * worker process remained. A later run that finds the lease gone records `lease_returned`.
   */
  lease_return_started: z.strictObject({ leaseId: nonempty, by: z.enum(["finish", "discard"]), noProcessesConfirmedBy: z.literal("operator") }),
  /** `finish` or `discard` returned the lease, after the operator confirmed no worker process remained. */
  lease_returned: z.strictObject({ leaseId: nonempty, by: z.enum(["finish", "discard"]), noProcessesConfirmedBy: z.literal("operator") }),
} as const;
export type EntryKind = keyof typeof entrySchemas;
export type EntryData<K extends EntryKind> = z.infer<(typeof entrySchemas)[K]>;

const entryKinds = Object.keys(entrySchemas) as [EntryKind, ...EntryKind[]];
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  contextId: nonempty,
  taskId: nonempty,
  attempt: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  kind: z.enum(entryKinds),
  recordedAt: z.iso.datetime(),
  data: z.record(z.string(), z.unknown()),
});
export type AttemptEntry = z.infer<typeof envelopeSchema>;

export type AttemptRef = { contextId: string; taskId: string; attempt: number };
export type AttemptRecord = AttemptRef & { entries: AttemptEntry[] };

/** Another invocation created this attempt first. Nothing was written by the caller. */
export class AttemptConflict extends Error {
  readonly ref: AttemptRef;
  constructor(ref: AttemptRef) {
    super(`Attempt ${ref.attempt} for task ${ref.taskId} was not created: another attempt is now the latest`);
    this.ref = ref;
  }
}

const entryName = /^(\d{4,})(?:-([a-z_]+))?\.json$/;
const readBatch = 32;

function sequenceOf(name: string): number {
  const match = entryName.exec(name);
  const sequence = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(sequence)) throw new Error("Uninspectable attempt entry sequence");
  return sequence;
}

/**
 * Append-only record of which task, lease, session, commits and outcome belong to each attempt (ADR-0006).
 * It is not authoritative for task, lease or liveness state. Unreadable or inconsistent entries cause refusal.
 */
export class AttemptLog {
  readonly root: string;
  readonly contextId: string;
  constructor(root: string, contextId: string) {
    if (!isAbsolute(root)) throw new Error("Attempt log root must be absolute");
    this.root = root;
    this.contextId = nonempty.parse(contextId);
  }

  async checkStorage(recyclableRoots: string[]): Promise<void> {
    await requireRetainedStorage(this.root, recyclableRoots);
  }

  /**
   * Creates attempt `previous + 1` for a task and writes its first entry. `previous` is the latest attempt the caller
   * has already inspected (0 for none). Creation fails if any other attempt is now the latest, and exclusive directory
   * creation gives one winner when callers race for the same number, so two invocations cannot both start the task.
   */
  async create(taskId: string, requested: EntryData<"requested">, previous: number): Promise<AttemptRef> {
    nonempty.parse(taskId);
    z.number().int().nonnegative().parse(previous);
    const directory = await this.taskDirectory(taskId, true);
    // Pruned directory markers keep attempt numbers from being reused after retention cleanup.
    const pruned = (await readdir(directory)).flatMap(name => {
      const match = /^\.(\d+)\.pruned$/.exec(name);
      return match ? [Number(match[1])] : [];
    });
    const ref = { contextId: this.contextId, taskId, attempt: Math.max(previous, ...pruned) + 1 };
    if (((await this.attemptNumbers(directory)).at(-1) ?? 0) !== previous) throw new AttemptConflict(ref);
    // Build the attempt with its first entry under a temporary name, then rename it into place. Readers never see an
    // attempt without entries, and the rename fails if another invocation created this attempt first.
    const temporary = join(directory, `.${ref.attempt}.${randomUUID()}.tmp`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      await this.write(ref, 0, "requested", requested, temporary);
      await rename(temporary, join(directory, String(ref.attempt)));
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
      // The error code for an existing target differs between platforms (EEXIST, ENOTEMPTY, or EPERM on Windows), so
      // treat any failed rename as a conflict when the attempt now exists.
      if (await lstat(join(directory, String(ref.attempt))).then(() => true, () => false)) throw new AttemptConflict(ref);
      throw error;
    }
    return ref;
  }

  async append<K extends EntryKind>(ref: AttemptRef, kind: K, data: EntryData<K>): Promise<void> {
    const record = await this.read(ref);
    await this.write(ref, record.entries.length, kind, data);
  }

  async read(ref: AttemptRef): Promise<AttemptRecord> {
    const directory = join(await this.taskDirectory(ref.taskId, false), String(ref.attempt));
    return { ...ref, entries: await this.entries(directory, ref) };
  }

  /** All attempts in this context, ordered by task directory then attempt number. */
  async list(): Promise<AttemptRecord[]> {
    const context = await this.contextDirectory(false);
    if (!context) return [];
    const records: AttemptRecord[] = [];
    for (const taskEntry of await readdir(context, { withFileTypes: true })) {
      if (!taskEntry.isDirectory() || !/^[a-f0-9]{64}$/.test(taskEntry.name)) {
        throw new Error("Uninspectable attempt log entry");
      }
      const directory = join(context, taskEntry.name);
      for (const attempt of await this.attemptNumbers(directory)) {
        const first = await this.firstEntry(join(directory, String(attempt)));
        if (key(first.taskId) !== taskEntry.name || first.attempt !== attempt) {
          throw new Error("Attempt entry does not match its storage location");
        }
        records.push(await this.read({ contextId: this.contextId, taskId: first.taskId, attempt }));
      }
    }
    return records;
  }

  async forTask(taskId: string): Promise<AttemptRecord[]> {
    const directory = await this.taskDirectory(taskId, false).catch(error => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (!directory) return [];
    const records = [];
    for (const attempt of await this.attemptNumbers(directory)) {
      records.push(await this.read({ contextId: this.contextId, taskId, attempt }));
    }
    return records;
  }

  /**
   * Reserves a request ID across this context before its attempt is created, by creating a file exclusively. Returns
   * false when another invocation already holds it. Reservations live beside the log, not in it, because the log's
   * context directory holds only task directories.
   */
  async reserveRequest(requestId: string, taskId: string): Promise<boolean> {
    nonempty.parse(requestId);
    const path = await this.requestPath(requestId, true);
    try {
      await writeOnce(path, { version: 1, requestId, taskId, reservedAt: new Date().toISOString() });
      return true;
    } catch (error) {
      if (isCode(error, "EEXIST")) return false;
      throw error;
    }
  }

  /** Releases a reservation whose attempt was never created, so that the request can be made again. */
  async releaseRequest(requestId: string): Promise<void> {
    await rm(await this.requestPath(requestId, false), { force: true });
  }

  private async requestPath(requestId: string, create: boolean): Promise<string> {
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    const directory = join(await realpath(this.root), "request-ids", key(this.contextId));
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    return join(directory, `${key(requestId)}.json`);
  }

  async findByRequest(requestId: string): Promise<AttemptRecord | undefined> {
    return (await this.list()).find(record => record.entries[0]?.data.requestId === requestId);
  }

  private async write<K extends EntryKind>(ref: AttemptRef, sequence: number, kind: K, data: EntryData<K>, into?: string) {
    const entry = envelopeSchema.parse({
      // Only the identity fields: callers may pass a full AttemptRecord as the reference.
      version: 1, contextId: ref.contextId, taskId: ref.taskId, attempt: ref.attempt, sequence, kind, recordedAt: new Date().toISOString(),
      data: entrySchemas[kind].parse(data),
    });
    const directory = into ?? join(await this.taskDirectory(ref.taskId, false), String(ref.attempt));
    // Write-once: a concurrent writer at the same sequence fails rather than replacing an entry.
    await writeOnce(join(directory, `${String(sequence).padStart(4, "0")}.json`), entry);
  }

  private async entries(directory: string, ref: AttemptRef): Promise<AttemptEntry[]> {
    // Names starting with "." are temporary files from an entry still being written.
    const names = (await readdir(directory)).filter(name => !name.startsWith("."));
    names.sort((a, b) => sequenceOf(a) - sequenceOf(b));
    const matches = names.map((name, index) => {
      const match = entryName.exec(name);
      if (!match || sequenceOf(name) !== index) throw new Error("Uninspectable attempt entry sequence");
      return match;
    });
    // Read several files at a time, because a long attempt can have thousands of entries; validate them in order below.
    const values: unknown[] = [];
    for (let start = 0; start < names.length; start += readBatch) {
      values.push(...await Promise.all(names.slice(start, start + readBatch).map(name => readJsonFile(join(directory, name)))));
    }
    const entries: AttemptEntry[] = [];
    for (const [index, match] of matches.entries()) {
      const entry = envelopeSchema.parse(values[index]);
      const data = entrySchemas[entry.kind].parse(entry.data);
      if ((match[2] !== undefined && entry.kind !== match[2]) || entry.sequence !== index || entry.contextId !== ref.contextId ||
        entry.taskId !== ref.taskId || entry.attempt !== ref.attempt) {
        throw new Error("Attempt entry does not match its storage location");
      }
      if ((index === 0) !== (entry.kind === "requested")) throw new Error("Attempt must begin with one requested entry");
      entries.push({ ...entry, data });
    }
    if (entries.length === 0) throw new Error("Attempt has no entries");
    return entries;
  }

  private async firstEntry(directory: string): Promise<AttemptEntry> {
    const first = (await readdir(directory)).filter(name => !name.startsWith("."))
      .sort((a, b) => sequenceOf(a) - sequenceOf(b))[0];
    if (!first) throw new Error("Attempt has no entries");
    return envelopeSchema.parse(await readJsonFile(join(directory, first)));
  }

  private async attemptNumbers(directory: string): Promise<number[]> {
    const numbers: number[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue; // An attempt still being created, or one whose creation lost a race.
      if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) throw new Error("Uninspectable attempt directory");
      numbers.push(Number(entry.name));
    }
    return numbers.sort((a, b) => a - b);
  }

  private async contextDirectory(create: true): Promise<string>;
  private async contextDirectory(create: boolean): Promise<string | undefined>;
  private async contextDirectory(create: boolean): Promise<string | undefined> {
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    let root: string;
    try { root = await realpath(this.root); }
    catch (error) { if (!create && isMissing(error)) return undefined; throw error; }
    // Kept apart from runtime records, whose discovery refuses unexpected entries in a context directory.
    const context = join(root, "attempts", key(this.contextId));
    if (create) await mkdir(context, { recursive: true, mode: 0o700 });
    try { await safeDirectory(context); }
    catch (error) { if (!create && isMissing(error)) return undefined; throw error; }
    return context;
  }

  private async taskDirectory(taskId: string, create: boolean): Promise<string> {
    const context = await this.contextDirectory(create);
    if (!context) throw Object.assign(new Error("No attempt log"), { code: "ENOENT" });
    const directory = join(context, key(taskId));
    if (create) {
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (!isCode(error, "EEXIST")) throw error; }
    }
    await safeDirectory(directory);
    return directory;
  }
}

async function safeDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe attempt log directory");
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
