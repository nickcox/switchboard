import { createHash } from "node:crypto";
import { describeCommand, runCommand } from "../infra/command.ts";

export function startingPointBranch(outputBranch: string): string {
  return `switchboard-starting-points/${createHash("sha256").update(outputBranch).digest("hex")}`;
}

export type StartingPointCleanup = {
  branch: string;
  status: "absent" | "removed" | "planned" | "preserved";
  detail?: string;
};

/** Delete only the ref prepared for this attempt, with Git checking its old value atomically. */
export async function removeStartingPoint(git: string, environment: Record<string, string>, request: {
  repository: string; outputBranch: string; commit: string; dryRun?: boolean;
}): Promise<StartingPointCleanup> {
  const branch = startingPointBranch(request.outputBranch);
  const ref = `refs/heads/${branch}`;
  const run = (args: string[]) => runCommand(git, args, { cwd: request.repository, env: environment, timeoutMs: 15000 });
  try {
    const head = await run(["rev-parse", "--verify", "--quiet", ref]);
    if (!head.timedOut && !head.truncated && head.exitCode === 1) return { branch, status: "absent" };
    if (head.timedOut || head.truncated || head.exitCode !== 0) throw new Error(describeCommand(head));
    if (head.stdout.trim() !== request.commit) return { branch, status: "preserved", detail: `Starting-point branch ${branch} no longer points at ${request.commit}; left in place` };
    const symbolic = await run(["symbolic-ref", "--quiet", ref]);
    if (symbolic.timedOut || symbolic.truncated || symbolic.exitCode !== 1) throw new Error(`Starting-point ref is symbolic or could not be checked: ${describeCommand(symbolic)}`);
    if (request.dryRun) return { branch, status: "planned" };
    const removed = await run(["update-ref", "--no-deref", "-d", ref, request.commit]);
    if (removed.timedOut || removed.truncated || removed.exitCode !== 0) throw new Error(describeCommand(removed));
    return { branch, status: "removed" };
  } catch (error) {
    return { branch, status: "preserved", detail: `Could not remove starting-point branch ${branch}; left for inspection: ${error instanceof Error ? error.message : String(error)}` };
  }
}
