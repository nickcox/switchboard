import { describeCommand, runCommand } from "../infra/command.ts";

export type OutputBranchCleanup = {
  branch: string;
  status: "deleted" | "kept" | "planned";
  detail?: string;
};

/** Returning a lease permits cleanup, but only the recorded ref value may be deleted. */
export async function removeOutputBranch(git: string, environment: Record<string, string>, request: {
  repository: string; branch: string; commit?: string | undefined; targetBranch?: string | undefined; discarded: boolean; dryRun?: boolean;
}): Promise<OutputBranchCleanup> {
  const { branch, commit } = request;
  const kept = (detail: string): OutputBranchCleanup => ({ branch, status: "kept", detail });
  const ref = `refs/heads/${branch}`;
  const run = (args: string[]) => runCommand(git, args, { cwd: request.repository, env: environment, timeoutMs: 15000 });
  const checked = async (args: string[]) => {
    const result = await run(args);
    if (result.timedOut || result.truncated || result.exitCode !== 0) throw new Error(describeCommand(result));
    return result.stdout.trim();
  };
  try {
    const head = await run(["rev-parse", "--verify", "--quiet", ref]);
    if (!head.timedOut && !head.truncated && head.exitCode === 1) return { branch, status: "deleted", detail: "Output branch is already absent" };
    if (head.timedOut || head.truncated || head.exitCode !== 0) throw new Error(describeCommand(head));
    if (!commit) return kept("No recorded output commit; left in place");
    if (head.stdout.trim() !== commit) return kept(`Output branch no longer points at recorded commit ${commit}; left in place`);
    const symbolic = await run(["symbolic-ref", "--quiet", ref]);
    if (symbolic.timedOut || symbolic.truncated || symbolic.exitCode !== 1) return kept("Output ref is symbolic or could not be checked; left in place");
    if (!request.discarded) {
      if (!request.targetBranch) return kept("No recorded target branch; left in place");
      if (branch === request.targetBranch) return kept("Output branch is the target branch; left in place");
      const target = await checked(["rev-parse", "--verify", "--quiet", `refs/heads/${request.targetBranch}^{commit}`]);
      const contained = await run(["merge-base", "--is-ancestor", commit, target]);
      if (!contained.timedOut && !contained.truncated && contained.exitCode === 1) return kept(`Recorded output commit is not in target branch ${request.targetBranch}; left in place`);
      if (contained.timedOut || contained.truncated || contained.exitCode !== 0) throw new Error(describeCommand(contained));
    } else if (branch === request.targetBranch) return kept("Output branch is the target branch; left in place");
    if (request.dryRun) return { branch, status: "planned" };
    await checked(["update-ref", "--no-deref", "-d", ref, commit]);
    return { branch, status: "deleted" };
  } catch (error) {
    return kept(`Could not delete output branch; left for inspection: ${error instanceof Error ? error.message : String(error)}`);
  }
}
