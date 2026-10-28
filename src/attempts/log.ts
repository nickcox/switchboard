import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { checkResultSchema } from "./checks.ts";
import { isMissing, key, readJsonFile } from "../runtime/records.ts";

const nonempty = z.string().min(1).refine(value => value.trim().length > 0);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

/** Why a task outcome was recorded. The attempt's state is classified from this, never from the task store's text. */
export const outcomeCategories = ["done", "review_required", "not_retained", "held_by_worker", "failed", "interrupted", "over_budget"] as const;
export type OutcomeCategory = (typeof outcomeCategories)[number];
/** Hold reason labels written by dispatch; import also uses them to interpret older entries. */
export const holdLabels: Record<OutcomeCategory, string> = {
  done: "done", review_required: "review required", not_retained: "not retained", held_by_worker: "held by worker",
  failed: "failed", interrupted: "interrupted", over_budget: "over budget",
};

/** Entry payloads by kind. New kinds are added as dispatch stages are implemented. */
// Legacy file schemas also accept old confirmation fields. parseAttemptEntry enforces the database form.
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
  check_finished: checkResultSchema,
  integration_started: z.strictObject({ targetBranch: nonempty, from: commit, commit }),
  owner_read_reconciled: z.strictObject({ failureSequence: z.number().int().nonnegative(), targetBranch: nonempty, commit }),
  leased: z.strictObject({
    leaseId: nonempty, workspace: nonempty, baseRef: nonempty, outputBranch: nonempty, startingCommit: commit,
    /** The workspace pool the lease was acquired in. Absent in entries written before it was recorded. */
    pool: nonempty.optional(),
    backingRepository: nonempty.optional(),
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
    /** The legacy file reader permits absence; import supplies it before database activation. */
    category: z.enum(outcomeCategories).optional(),
    /** False when a newer operator decision kept the task unchanged. */
    applied: z.boolean().optional(),
  }),
  retention_checked: z.strictObject({ retained: z.boolean(), findings: z.array(nonempty), notes: z.array(nonempty) }),
  owner_read_failed: z.strictObject({
    owner: nonempty, classification: z.enum(["owner_read", "approval_required", "effect_uncertain", "rejected"]),
    operation: z.enum(["dispatch", "resolve", "prune", "finish", "discard"]), step: nonempty, failedAt: z.iso.datetime(),
    diagnostics: z.strictObject({
      message: z.string(), command: z.strictObject({
        command: z.strictObject({ executable: nonempty, args: z.array(z.string()) }).optional(),
        exitCode: z.number().int().nullable(), stdout: z.string(), stderr: z.string(), timedOut: z.boolean(), truncated: z.boolean(),
      }).optional(),
    }),
  }),
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
  operator_resolved: z.strictObject({ action: z.enum(["worker_stopped", "lease_returned", "owner_read_reconciled"]), note: nonempty.optional() }),
  /** `finish --accept-output`: the operator accepted committed output instead of a worker result. */
  output_accepted: z.strictObject({ commit, acceptedBy: z.literal("operator").optional() }),
  /** `finish` under the local-merge policy fast-forwarded the target branch to the output branch. */
  integrated: z.strictObject({ policy: z.literal("local-merge"), targetBranch: nonempty, commit }),
  /** `discard`: the operator chose to discard the attempt's work. */
  discarded: z.strictObject({ note: nonempty.optional() }),
  /**
   * `finish` or `discard` is about to ask the workspace provider to return the lease, after the operator confirmed no
   * worker process remained. A later run that finds the lease gone records `lease_returned`.
   */
  lease_return_started: z.strictObject({ leaseId: nonempty, by: z.enum(["finish", "discard"]), returnId: z.uuid().optional(), noProcessesConfirmedBy: z.literal("operator").optional() }),
  /** `finish` or `discard` returned the lease, after the operator confirmed no worker process remained. */
  lease_returned: z.strictObject({ leaseId: nonempty, by: z.enum(["finish", "discard"]), returnId: z.uuid().optional(), noProcessesConfirmedBy: z.literal("operator").optional() }),
} as const;
export type EntryKind = keyof typeof entrySchemas;
type LegacyEntryData<K extends EntryKind> = z.infer<(typeof entrySchemas)[K]>;
export type EntryData<K extends EntryKind> = K extends "output_accepted" ? Omit<LegacyEntryData<K>, "acceptedBy">
  : K extends "lease_return_started" | "lease_returned" ? Omit<LegacyEntryData<K>, "noProcessesConfirmedBy" | "returnId"> & { returnId: string }
  : K extends "task_recorded" ? LegacyEntryData<K> & { category: OutcomeCategory }
  : LegacyEntryData<K>;

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

export function parseAttemptEntry(value: unknown): AttemptEntry {
  const entry = envelopeSchema.parse(value);
  const data = entrySchemas[entry.kind].parse(entry.data);
  if ("acceptedBy" in data || "noProcessesConfirmedBy" in data) throw new Error("Legacy confirmations require import");
  if (entry.kind === "task_recorded" && !("category" in data && data.category !== undefined)) throw new Error("Outcomes require a category");
  if ((entry.kind === "lease_return_started" || entry.kind === "lease_returned") && !("returnId" in data && data.returnId !== undefined)) throw new Error("Lease returns require a scoped confirmation ID");
  return { ...entry, data };
}

export type AttemptRef = { contextId: string; taskId: string; attempt: number };
export type AttemptRecord = AttemptRef & {
  entries: AttemptEntry[]; confirmations?: import("./store.ts").ConfirmationRecord[];
  specification?: import("./specification.ts").StoredSpecification;
  allocation?: import("./specification.ts").AttemptAllocation;
};

const entryName = /^(\d{4,})(?:-([a-z_]+))?\.json$/;
const readBatch = 32;

function sequenceOf(name: string): number {
  const match = entryName.exec(name);
  const sequence = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(sequence)) throw new Error("Uninspectable attempt entry sequence");
  return sequence;
}

/** Read-only legacy attempt files for import. Unreadable or inconsistent entries cause refusal. */
export class AttemptLog {
  readonly root: string;
  readonly contextId: string;
  constructor(root: string, contextId: string) {
    if (!isAbsolute(root)) throw new Error("Attempt log root must be absolute");
    this.root = root;
    this.contextId = nonempty.parse(contextId);
  }

  async read(ref: AttemptRef): Promise<AttemptRecord> {
    const directory = join(await this.taskDirectory(ref.taskId), String(ref.attempt));
    return { ...ref, entries: await this.entries(directory, ref) };
  }

  /** All attempts in this context, ordered by task directory then attempt number. */
  async list(): Promise<AttemptRecord[]> {
    const context = await this.contextDirectory();
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

  private async contextDirectory(): Promise<string | undefined> {
    let root: string;
    try { root = await realpath(this.root); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
    // Kept apart from runtime records, whose discovery refuses unexpected entries in a context directory.
    const context = join(root, "attempts", key(this.contextId));
    try { await safeDirectory(context); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
    return context;
  }

  private async taskDirectory(taskId: string): Promise<string> {
    const context = await this.contextDirectory();
    if (!context) throw Object.assign(new Error("No attempt log"), { code: "ENOENT" });
    const directory = join(context, key(taskId));
    await safeDirectory(directory);
    return directory;
  }
}

async function safeDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe attempt log directory");
}
