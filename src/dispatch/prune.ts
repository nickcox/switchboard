import { lstat, rm } from "node:fs/promises";
import { isMissing } from "../runtime/records.ts";
import type { Dependencies } from "./dispatch.ts";
import { observeAttempt, observeAttempts } from "./observe.ts";
import { assessAttempt, assessAttempts } from "./assess.ts";
import { checkCanPrune } from "./safety.ts";
import { result, type DispatchResult } from "./result.ts";

/** Owner uncertainty preserves records regardless of age. Directory removal follows the archive transaction. */
export async function prune(deps: Dependencies, options: { olderThan: number; dryRun?: boolean }): Promise<DispatchResult> {
  const removed: { taskId: string; attempt: number; archive: string }[] = [];
  const skipped: { taskId: string; attempt: number; reason: string }[] = [];
  let changed = false;
  const report = (ok: boolean, reason: DispatchResult["reason"], detail: string) => result({
    ok, reason, stage: "prune", lease: "unknown", observed: { removed, skipped }, detail,
    nextAction: ok ? "none" : "inspect_attempt",
  });
  if (!Number.isFinite(options.olderThan) || options.olderThan <= 0) return report(false, "refused", "--older-than must be a positive number of days");
  try {
    const roots = await deps.workspaces.recyclableRoots();
    await deps.attempts.checkStorage(roots);
    await deps.runtime.checkStorage(roots);
    const context = await observeAttempts(deps);
    const errors = [context.records, context.runtime, context.leases, context.pool].flatMap(owner => owner.known ? [] : [owner.reason]);
    if (errors.length) return report(false, "refused", errors.join("; "));
    const cutoff = Date.now() - options.olderThan * 86400000;
    for (const attempt of assessAttempts(context)) {
      const { taskId, attempt: number } = attempt.attempt;
      const permission = checkCanPrune(attempt.facts, cutoff);
      if (!permission.allowed) {
        if (permission.reason !== "too_recent") skipped.push({ taskId, attempt: number, reason: permission.reason });
        continue;
      }
      if (!options.dryRun) {
        // External owners are checked again; archiveAttempt also checks the records in its transaction.
        const current = await observeAttempt(deps, { taskId, attempt: number });
        if (!current) { skipped.push({ taskId, attempt: number, reason: "unknown" }); continue; }
        const assessment = assessAttempt(current);
        const permission = checkCanPrune(assessment.facts, cutoff);
        if (!permission.allowed) { skipped.push({ taskId, attempt: number, reason: permission.reason }); continue; }
        const record = current.record.known ? current.record.value : undefined;
        if (!record) { skipped.push({ taskId, attempt: number, reason: "unknown" }); continue; }
        const runtime = current.runtime.known ? current.runtime.value : undefined;
        await deps.attempts.archiveAttempt(record, { ...assessment.attempt, state: assessment.state }, runtime ? [runtime.directory] : []);
        changed = true;
      }
      removed.push({ taskId, attempt: number, archive: deps.attempts.database.path });
    }
    if (!options.dryRun) for (const deletion of deps.attempts.pendingDeletions()) {
      await removeRuntimeDirectory(deps, deletion.directory);
      await deps.attempts.completeDeletion(deletion);
    }
    return report(true, options.dryRun ? "planned" : "pruned", `${options.dryRun ? "Would remove" : "Removed"} ${removed.length} attempt(s). Preserved ${skipped.length} ineligible attempt(s)`);
  } catch (error) {
    return report(false, changed ? "stopped" : "refused", `${error instanceof Error ? error.message : String(error)}. Run prune again after checking the records`);
  }
}

/**
 * Deletes a recorded runtime directory only if it is a real directory, not a link, inside the runtime root. A missing
 * directory is already gone. Anything else is refused and its deletion record kept, for the operator to inspect.
 */
async function removeRuntimeDirectory(deps: Dependencies, directory: string): Promise<void> {
  let found;
  try { found = await lstat(directory); }
  catch (error) { if (isMissing(error)) return; throw error; }
  if (!found.isDirectory() || found.isSymbolicLink() || !await deps.runtime.owns(directory)) {
    throw new Error(`Refusing to delete ${directory}: it is not a directory inside the runtime root`);
  }
  await rm(directory, { recursive: true, force: true });
}
