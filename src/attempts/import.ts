import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { databasePath, type Config } from "../config.ts";
import { Database } from "../database.ts";
import { isOpen, summarise } from "../dispatch/dispatch.ts";
import { requireRetainedStorage } from "../infra/storage.ts";
import { key, readJsonFile } from "../runtime/records.ts";
import { requireSettled } from "../tasks/import.ts";
import { TaskStoreError } from "../tasks/store.ts";
import { AttemptLog, holdLabels, parseAttemptEntry, type AttemptRecord, type OutcomeCategory } from "./log.ts";
import { archiveSchema, reservationSchema } from "./prune.ts";
import { AttemptStore, type Confirmation, type ConfirmationRecord } from "./store.ts";

const names = async (path: string) => readdir(path).catch(error => { if (error.code === "ENOENT") return []; throw error; });

/** Compatibility belongs only here. The old files are never rewritten. */
function convert(record: AttemptRecord) {
  const confirmations: ConfirmationRecord[] = [];
  const summary = summarise(record);
  let returnId: string | undefined;
  const entries = record.entries.map(old => {
    const data = { ...old.data };
    const confirm = (confirmation: Confirmation, confirmedBy = "operator") => confirmations.push({
      contextId: record.contextId, taskId: record.taskId, attempt: record.attempt,
      ...confirmation, confirmedBy, confirmedAt: old.recordedAt,
    });
    if (old.kind === "task_recorded" && data.category === undefined) {
      data.category = data.outcome === "done" ? "done" : (Object.keys(holdLabels) as OutcomeCategory[])
        .find(category => category !== "done" && String(data.reason).endsWith(` ${holdLabels[category]}`));
      if (data.category === undefined) throw new Error("An old outcome has no recognisable category");
    }
    if (old.kind === "output_accepted") {
      confirm({ fact: "output_accepted", scope: { commit: String(data.commit) } }, String(data.acceptedBy ?? "operator"));
      delete data.acceptedBy;
    }
    if (old.kind === "discarded") confirm({ fact: "discard", scope: { leaseId: summary.leaseId! } });
    if (old.kind === "operator_resolved") {
      if (data.action === "worker_stopped") confirm({ fact: "worker_stopped", scope: {
        leaseId: summary.leaseId!, ...(summary.sessionId ? { sessionId: summary.sessionId } : {}),
      } });
      else confirm({ fact: "lease_returned", scope: {
        outputBranch: summary.outputBranch ?? `switchboard/${record.taskId}/attempt-${record.attempt}`,
        ...(summary.leaseId ? { leaseId: summary.leaseId } : {}),
      } });
    }
    if (old.kind === "lease_return_started" || old.kind === "lease_returned") {
      if (old.kind === "lease_return_started" || returnId === undefined) returnId = randomUUID();
      data.returnId = returnId;
      if (data.noProcessesConfirmedBy !== undefined && old.kind === "lease_return_started") {
        confirm({ fact: "no_processes", scope: { leaseId: String(data.leaseId), returnId } }, String(data.noProcessesConfirmedBy));
      }
      delete data.noProcessesConfirmedBy;
    }
    return parseAttemptEntry({ ...old, data });
  });
  return { record: { ...record, entries }, confirmations };
}

async function snapshot(config: Config, database: Database) {
  const root = config.runtimeRoot;
  const context = config.contextId;
  const legacy = new AttemptLog(root, context);
  const original = await legacy.list();
  const records = original.map(convert);
  const reservations = await Promise.all((await names(join(root, "request-ids", key(context)))).filter(name => !name.startsWith(".")).map(async name => {
    const value = reservationSchema.parse(await readJsonFile(join(root, "request-ids", key(context), name)));
    if (name !== `${key(value.requestId)}.json`) throw new Error("Reservation identity does not match its location");
    return value;
  }));
  const tasks = new Map(database.all("SELECT id FROM tasks").map(row => [key(String(row.id)), String(row.id)]));
  const numbers: { taskId: string; attempt: number }[] = [];
  for (const task of await names(join(root, "attempts", key(context)))) {
    const taskId = tasks.get(task);
    if (!taskId) throw new Error("Attempt files name a task absent from the database");
    for (const name of await names(join(root, "attempts", key(context), task))) {
      const match = /^(?:([1-9]\d*)|\.([1-9]\d*)\.pruned)$/.exec(name);
      if (match) numbers.push({ taskId, attempt: Number(match[1] ?? match[2]) });
    }
  }
  const archives = [];
  for (const task of await names(join(root, "archive", key(context)))) {
    for (const name of await names(join(root, "archive", key(context), task))) {
      if (name.startsWith(".")) continue;
      const value = archiveSchema.parse(await readJsonFile(join(root, "archive", key(context), task, name)));
      if (value.contextId !== context || key(value.taskId) !== task || name !== `${value.attempt}.json`) throw new Error("Archive identity does not match its location");
      archives.push(value);
      if (!numbers.some(n => n.taskId === value.taskId && n.attempt === value.attempt)) numbers.push({ taskId: value.taskId, attempt: value.attempt });
    }
  }
  return { original, records, reservations, numbers, archives };
}

/** Offline migration into a validated VACUUM copy of the database that already owns the tasks. */
export async function importAttempts(config: Config) {
  await requireSettled(config);
  const path = databasePath(config);
  await requireRetainedStorage(path, [config.workspaces.poolRoot]);
  await stat(path); // Do not create an empty task database by accident.
  const staging = `${path}.attempt-import-${randomUUID()}`;
  let source: Database | undefined;
  let copy: Database | undefined;
  try {
    source = await Database.open(path, config.databaseRetryMs);
    if (source.get("SELECT 1 FROM attempts LIMIT 1") || source.get("SELECT 1 FROM attempt_numbers LIMIT 1")) {
      throw new TaskStoreError("rejected", "The database already has attempts or reservations");
    }
    const before = await snapshot(config, source);
    await source.vacuumInto(staging);
    copy = await Database.open(staging, config.databaseRetryMs);
    const store = new AttemptStore(copy, config.contextId);
    await copy.transaction(() => {
      for (const number of before.numbers) copy!.run("INSERT INTO attempt_numbers VALUES(?,?,?)", config.contextId, number.taskId, number.attempt);
      for (const { record, confirmations } of before.records) {
        const requestId = record.entries[0]!.data.requestId as string | undefined;
        const reservation = before.reservations.find(r => r.requestId === requestId);
        if (reservation && reservation.taskId !== record.taskId) throw new Error("Reservation task differs from its attempt");
        copy!.run("INSERT INTO attempts(context,task,number,request_id,reserved_at,closed) VALUES(?,?,?,?,?,?)", config.contextId,
          record.taskId, record.attempt, requestId ?? null, reservation?.reservedAt ?? record.entries[0]!.recordedAt, isOpen(record) ? 0 : 1);
        for (const entry of record.entries) copy!.run("INSERT INTO attempt_entries VALUES(?,?,?,?,?)", config.contextId, record.taskId, record.attempt, entry.sequence, JSON.stringify(entry));
        for (const confirmation of confirmations) copy!.run("INSERT INTO confirmations(context,task,attempt,fact,confirmed_by,confirmed_at,scope) VALUES(?,?,?,?,?,?,?)",
          config.contextId, record.taskId, record.attempt, confirmation.fact, confirmation.confirmedBy, confirmation.confirmedAt, JSON.stringify(confirmation.scope));
      }
      for (const reservation of before.reservations) {
        if (before.records.some(r => r.record.entries[0]!.data.requestId === reservation.requestId)) continue;
        copy!.run("INSERT INTO attempts(context,task,request_id,reserved_at,closed) VALUES(?,?,?,?,1)", config.contextId, reservation.taskId, reservation.requestId, reservation.reservedAt);
      }
      for (const archive of before.archives) {
        // A crash before the old prune renamed the attempt can leave both records. Keep both until a later prune.
        copy!.run("INSERT INTO archived_attempts VALUES(?,?,?,?)", config.contextId, archive.taskId, archive.attempt, JSON.stringify(archive));
      }
    });
    for (const { record, confirmations } of before.records) {
      assert.deepEqual(store.read(record), record, "Imported entries differ");
      assert.deepEqual(store.confirmations(record), confirmations, "Imported confirmations differ");
    }
    assert.equal(store.list().length, before.records.length);
    assert.deepEqual(copy.all("SELECT task, number FROM attempt_numbers WHERE context = ? ORDER BY task, number", config.contextId).map(row => ({ taskId: String(row.task), attempt: Number(row.number) })),
      [...before.numbers].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : a.attempt - b.attempt)));
    for (const reservation of before.reservations) assert.partialDeepStrictEqual(copy.get("SELECT task, reserved_at FROM attempts WHERE context = ? AND request_id = ?", config.contextId, reservation.requestId), { task: reservation.taskId, reserved_at: reservation.reservedAt });
    for (const archive of before.archives) assert.deepEqual(JSON.parse(String(copy.get("SELECT summary FROM archived_attempts WHERE context = ? AND task = ? AND attempt = ?", config.contextId, archive.taskId, archive.attempt)!.summary)), archive);
    await requireSettled(config);
    // Compare the files again without generating new conversion IDs.
    const after = await snapshot(config, source);
    assert.deepEqual(after.reservations, before.reservations);
    assert.deepEqual(after.numbers, before.numbers);
    assert.deepEqual(after.archives, before.archives);
    assert.deepEqual(after.original, before.original, "Attempt files changed during import");
    copy.checkpoint();
    copy.close();
    source.checkpoint();
    source.close();
    // The command requires all writers stopped. There must be no live connection when replacing a WAL database.
    await rename(staging, path);
    return { ok: true, count: before.records.length, reservations: before.reservations.length, pruned: before.archives.length, path };
  } finally {
    copy?.close(); source?.close();
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${staging}${suffix}`, { force: true });
  }
}
