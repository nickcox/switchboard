import { lstat, rm } from "node:fs/promises";
import type { PendingDeletion } from "../attempts/store.ts";
import { OwnerReadError, readDiagnostics } from "./failure.ts";
import { OwnerReads, readRefusal } from "./owner-reads.ts";
import { isMissing } from "../runtime/records.ts";
import type { Dependencies } from "./dispatch.ts";
import { observeAttempt, observeAttempts } from "./observe.ts";
import { assessAttempt, assessAttempts } from "./assess.ts";
import { checkCanPrune } from "./safety.ts";
import { result, type DispatchResult } from "./result.ts";

/** Owner uncertainty preserves records regardless of age. Directory removal follows the archive transaction. */
export async function prune(deps: Dependencies, options: { olderThan: number; dryRun?: boolean }, files = { lstat, rm }): Promise<DispatchResult> {
  const removed: { taskId: string; attempt: number; archive: string }[] = [];
  const skipped: { taskId: string; attempt: number; reason: string }[] = [];
  let changed = false;
  const reads = new OwnerReads(deps, "prune");
  const report = (ok: boolean, reason: DispatchResult["reason"], detail: string) => result({
    ok, reason, stage: "prune", lease: "unknown", observed: { removed, skipped }, detail,
    nextAction: ok ? "none" : "inspect_attempt",
  });
  if (!Number.isFinite(options.olderThan) || options.olderThan <= 0) return report(false, "refused", "--older-than must be a positive number of days");
  try {
    const roots = await reads.read("Treehouse workspace roots", "check storage", () => deps.workspaces.recyclableRoots());
    await deps.attempts.checkStorage(roots);
    await deps.runtime.checkStorage(roots);
    const context = await observeAttempts(deps);
    if (context.records.known) reads.record = context.records.value[0];
    await reads.context(context, "inspect prune candidates");
    reads.record = undefined;
    const cutoff = Date.now() - options.olderThan * 86400000;
    for (const attempt of assessAttempts(context)) {
      const { taskId, attempt: number } = attempt.attempt;
      const permission = checkCanPrune(attempt.facts, cutoff);
      if (!permission.allowed) {
        if (permission.reason !== "too_recent") skipped.push({ taskId, attempt: number, reason: permission.reason });
        continue;
      }
      reads.record = { contextId: deps.contextId, taskId, attempt: number };
      await reads.checkEffects();
      if (!options.dryRun) {
        // External owners are checked again; archiveAttempt also checks the records in its transaction.
        const current = await observeAttempt(deps, { taskId, attempt: number });
        if (!current) { skipped.push({ taskId, attempt: number, reason: "unknown" }); continue; }
        await reads.attempt(current, "recheck before archive");
        await reads.checkEffects();
        const assessment = assessAttempt(current);
        const permission = checkCanPrune(assessment.facts, cutoff);
        if (!permission.allowed) { skipped.push({ taskId, attempt: number, reason: permission.reason }); continue; }
        const record = current.record.known ? current.record.value : undefined;
        if (!record) { skipped.push({ taskId, attempt: number, reason: "unknown" }); continue; }
        const runtime = current.runtime.known ? current.runtime.value : undefined;
        reads.effectAttempted = true;
        await deps.attempts.archiveAttempt(record, { ...assessment.attempt, state: assessment.state }, runtime ? [runtime.directory] : [], typeof assessment.task === "object" ? assessment.task : undefined);
        changed = true;
      }
      removed.push({ taskId, attempt: number, archive: deps.attempts.database.path });
    }
    if (!options.dryRun) for (const deletion of await reads.read("Attempt cleanup records", "list pending directory deletions", () => deps.attempts.pendingDeletions())) {
      reads.record = undefined;
      await removeRuntimeDirectory(deps, reads, deletion, files);
      await deps.attempts.completeDeletion(deletion);
    }
    return report(true, options.dryRun ? "planned" : "pruned", `${options.dryRun ? "Would remove" : "Removed"} ${removed.length} attempt(s). Preserved ${skipped.length} ineligible attempt(s)`);
  } catch (error) {
    const failed = readRefusal(error);
    if (failed) return { ...failed, observed: { ...failed.observed, removed, skipped } };
    return report(false, changed || reads.effectAttempted ? "stopped" : "refused", `${error instanceof Error ? error.message : String(error)}. Run prune again after checking the records`);
  }
}

/**
 * Deletes a recorded runtime directory only if it is a real directory, not a link, inside the runtime root. A missing
 * directory is already gone. Anything else is refused and its deletion record kept, for the operator to inspect.
 */
async function removeRuntimeDirectory(deps: Dependencies, reads: OwnerReads, deletion: PendingDeletion, files: { lstat: typeof lstat; rm: typeof rm }): Promise<void> {
  const { directory } = deletion;
  try {
    const entries = await reads.read("Attempt cleanup records", "read directory deletion evidence", () => deps.attempts.cleanupEntries(deletion));
    const started = entries.some(e => e.kind === "deletion_started");
    reads.effectAttempted ||= started || entries.some(e => e.kind === "owner_read_failed" && e.data.classification === "effect_uncertain");
    const confirm = async () => {
      if (!entries.some(e => e.kind === "deletion_confirmed")) await deps.attempts.appendCleanup(deletion, "deletion_confirmed", {
        directory, failureSequences: entries.filter(e => e.kind === "owner_read_failed" && e.data.classification === "effect_uncertain").map(e => e.sequence),
      });
    };
    const found = await reads.read("Runtime directory", "inspect directory before deletion", async () => {
      try { return await files.lstat(directory); }
      catch (error) { if (isMissing(error)) return undefined; throw error; }
    });
    if (!found) { await confirm(); return; }
    if (!found.isDirectory() || found.isSymbolicLink() || !await reads.read("Runtime directory", "check directory ownership", () => deps.runtime.owns(directory))) {
      throw new Error(`Refusing to delete ${directory}: it is not a directory inside the runtime root`);
    }
    if (started || entries.some(e => e.kind === "owner_read_failed" && e.data.classification === "effect_uncertain")) {
      throw new OwnerReadError({ owner: "Runtime directory", classification: "effect_uncertain", operation: "prune", step: "reconcile directory deletion",
        failedAt: new Date().toISOString(), diagnostics: { message: `Inspect and remove ${directory} manually; its earlier deletion may have happened` } });
    }
    await deps.attempts.appendCleanup(deletion, "deletion_started", { directory });
    reads.effectAttempted = true;
    if (!await reads.read("Runtime directory", "recheck directory ownership after deletion intent", () => deps.runtime.owns(directory))) {
      throw new Error(`Refusing to delete ${directory}: its ownership changed after the deletion intent`);
    }
    await files.rm(directory, { recursive: true, force: true });
    await reads.read("Runtime directory", "read back directory deletion", async () => {
      try { await files.lstat(directory); throw new Error(`Directory ${directory} still exists after deletion`); }
      catch (error) { if (!isMissing(error)) throw error; }
    });
    await confirm();
  } catch (error) {
    if (error instanceof OwnerReadError) {
      try { await deps.attempts.appendCleanup(deletion, "owner_read_failed", error.failure); }
      catch (recordingError) { error.failure.diagnostics.message += `. The cleanup failure record could not be written: ${readDiagnostics(recordingError).message}`; }
    }
    throw error;
  }
}
