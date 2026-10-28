import { removeOutputBranch, type OutputBranchCleanup } from "../workspaces/output-branch.ts";
import { onPath } from "../infra/executables.ts";
import type { Dependencies } from "./dependencies.ts";
import { observeAttempts } from "./observe.ts";
import { assessAttempts } from "./assess.ts";
import { cleanupOutputBranch, describeOutputBranch } from "./output-branch.ts";
import { requireOperationAuthority } from "./safety.ts";
import { result, type DispatchResult } from "./result.ts";

/** One-time cleanup for leases returned before output-branch cleanup was introduced. */
export async function cleanupOutputBranches(deps: Dependencies, options: { dryRun?: boolean }): Promise<DispatchResult> {
  const branches: (OutputBranchCleanup & { taskId: string; attempt: number })[] = [];
  try {
    requireOperationAuthority(deps, ["returnLease"]);
    const context = await observeAttempts(deps);
    if (!context.records.known) throw new Error(context.records.reason);
    for (const assessment of assessAttempts(context)) {
      const record = context.records.value.find(r => r.taskId === assessment.attempt.taskId && r.attempt === assessment.attempt.attempt)!;
      requireOperationAuthority(deps, ["returnLease"], record);
      const branch = record.allocation?.outputBranch ?? record.specification?.outputBranch;
      if (!branch) continue;
      const why = assessment.facts.unknown.join("; ") || (assessment.possiblyRunning ? "Worker may still be running" :
        assessment.leaseInOtherPool ? "Lease is in an unknown pool" : assessment.leaseHeld ? "Lease is still held" :
        !assessment.facts.leaseReturnedConfirmed && !record.entries.some(e => e.kind === "lease_returned") ? "Lease return has not been confirmed" : undefined);
      const cleanup = why ? { branch, status: "kept" as const, detail: why } : await cleanupOutputBranch(deps, record, options.dryRun);
      if (cleanup) branches.push({ taskId: record.taskId, attempt: record.attempt, ...cleanup });
    }
    for (const archived of deps.attempts.archivedOutputBranches()) {
      requireOperationAuthority(deps, ["returnLease"], archived);
      const unknown = [context.runtime, context.leases, context.pool].flatMap(owner => owner.known ? [] : [owner.reason]).join("; ");
      let cleanup: OutputBranchCleanup;
      try {
        cleanup = unknown || !archived.repository ? { branch: archived.branch, status: "kept", detail: unknown || "No recorded backing repository" }
          : await removeOutputBranch(deps.policy?.git ?? onPath("git"), deps.policy?.environment ?? {}, { ...archived, dryRun: options.dryRun === true });
      } catch (error) {
        cleanup = { branch: archived.branch, status: "kept", detail: `Could not check output branch: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (!options.dryRun) {
        try { await deps.attempts.appendArchivedOutputBranchCleanup(archived, cleanup); }
        catch (error) { cleanup.detail = `${cleanup.detail ?? ""} Could not record branch cleanup: ${error instanceof Error ? error.message : String(error)}`.trim(); }
      }
      branches.push({ taskId: archived.taskId, attempt: archived.attempt, ...cleanup });
    }
    return result({ ok: true, reason: options.dryRun ? "planned" : "output_branches_cleaned", stage: "finish", lease: "none", observed: { branches },
      detail: branches.map(b => `${b.taskId} attempt ${b.attempt}: ${describeOutputBranch(b)}`).join("\n") || "No output branches to clean up", nextAction: "none" });
  } catch (error) {
    return result({ ok: false, reason: "refused", stage: "finish", lease: "unknown", observed: { branches },
      detail: error instanceof Error ? error.message : String(error), nextAction: "inspect_attempt" });
  }
}
