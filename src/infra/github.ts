import { runCommand } from "./command.ts";
import type { ForgeFact } from "../dispatch/policy.ts";

/** The GitHub owner and repository named by a remote URL, or undefined for any other host. */
export function githubRepository(url: string): string | undefined {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match?.[1];
}

/**
 * Whether GitHub protects `branch` in the backing repository's origin, read with the GitHub CLI. Anything that cannot
 * be read (no GitHub origin, no `gh`, no access) is reported as unknown rather than guessed.
 */
export async function githubBranchProtection(options: { git: string; gh: string | undefined; repository: string; environment: Record<string, string>; branch: string }): Promise<ForgeFact> {
  const remote = await runCommand(options.git, ["remote", "get-url", "origin"], { cwd: options.repository, env: options.environment, timeoutMs: 15000 });
  const name = remote.exitCode === 0 ? githubRepository(remote.stdout) : undefined;
  if (!name) return { unknown: "the backing repository's origin is not on GitHub" };
  if (!options.gh) return { unknown: "the GitHub CLI (gh) is not on PATH" };
  const result = await runCommand(options.gh, ["api", `repos/${name}/branches/${encodeURIComponent(options.branch)}/protection`], { cwd: options.repository, env: options.environment, timeoutMs: 30000 });
  if (result.exitCode === 0) return { protected: true };
  if (/Branch not protected/.test(result.stdout + result.stderr)) return { protected: false };
  return { unknown: `GitHub did not report whether ${options.branch} is protected: ${(result.stderr || result.stdout).trim().slice(0, 200)}` };
}
