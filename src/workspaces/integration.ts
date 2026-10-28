import { CommandError, runCommand } from "../infra/command.ts";

type Git = {
  git: string; environment: Record<string, string>; repository: string;
  read?: <T>(step: string, load: () => Promise<T>) => Promise<T>;
  beforeEffect?: () => void;
};
const read = <T>(options: Git, step: string, load: () => Promise<T>): Promise<T> => options.read ? options.read(step, load) : load();

async function git(options: Git, args: string[], cwd = options.repository) {
  return runCommand(options.git, args, { cwd, env: options.environment, timeoutMs: 30000 });
}

/**
 * The worktree that has `branch` checked out, if any. Without a complete inventory it is unknown whether the branch is
 * checked out, so a failed, timed-out, truncated or malformed listing is an error, never "not checked out". The listing
 * is NUL-separated, so worktree paths may contain newlines.
 */
async function checkoutOf(options: Git, branch: string): Promise<string | undefined> {
  return read(options, "list target worktrees", async () => {
  const listed = await git(options, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.exitCode !== 0 || listed.timedOut || listed.truncated) throw new CommandError("The repository's worktrees could not be listed", listed);
  // Each record is a run of NUL-terminated lines, ended by an empty line.
  const records = listed.stdout.split("\0\0").filter(record => record !== "").map(record => record.split("\0").filter(line => line !== ""));
  if (records.length === 0 || records.some(lines => !lines[0]?.startsWith("worktree "))) throw new CommandError("The repository's worktree list is not in the expected format", listed);
  return records.find(lines => lines.includes(`branch refs/heads/${branch}`))?.[0]!.slice("worktree ".length);
  });
}

/** The commit a branch points to in the backing repository, or undefined if it does not exist. */
export async function branchHead(options: Git, branch: string): Promise<string | undefined> {
  return read(options, `read branch ${branch}`, async () => {
    const result = await git(options, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
    if (result.timedOut || result.truncated || result.exitCode !== 0 && result.exitCode !== 1) throw new CommandError(`Branch ${branch} could not be read`, result);
    if (result.exitCode === 1) return undefined;
    const commit = result.stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new CommandError(`Branch ${branch} returned an invalid commit`, result);
    return commit;
  });
}

/** Whether `ancestor` is an ancestor of, or the same commit as, `descendant`. */
export async function isAncestor(options: Git, ancestor: string, descendant: string): Promise<boolean> {
  return read(options, "compare commits", async () => {
    const result = await git(options, ["merge-base", "--is-ancestor", ancestor, descendant]);
    if (!result.timedOut && !result.truncated) {
      if (result.exitCode === 0) return true;
      if (result.exitCode === 1) return false;
    }
    throw new CommandError(`Could not compare ${ancestor} with ${descendant}`, result);
  });
}

/**
 * Fast-forwards `branch` from `expected` to `commit` in the backing repository. A branch checked out in a working tree
 * is advanced there with `git merge --ff-only`, so the working tree follows; otherwise the ref is updated only if it
 * still points to `expected`. Never creates a merge commit.
 */
export async function fastForward(options: Git, branch: string, expected: string, commit: string): Promise<void> {
  const checkedOut = await checkoutOf(options, branch);
  options.beforeEffect?.();
  const result = checkedOut
    ? await git(options, ["merge", "--ff-only", "--quiet", commit], checkedOut)
    : await git(options, ["update-ref", `refs/heads/${branch}`, commit, expected]);
  if (result.exitCode !== 0) throw new Error(`Could not fast-forward ${branch}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  if (await branchHead(options, branch) !== commit) throw new Error(`${branch} does not point to ${commit} after the fast-forward`);
}
