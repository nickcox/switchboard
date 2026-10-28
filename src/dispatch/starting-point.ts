import type { AttemptRecord } from "../attempts/log.ts";
import { onPath } from "../infra/executables.ts";
import { removeStartingPoint, startingPointBranch, type StartingPointCleanup } from "../workspaces/starting-point.ts";
import { isOpen } from "./attempt.ts";
import { requireOperationAuthority } from "./safety.ts";
import type { Dependencies } from "./dependencies.ts";

/** An allocation no longer needs its base ref. Without one, wait until the attempt is closed. */
export async function cleanupStartingPoint(deps: Dependencies, record: AttemptRecord, dryRun = false): Promise<StartingPointCleanup | undefined> {
  const specification = record.specification;
  const point = specification?.startingPoint ?? specification?.reviewTarget;
  if (!point || !specification?.outputBranch || !specification.backingRepository || !record.allocation && isOpen(record)) return;
  const { outputBranch, backingRepository: repository } = specification;
  try {
    requireOperationAuthority(deps, ["recordAttempt"], record);
    return await removeStartingPoint(deps.policy?.git ?? onPath("git"), deps.policy?.environment ?? {}, {
      repository, outputBranch, commit: point.commit, dryRun,
    });
  } catch (error) {
    // Executable lookup can fail too. Cleanup must never change the attempt's outcome.
    return { branch: startingPointBranch(outputBranch), status: "preserved", detail: `Could not remove starting-point branch: ${error instanceof Error ? error.message : String(error)}` };
  }
}
