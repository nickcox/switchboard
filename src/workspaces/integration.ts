import { runCommand } from "../infra/command.ts";

type Git = { git: string; environment: Record<string, string>; repository: string };

async function git(options: Git, args: string[], cwd = options.repository) {
  return runCommand(options.git, args, { cwd, env: options.environment, timeoutMs: 30000 });
}

/** The commit a branch points to in the backing repository, or undefined if it does not exist. */
export async function branchHead(options: Git, branch: string): Promise<string | undefined> {
  const result = await git(options, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

/** Whether `ancestor` is an ancestor of, or the same commit as, `descendant`. */
export async function isAncestor(options: Git, ancestor: string, descendant: string): Promise<boolean> {
  const result = await git(options, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error(`Could not compare ${ancestor} with ${descendant}`);
}

/**
 * Fast-forwards `branch` from `expected` to `commit` in the backing repository. A branch checked out in a working tree
 * is advanced there with `git merge --ff-only`, so the working tree follows; otherwise the ref is updated only if it
 * still points to `expected`. Never creates a merge commit.
 */
export async function fastForward(options: Git, branch: string, expected: string, commit: string): Promise<void> {
  const worktrees = (await git(options, ["worktree", "list", "--porcelain"])).stdout.split("\n\n");
  const checkedOut = worktrees.find(block => block.split("\n").includes(`branch refs/heads/${branch}`))?.split("\n").find(line => line.startsWith("worktree "))?.slice("worktree ".length);
  const result = checkedOut
    ? await git(options, ["merge", "--ff-only", "--quiet", commit], checkedOut)
    : await git(options, ["update-ref", `refs/heads/${branch}`, commit, expected]);
  if (result.exitCode !== 0) throw new Error(`Could not fast-forward ${branch}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  if (await branchHead(options, branch) !== commit) throw new Error(`${branch} does not point to ${commit} after the fast-forward`);
}
