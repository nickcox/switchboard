import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CommandError, describeCommand, runCommand } from "../infra/command.ts";
import { inside, requireRetainedStorage } from "../infra/storage.ts";

export type RetentionRequest = {
  /** The repository whose refs the workspace shares. Refs are read here, not through the workspace. */
  repository: string;
  workspace: string;
  outputBranch: string;
  /** The exact result commit for code deliverables; omitted when the deliverable is not code. */
  resultCommit?: string;
  /** Every reported Git deliverable, checked by its own branch and exact commit. */
  gitReferences?: { name: string; branch: string; commit: string }[];
  /** Absolute paths of required reports and evidence, which must exist outside the workspace. */
  artefacts: string[];
  /** Provider areas containing all recyclable workspaces, not just the current lease. */
  recyclableRoots?: string[];
  /** Assigned retained artefact directory. Dispatch always supplies this for a worker report. */
  artefactDirectory?: string;
  /**
   * True when the deliverable is not code, so the workspace is scratch: its uncommitted files and commits on no
   * branch are reported as notes instead of preventing retention.
   */
  scratchWorkspace?: boolean;
};

export type RetentionResult = {
  /** True only when every check passed. A check that could not run counts as not retained. */
  retained: boolean;
  /** Failed read commands, distinct from definite findings such as a dirty workspace. */
  readFailures?: { message: string; detail: string }[];
  /** A successful read also proved missing output or unretained workspace contents. */
  definiteRejection?: boolean;
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
  const readFailures: { message: string; detail: string }[] = [];
  const notes: string[] = [];
  let definiteRejection = false;
  const reject = (text: string) => { definiteRejection = true; findings.push(text); };
  const workspaceFinding = (text: string) => (request.scratchWorkspace ? notes.push(`Scratch workspace: ${text}`) : reject(text));
  // A command that cannot even start (for example a missing workspace) is a check that could not run.
  const run = (cwd: string, args: string[]) => runCommand(git, args, { cwd, env: environment, timeoutMs: gitTimeoutMs })
    .catch((error: unknown) => error instanceof CommandError ? JSON.parse(error.detail) as Awaited<ReturnType<typeof runCommand>>
      : { command: { executable: git, args }, exitCode: null, stdout: "", stderr: String(error), timedOut: false, truncated: false });
  const unable = (what: string, result?: Awaited<ReturnType<typeof run>>) => {
    const message = `Could not check ${what}`;
    findings.push(`${message}${result ? `: ${describeCommand(result)}` : ""}`);
    if (result) readFailures.push({ message, detail: describeCommand(result) });
  };

  const references = request.gitReferences ?? (request.resultCommit === undefined ? [] : [
    { name: "output", branch: request.outputBranch, commit: request.resultCommit },
  ]);
  for (const reference of references) {
    const ref = `refs/heads/${reference.branch}`;
    const exists = await run(request.repository, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (exists.timedOut || exists.truncated) unable("the output branch", exists);
    else if (exists.exitCode === 1) reject(`Output branch ${reference.branch} does not exist (${reference.name})`);
    else if (exists.exitCode !== 0) unable("the output branch", exists);
    else {
      const contained = await run(request.repository, ["merge-base", "--is-ancestor", reference.commit, ref]);
      if (contained.timedOut || contained.truncated) unable("whether the output branch contains the result commit", contained);
      else if (contained.exitCode === 1) reject(`Output branch ${reference.branch} does not contain result commit ${reference.commit} (${reference.name})`);
      else if (contained.exitCode !== 0) unable("whether the output branch contains the result commit", contained);
    }
  }

  // Commits reachable from the workspace's HEAD but from no local branch become unreachable when it is recycled.
  const orphaned = await run(request.workspace, ["rev-list", "HEAD", "--not", "--branches"]);
  if (orphaned.exitCode !== 0 || orphaned.timedOut || orphaned.truncated) unable("for commits on no branch", orphaned);
  else {
    const commits = orphaned.stdout.split("\n").filter(Boolean);
    if (commits.length > 0) workspaceFinding(`${commits.length} commit(s) in the workspace are on no branch: ${commits.slice(0, listLimit).join(", ")}`);
  }

  const status = await run(request.workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]);
  if (status.exitCode !== 0 || status.timedOut || status.truncated) unable("the workspace's files", status);
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
    if (changed.length > 0) workspaceFinding(`${changed.length} uncommitted or untracked path(s) in the workspace: ${changed.slice(0, listLimit).join(", ")}`);
    if (ignored.length > 0) notes.push(`${ignored.length} ignored path(s) in the workspace: ${ignored.slice(0, listLimit).join(", ")}`);
  }

  let workspace: string | undefined;
  try { workspace = await realpath(request.workspace); } catch { unable("the workspace path"); }
  for (const artefact of request.artefacts) {
    if (!isAbsolute(artefact)) { findings.push(`Artefact path is not absolute: ${artefact}`); continue; }
    let directory: string | undefined;
    if (request.artefactDirectory !== undefined) {
      try { directory = await realpath(request.artefactDirectory); }
      catch { unable("the assigned artefact directory"); continue; }
    }
    const checkPath = async (path: string, ancestors: Set<string>): Promise<number> => {
      let resolved: string;
      let target: Awaited<ReturnType<typeof stat>>;
      try { resolved = await realpath(path); target = await stat(resolved); }
      catch { findings.push(`Required artefact is missing or cannot be resolved: ${path}`); return 0; }
      if (workspace && inside(workspace, resolved)) findings.push(`Required artefact is inside the workspace: ${path}`);
      try { await requireRetainedStorage(path, request.recyclableRoots ?? []); }
      catch { findings.push(`Required artefact is inside a recyclable workspace or its location could not be checked: ${path}`); }
      if (target.isDirectory() && (!directory || !inside(directory, resolved))) {
        findings.push(`Required artefact is a directory outside the assigned artefact directory: ${path}`);
        return 0;
      }
      if (directory && !inside(directory, resolved)) {
        findings.push(`Required artefact is outside the assigned artefact directory: ${path}`);
        return 0;
      }
      if (target.isDirectory()) {
        if (ancestors.has(resolved)) {
          findings.push(`Required artefact contains a directory link cycle: ${path}`);
          return 0;
        }
        let entries: string[];
        try { entries = await readdir(resolved); }
        catch { findings.push(`Required artefact is an unreadable directory: ${path}`); return 0; }
        const parents = new Set([...ancestors, resolved]);
        let files = 0;
        for (const entry of entries) files += await checkPath(join(path, entry), parents);
        if (path === artefact && entries.length === 0) findings.push(`Required artefact is an empty directory: ${path}`);
        else if (path === artefact && files === 0) findings.push(`Required artefact is a directory with no readable regular files: ${path}`);
        return files;
      }
      if (!target.isFile()) {
        findings.push(`Required artefact is not a regular file or directory: ${path}`);
        return 0;
      }
      try {
        const file = await open(resolved, "r");
        try {
          if (!(await file.stat()).isFile()) throw new Error("Not a regular file");
          await file.read(Buffer.alloc(1), 0, 1, 0);
        } finally { await file.close(); }
        return 1;
      } catch { findings.push(`Required artefact is unreadable: ${path}`); return 0; }
    };
    await checkPath(artefact, new Set());
  }

  return { retained: findings.length === 0, findings, notes, ...(readFailures.length ? { readFailures, ...(definiteRejection ? { definiteRejection } : {}) } : {}) };
}
