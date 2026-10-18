import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { describeCommand, runCommand } from "../infra/command.ts";
import { inside } from "../runtime/records.ts";

export type RetentionRequest = {
  /** The repository whose refs the workspace shares. Refs are read here, not through the workspace. */
  repository: string;
  workspace: string;
  outputBranch: string;
  /** The exact result commit for code deliverables; omitted when the deliverable is not code. */
  resultCommit?: string;
  /** Absolute paths of required reports and evidence, which must exist outside the workspace. */
  artefacts: string[];
};

export type RetentionResult = {
  /** True only when every check passed. A check that could not run counts as not retained. */
  retained: boolean;
  /** Reasons the work is not retained. Empty when `retained` is true. */
  findings: string[];
  /** Ignored files present in the workspace. Returning the workspace may remove some of them. */
  notes: string[];
};

const listLimit = 20;
const gitTimeoutMs = 15000;

/**
 * Reports whether returning the workspace would remove the only copy of the work (Phase 1 PRD, outcomes and lease
 * policy). Read-only: it never changes the workspace, refs or lease. Local refs protect against workspace recycling,
 * not loss of the backing repository.
 */
export async function checkRetention(git: string, environment: Record<string, string>, request: RetentionRequest): Promise<RetentionResult> {
  const findings: string[] = [];
  const notes: string[] = [];
  // A command that cannot even start (for example a missing workspace) is a check that could not run.
  const run = (cwd: string, args: string[]) => runCommand(git, args, { cwd, env: environment, timeoutMs: gitTimeoutMs })
    .catch((error: unknown) => ({ exitCode: null, stdout: "", stderr: String(error), timedOut: false }));
  const unable = (what: string, result?: Awaited<ReturnType<typeof run>>) =>
    findings.push(`Could not check ${what}${result ? `: ${describeCommand(result)}` : ""}`);

  if (request.resultCommit !== undefined) {
    const ref = `refs/heads/${request.outputBranch}`;
    const exists = await run(request.repository, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (exists.exitCode === 1) findings.push(`Output branch ${request.outputBranch} does not exist`);
    else if (exists.exitCode !== 0) unable("the output branch", exists);
    else {
      const contained = await run(request.repository, ["merge-base", "--is-ancestor", request.resultCommit, ref]);
      if (contained.exitCode === 1) findings.push(`Output branch ${request.outputBranch} does not contain result commit ${request.resultCommit}`);
      else if (contained.exitCode !== 0) unable("whether the output branch contains the result commit", contained);
    }
  }

  // Commits reachable from the workspace's HEAD but from no local branch become unreachable when it is recycled.
  const orphaned = await run(request.workspace, ["rev-list", "HEAD", "--not", "--branches"]);
  if (orphaned.exitCode !== 0) unable("for commits on no branch", orphaned);
  else {
    const commits = orphaned.stdout.split("\n").filter(Boolean);
    if (commits.length > 0) findings.push(`${commits.length} commit(s) in the workspace are on no branch: ${commits.slice(0, listLimit).join(", ")}`);
  }

  const status = await run(request.workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]);
  if (status.exitCode !== 0) unable("the workspace's files", status);
  else {
    const changed: string[] = [];
    const ignored: string[] = [];
    const entries = status.stdout.split("\0").filter(Boolean);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      // A rename or copy is followed by its original path as a separate entry.
      if (code.startsWith("R") || code.startsWith("C")) index += 1;
      (code === "!!" ? ignored : changed).push(code === "!!" ? path : `${code.trim()} ${path}`);
    }
    if (changed.length > 0) findings.push(`${changed.length} uncommitted or untracked path(s) in the workspace: ${changed.slice(0, listLimit).join(", ")}`);
    if (ignored.length > 0) notes.push(`${ignored.length} ignored path(s) in the workspace: ${ignored.slice(0, listLimit).join(", ")}`);
  }

  let workspace: string | undefined;
  try { workspace = await realpath(request.workspace); } catch { unable("the workspace path"); }
  for (const artefact of request.artefacts) {
    if (!isAbsolute(artefact)) { findings.push(`Artefact path is not absolute: ${artefact}`); continue; }
    try { await lstat(artefact); }
    catch { findings.push(`Required artefact is missing: ${artefact}`); continue; }
    const resolved = await realpath(artefact).catch(() => artefact);
    if (workspace && inside(workspace, resolved)) findings.push(`Required artefact is inside the workspace: ${artefact}`);
  }

  return { retained: findings.length === 0, findings, notes };
}
