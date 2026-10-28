import { createHash } from "node:crypto";
import type { Database } from "../database.ts";

export type RequestInputs = { taskId?: string };

/** Only caller inputs belong here – selected tasks and resolved configuration are not explicit inputs. */
export function requestFingerprint(inputs: RequestInputs): string {
  return createHash("sha256").update(JSON.stringify({ taskId: inputs.taskId ?? null })).digest("hex");
}

/** Historical records did not retain the caller's selection mode. Keep that uncertainty, never invent a fingerprint. */
export function migrateRequestRecords(database: Database): void {
  const candidates = database.all("SELECT context, task, number, request_id, reserved_at FROM attempts WHERE request_id IS NOT NULL")
    .map(row => ({ context: String(row.context), task: String(row.task), attempt: row.number === null ? null : Number(row.number),
      requestId: String(row.request_id), reservedAt: String(row.reserved_at), archived: false }));
  for (const row of database.all("SELECT context, task, attempt, summary FROM archived_attempts")) {
    const archive = JSON.parse(String(row.summary));
    const ids = [archive.requestId, archive.reservation?.requestId, archive.summary?.requestId, archive.summary?.facts?.requested?.data?.requestId]
      .filter((value): value is string => typeof value === "string");
    if (new Set(ids).size > 1) throw new Error("Conflicting historical request IDs in an archived attempt");
    if (ids.length > 0) candidates.push({ context: String(row.context), task: String(row.task), attempt: Number(row.attempt), requestId: ids[0]!,
      reservedAt: archive.reservation?.reservedAt ?? archive.finishedAt, archived: true });
  }
  for (const candidate of candidates) {
    const previous = database.get("SELECT task, attempt, archived FROM request_records WHERE context = ? AND request_id = ?", candidate.context, candidate.requestId);
    if (previous) {
      if (previous.task !== candidate.task || (previous.attempt !== null && candidate.attempt !== null && previous.attempt !== candidate.attempt)) {
        throw new Error(`Conflicting historical mappings for request ID ${candidate.requestId}`);
      }
      if (candidate.attempt !== null) database.run("UPDATE request_records SET attempt = ?, archived = max(archived, ?) WHERE context = ? AND request_id = ?",
        candidate.attempt, candidate.archived ? 1 : 0, candidate.context, candidate.requestId);
    } else database.run("INSERT INTO request_records VALUES(?,?,?,?,?,?,?,?)", candidate.context, candidate.requestId, candidate.task, candidate.attempt,
      candidate.reservedAt, 0, null, candidate.archived ? 1 : 0);
  }
}
