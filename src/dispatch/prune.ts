import { rm } from "node:fs/promises";
import { inspect, isOpen, type Dependencies } from "./dispatch.ts";
import { result, type DispatchResult } from "./result.ts";
import { status } from "./status.ts";

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
    const view = await status(deps);
    if (view.reason === "refused") return report(false, "refused", view.detail ?? "Owner state could not be read");
    const state = await inspect(deps);
    if ("failed" in state) return report(false, "refused", state.failed.detail ?? "Owner state could not be read");
    const cutoff = Date.now() - options.olderThan * 86400000;
    for (const record of state.attempts) {
      if (Date.parse(record.entries.at(-1)!.recordedAt) >= cutoff) continue;
      const attempt = view.attempts.find(a => a.attempt.taskId === record.taskId && a.attempt.attempt === record.attempt);
      const reason = !attempt ? "unknown" : isOpen(record) ? "unfinished" : attempt.state !== "finished" ? attempt.state
        : state.leases.some(l => l.holder === record.taskId || l.leaseId === attempt.attempt.leaseId) ? "lease_held"
        : state.runtime.some(r => r.binding.input.identity.taskId === record.taskId && r.child.status === "unknown") ? "possibly_running" : undefined;
      if (reason) { skipped.push({ taskId: record.taskId, attempt: record.attempt, reason }); continue; }
      if (!options.dryRun) {
        const runtime = state.runtime.find(r => r.binding.input.identity.leaseId === attempt!.attempt.leaseId);
        await deps.attempts.archiveAttempt(record, { ...attempt!.attempt, state: attempt!.state }, runtime ? [runtime.directory] : []);
        changed = true;
      }
      removed.push({ taskId: record.taskId, attempt: record.attempt, archive: deps.attempts.database.path });
    }
    if (!options.dryRun) for (const deletion of deps.attempts.pendingDeletions()) {
      await rm(deletion.directory, { recursive: true, force: true });
      await deps.attempts.completeDeletion(deletion);
    }
    return report(true, options.dryRun ? "planned" : "pruned", `${options.dryRun ? "Would remove" : "Removed"} ${removed.length} attempt(s). Preserved ${skipped.length} ineligible attempt(s)`);
  } catch (error) {
    return report(false, changed ? "stopped" : "refused", `${error instanceof Error ? error.message : String(error)}. Run prune again after checking the records`);
  }
}
