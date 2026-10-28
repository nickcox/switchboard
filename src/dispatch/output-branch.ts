import type { AttemptRecord } from "../attempts/log.ts";
import { onPath } from "../infra/executables.ts";
import { removeOutputBranch, type OutputBranchCleanup } from "../workspaces/output-branch.ts";
import type { Dependencies } from "./dependencies.ts";

export function outputTarget(record: AttemptRecord): string | undefined {
  return [...record.entries].reverse().find(e => e.kind === "integrated")?.data.targetBranch as string | undefined
    ?? record.allocation?.baseRef ?? record.specification?.baseRef;
}

/** Cleanup is best effort and can never reverse a confirmed lease return. */
export async function cleanupOutputBranch(deps: Dependencies, record: AttemptRecord, dryRun = false): Promise<OutputBranchCleanup | undefined> {
  const branch = record.allocation?.outputBranch ?? record.specification?.outputBranch;
  if (!branch) return;
  let cleanup: OutputBranchCleanup;
  try {
    record = deps.attempts.read(record);
    cleanup = await removeOutputBranch(deps.policy?.git ?? onPath("git"), deps.policy?.environment ?? {}, {
      repository: record.allocation?.backingRepository ?? deps.repository, branch,
      commit: deps.attempts.startingPointCommit(record), targetBranch: outputTarget(record),
      discarded: record.entries.some(e => e.kind === "discarded"), dryRun,
    });
  } catch (error) {
    cleanup = { branch, status: "kept", detail: `Could not check output branch: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!dryRun) {
    try { await deps.attempts.append(record, "output_branch_cleanup", cleanup); }
    catch (error) { cleanup.detail = `${cleanup.detail ? `${cleanup.detail}. ` : ""}Could not record branch cleanup: ${error instanceof Error ? error.message : String(error)}`; }
  }
  return cleanup;
}

export function describeOutputBranch(cleanup: OutputBranchCleanup | undefined): string {
  return cleanup ? `Output branch ${cleanup.branch}: ${cleanup.status}${cleanup.detail ? ` – ${cleanup.detail}` : ""}` : "";
}
