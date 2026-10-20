import { AttemptPruner, type ArchivedAttempt } from "../attempts/prune.ts";
import { inspect, isOpen, leaseReturned, type Dependencies } from "./dispatch.ts";
import { result, type DispatchResult } from "./result.ts";
import { status } from "./status.ts";

/** Operator-only retention: owner uncertainty always preserves the records, regardless of their age. */
export async function prune(deps: Dependencies, options: { olderThan: number; dryRun?: boolean }): Promise<DispatchResult> {
  const removed: { taskId: string; attempt: number; archive: string }[] = [];
  const skipped: { taskId: string; attempt: number; reason: string }[] = [];
  let changed = false;
  const report = (ok: boolean, reason: DispatchResult["reason"], detail: string) => result({
    ok, reason, stage: "prune", lease: "unknown", observed: { removed, skipped }, detail,
    nextAction: ok ? "none" : "inspect_attempt",
  });
  if (!Number.isFinite(options.olderThan) || options.olderThan <= 0) return report(false, "refused", "--older-than must be a positive number of days");
  const cutoff = Date.now() - options.olderThan * 86400000;
  const pruner = new AttemptPruner(deps.attempts);
  // One run at a time: two runs completing the same cleanup could release a request ID claimed in between.
  let locked = false;
  try {
    if (!options.dryRun) {
      locked = await pruner.lock();
      if (!locked) return report(false, "refused", `Another prune is running, or one was interrupted. If no prune is running, remove ${pruner.lockPath()} and run prune again`);
    }
    const roots = await deps.workspaces.recyclableRoots();
    await deps.attempts.checkStorage(roots);
    await deps.runtime.checkStorage(roots);
    const view = await status(deps);
    if (view.reason === "refused") return report(false, "refused", view.detail ?? "Owner state could not be read");
    const state = await inspect(deps);
    if ("failed" in state) return report(false, "refused", state.failed.detail ?? "Owner state could not be read");
    const pending = await pruner.pending();
    // A lease known to be returned no longer depends on which pool is listed now.
    const allowed = async (value: Pick<ArchivedAttempt, "taskId" | "leaseId" | "pool">, returned: boolean): Promise<string | undefined> => {
      if (!returned && value.pool !== undefined && value.pool !== state.pool) return "lease_in_other_pool";
      if (state.leases.some(l => l.leaseId === value.leaseId || l.holder === value.taskId)) return "lease_held";
      if (state.runtime.some(r => (r.binding.input.identity.leaseId === value.leaseId || r.binding.input.identity.taskId === value.taskId)
        && r.child.status === "unknown")) return "possibly_running";
      try { if (!await deps.tasks.read(value.taskId)) return "unknown"; }
      catch { return "unknown"; }
      return undefined;
    };
    for (const record of state.attempts) {
      const last = record.entries.at(-1)!;
      if (Date.parse(last.recordedAt) >= cutoff) continue;
      const attempt = view.attempts.find(a => a.attempt.taskId === record.taskId && a.attempt.attempt === record.attempt);
      const pool = record.entries.find(e => e.kind === "leased")?.data.pool ?? record.entries[0]?.data.pool;
      const reason = !attempt ? "unknown" : isOpen(record) ? "unfinished"
        : attempt.state !== "finished" ? attempt.state
        : await allowed({ taskId: record.taskId, ...(attempt.attempt.leaseId ? { leaseId: attempt.attempt.leaseId } : {}), ...(typeof pool === "string" ? { pool } : {}) }, leaseReturned(record));
      if (reason) { skipped.push({ taskId: record.taskId, attempt: record.attempt, reason }); continue; }
      const item = { taskId: record.taskId, attempt: record.attempt, archive: pruner.archivePath(record) };
      const archived = await pruner.archive(record, options.dryRun);
      if (!options.dryRun) {
        changed = true;
        await pruner.remove(archived);
      }
      removed.push(item);
    }
    for (const value of pending) {
      const facts = value.summary.facts as Record<string, { data?: { action?: unknown } } | undefined> | undefined;
      const reason = await allowed(value, facts?.lease_returned !== undefined || facts?.operator_resolved?.data?.action === "lease_returned");
      if (reason) { skipped.push({ taskId: value.taskId, attempt: value.attempt, reason }); continue; }
      if (!options.dryRun) { changed = true; await pruner.remove(value); }
      removed.push({ taskId: value.taskId, attempt: value.attempt, archive: pruner.archivePath(value) });
    }
    const list = removed.map(a => `${a.taskId} attempt ${a.attempt} (archive: ${a.archive})`).join("; ");
    return report(true, options.dryRun ? "planned" : "pruned", `${options.dryRun ? "Would remove" : "Removed"} ${removed.length} attempt(s)${list ? `: ${list}` : ""}. Preserved ${skipped.length} ineligible attempt(s)`);
  } catch (error) {
    return report(false, changed ? "stopped" : "refused", `${error instanceof Error ? error.message : String(error)}. Run prune again after checking the records`);
  } finally {
    if (locked) await pruner.unlock();
  }
}
