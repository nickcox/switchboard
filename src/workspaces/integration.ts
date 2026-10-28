import { CommandError, runCommand } from "../infra/command.ts";

export type Git = {
  git: string; environment: Record<string, string>; repository: string;
  read?: <T>(step: string, load: () => Promise<T>) => Promise<T>;
  beforeEffect?: () => void | Promise<void>;
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
  if (await branchHead(options, branch) !== expected) throw new Error(`${branch} moved after integration was planned; run finish --rebase again`);
  await options.beforeEffect?.();
  const result = checkedOut
    ? await git(options, ["merge", "--ff-only", "--quiet", commit], checkedOut)
    : await git(options, ["update-ref", `refs/heads/${branch}`, commit, expected]);
  if (result.exitCode !== 0) throw new Error(`Could not fast-forward ${branch}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  if (await branchHead(options, branch) !== commit) throw new Error(`${branch} does not point to ${commit} after the fast-forward`);
}

/** The checked-out branch, HEAD and tracked and untracked changes in the attempt's workspace. */
export async function workspaceState(options: Git, workspace: string): Promise<{ branch: string | undefined; head: string; clean: boolean }> {
  const command = (step: string, args: string[], missing = false) => read(options, step, async () => {
    const result = await git(options, args, workspace);
    if (result.timedOut || result.truncated || result.exitCode !== 0 && !(missing && result.exitCode === 1)) throw new CommandError(`The workspace ${workspace} cannot be read`, result);
    return result;
  });
  const head = await read(options, "read rebase workspace HEAD", async () => {
    const result = await git(options, ["rev-parse", "--verify", "HEAD^{commit}"], workspace);
    if (result.exitCode !== 0 || result.timedOut || result.truncated || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result.stdout.trim())) {
      throw new CommandError("The rebase workspace HEAD could not be read", result);
    }
    return result;
  });
  const status = await command("read rebase workspace changes", ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const branch = await command("read rebase workspace branch", ["symbolic-ref", "--quiet", "HEAD"], true);
  return { branch: branch.exitCode === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : undefined, head: head.stdout.trim(), clean: status.stdout === "" };
}

/** Commits reachable from `head` but not `base`, including any merge commits. */
export async function commitsBetween(options: Git, base: string, head: string): Promise<{ count: number; merges: number }> {
  const count = (extra: string[]) => read(options, "list commits to rebase", async () => {
    const result = await git(options, ["rev-list", "--count", ...extra, `${base}..${head}`]);
    if (result.exitCode !== 0 || result.timedOut || result.truncated || !/^\d+$/.test(result.stdout.trim())) throw new CommandError(`The commits between ${base} and ${head} cannot be listed`, result);
    return Number(result.stdout.trim());
  });
  return { count: await count([]), merges: await count(["--merges"]) };
}

/** Rebase detached, leaving every branch unchanged; abort on any stop, without resolving a conflict. */
export async function rebaseDetached(options: Git, workspace: string, change: { branch: string; upstream: string; onto: string; original: string }): Promise<{ rebased: string } | { stopped: string }> {
  await options.beforeEffect?.();
  const rebase = await git(options, [
    "-c", "rerere.enabled=false", "-c", "rebase.autoStash=false", "-c", "rebase.updateRefs=false", "-c", "rebase.autoSquash=false",
    "rebase", "--quiet", "--no-verify", "--no-fork-point", "--reapply-cherry-picks", "--keep-empty", "--empty=stop", "--onto", change.onto, change.upstream, change.original,
  ], workspace);
  if (rebase.exitCode === 0 && !rebase.timedOut && !rebase.truncated) {
    const after = await workspaceState(options, workspace);
    if (after.branch !== undefined || after.head === change.original || !after.clean) throw new Error("The rebase did not leave the workspace clean at a new detached commit");
    return { rebased: after.head };
  }
  const abort = await git(options, ["rebase", "--abort"], workspace);
  // A rebase given a commit starts detached, and abort returns to that point.
  const aborted = await workspaceState(options, workspace);
  if (aborted.branch === undefined && aborted.head === change.original && aborted.clean) await git(options, ["switch", "--quiet", change.branch], workspace);
  const after = await workspaceState(options, workspace);
  if (after.branch !== change.branch || after.head !== change.original || !after.clean) throw new Error(`The stopped rebase could not be undone (${abort.stderr.trim().slice(0, 300)}); inspect the workspace before trying again`);
  return { stopped: (rebase.stdout + rebase.stderr).trim().slice(0, 600) || "The rebase did not complete" };
}

/** Atomically move the output branch only from its recorded original, then attach the workspace to it. */
export async function moveDetachedBranch(options: Git, workspace: string, branch: string, expected: string, commit: string, dryRun = false): Promise<void> {
  const state = await workspaceState(options, workspace);
  const head = await branchHead(options, branch);
  if (state.branch === branch && state.head === commit && head === commit && state.clean) return;
  if (state.branch !== undefined || state.head !== commit || !state.clean) throw new Error(`The workspace is not clean and detached at ${commit}`);
  const checkedOut = await checkoutOf(options, branch);
  if (checkedOut) throw new Error(`${branch} is checked out in ${checkedOut}`);
  if (head !== expected && head !== commit) throw new Error(`${branch} no longer points to ${expected} or ${commit}`);
  if (dryRun) return;
  await options.beforeEffect?.();
  if (head !== commit) {
    const update = await git(options, ["update-ref", `refs/heads/${branch}`, commit, expected]);
    if (update.exitCode !== 0 || update.timedOut || update.truncated) throw new Error(`Could not move ${branch}: ${update.stderr.trim().slice(0, 300)}`);
  }
  const switched = await git(options, ["switch", "--quiet", branch], workspace);
  if (switched.exitCode !== 0 || switched.timedOut || switched.truncated) throw new Error(`Could not check out ${branch}: ${switched.stderr.trim().slice(0, 300)}`);
  const after = await workspaceState(options, workspace);
  if (after.branch !== branch || after.head !== commit || !after.clean) throw new Error(`The workspace is not clean on ${branch} at ${commit}`);
}
