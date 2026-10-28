import { requireOperationAuthority } from "./safety.ts";
import { performance } from "node:perf_hooks";
import type { AttemptRecord } from "../attempts/log.ts";
import { latestChecks, type CheckResult } from "../attempts/checks.ts";
import { CommandError, redactDiagnostics, runCommand } from "../infra/command.ts";
import { onPath } from "../infra/executables.ts";
import type { Dependencies } from "./dependencies.ts";
import { readDiagnostics } from "./failure.ts";
import type { OwnerReads } from "./owner-reads.ts";

/** Refuse before starting any command unless the workspace is the exact, clean input being accepted. */
export async function checkWorkspace(deps: Dependencies, reads: OwnerReads, workspace: string, commit: string): Promise<string | undefined> {
  return reads.read("Git", "check check-command input", async () => {
    const git = deps.policy?.git ?? onPath("git");
    const env = deps.policy?.environment ?? deps.checkEnvironment ?? {};
    const run = async (args: string[]) => {
      const result = await runCommand(git, args, { cwd: workspace, env, timeoutMs: 30_000 });
      if (result.exitCode !== 0 || result.timedOut || result.truncated) throw new CommandError("Cannot read the check-command input", result);
      return result.stdout;
    };
    if ((await run(["rev-parse", "--verify", "HEAD"])).trim() !== commit) return `Workspace HEAD is not the exact output commit ${commit}; no further checks or acceptance can run`;
    if (await run(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) return "The workspace has uncommitted or untracked files; no further checks or acceptance can run";
    return undefined;
  });
}

/** Check failures are advisory facts, not uncertain acceptance or integration effects. */
export async function runChecks(deps: Dependencies, reads: OwnerReads, record: AttemptRecord, workspace: string, commit: string): Promise<{ checks: CheckResult[]; refusal?: string }> {
  requireOperationAuthority(deps, ["acceptOutput"], record);
  let current = await deps.attempts.read(record);
  let checks = latestChecks(current, commit);
  const refusal = await checkWorkspace(deps, reads, workspace, commit);
  if (refusal) return { checks, refusal };
  for (const check of deps.checks ?? []) {
    if (checks.some(result => result.name === check.name && result.status === "passed")) continue;
    const refusal = await checkWorkspace(deps, reads, workspace, commit);
    if (refusal) return { checks, refusal };
    requireOperationAuthority(deps, ["acceptOutput"], record);
    const start = performance.now();
    let fact: CheckResult;
    try {
      const result = await runCommand(check.command[0], check.command.slice(1), {
        cwd: workspace, env: deps.checkEnvironment ?? deps.policy?.environment ?? {}, timeoutMs: check.timeoutMs,
      });
      fact = {
        name: check.name, commit, status: result.exitCode === 0 && !result.timedOut ? "passed" : "failed",
        exitCode: result.exitCode, timedOut: result.timedOut, durationMs: Math.round(performance.now() - start),
        stdout: redactDiagnostics(result.stdout).slice(-2000), stderr: redactDiagnostics(result.stderr).slice(-2000),
      };
    } catch (error) {
      const diagnostics = readDiagnostics(error);
      fact = {
        name: check.name, commit, status: "not_run", exitCode: null, timedOut: diagnostics.command?.timedOut ?? false,
        durationMs: Math.round(performance.now() - start), stdout: diagnostics.command?.stdout ?? "", stderr: diagnostics.command?.stderr ?? "", diagnostics,
      };
    }
    await deps.attempts.append(record, "check_finished", fact);
    current = await deps.attempts.read(record);
    checks = latestChecks(current, commit);
  }
  // A check may itself have changed the workspace; its fact survives, but acceptance must not proceed.
  const finalRefusal = await checkWorkspace(deps, reads, workspace, commit);
  return { checks, ...(finalRefusal ? { refusal: finalRefusal } : {}) };
}
