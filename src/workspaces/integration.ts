import { runCommand } from "../infra/command.ts";

type Git = { git: string; environment: Record<string, string>; repository: string };

async function git(options: Git, args: string[], cwd = options.repository) {
  return runCommand(options.git, args, { cwd, env: options.environment, timeoutMs: 30000 });
}

/**
 * The worktree that has `branch` checked out, if any. Without a complete inventory it is unknown whether the branch is
 * checked out, so a failed, timed-out, truncated or malformed listing is an error, never "not checked out". The listing
 * is NUL-separated, so worktree paths may contain newlines.
 */
async function checkoutOf(options: Git, branch: string): Promise<string | undefined> {
  const listed = await git(options, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.exitCode !== 0 || listed.timedOut || listed.truncated) throw new Error(`The repository's worktrees could not be listed: ${(listed.stderr || listed.stdout).trim().slice(0, 300)}`);
  // Each record is a run of NUL-terminated lines, ended by an empty line.
  const records = listed.stdout.split("\0\0").filter(record => record !== "").map(record => record.split("\0").filter(line => line !== ""));
  if (records.length === 0 || records.some(lines => !lines[0]?.startsWith("worktree "))) throw new Error("The repository's worktree list is not in the expected format");
  return records.find(lines => lines.includes(`branch refs/heads/${branch}`))?.[0]!.slice("worktree ".length);
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
  const checkedOut = await checkoutOf(options, branch);
  const result = checkedOut
    ? await git(options, ["merge", "--ff-only", "--quiet", commit], checkedOut)
    : await git(options, ["update-ref", `refs/heads/${branch}`, commit, expected]);
  if (result.exitCode !== 0) throw new Error(`Could not fast-forward ${branch}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  if (await branchHead(options, branch) !== commit) throw new Error(`${branch} does not point to ${commit} after the fast-forward`);
}
