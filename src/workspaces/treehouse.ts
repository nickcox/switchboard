import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { describeCommand, runCommand } from "../infra/command.ts";
import { inside } from "../runtime/records.ts";
import { WorkspaceError, type Allocation, type Lease, type LeaseIdentity, type WorkspaceProvider } from "./provider.ts";

/**
 * Treehouse 3.1 adapter. Commands run from the configured repository with an explicit pool root dedicated to this
 * context, so leases from other contexts never appear. Treehouse does not report the branch's commit, and allows
 * several leases with the same holder, so this adapter verifies the workspace with Git and callers must check for an
 * existing lease before acquiring. See docs/phases/01-basic-dispatch/investigation.md for the tested mapping.
 */
const executable = z.union([z.string().refine(isAbsolute, "Executable must be absolute"), z.custom<() => string>(value => typeof value === "function")]);
const resolveExecutable = (value: z.infer<typeof executable>) => typeof value === "function" ? value() : value;
const optionsSchema = z.object({
  treehouse: executable,
  git: executable,
  repository: z.string().refine(isAbsolute, "Repository path must be absolute"),
  poolRoot: z.string().refine(isAbsolute, "Pool root must be absolute"),
  /** Phase 1 default: no fetch, so acquisition uses the local base branch and works without a remote. */
  fetch: z.boolean().default(false),
  environment: z.record(z.string(), z.string()),
  timeoutMs: z.number().int().positive().default(60000),
});
export type TreehouseOptions = z.input<typeof optionsSchema>;

// Git reads in a workspace are quick; Treehouse acquisition can take much longer, so it has its own timeout.
const gitTimeoutMs = 15000;
const argument = z.string().min(1).refine(value => !value.startsWith("-"), "Must not start with '-'");
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const acquiredSchema = z.object({ path: z.string().min(1), lease_id: z.string().min(1), lease_holder: z.string() });
const statusSchema = z.array(z.object({
  path: z.string().min(1), branch: z.string(), lease_id: z.string(), lease_holder: z.string(),
}));

export class TreehouseProvider implements WorkspaceProvider {
  private readonly options: z.output<typeof optionsSchema>;
  private constructor(options: z.output<typeof optionsSchema>) { this.options = options; }

  /** Defers owner access until an operation needs it; mutations still validate the repository. */
  static connect(options: TreehouseOptions): TreehouseProvider {
    return new TreehouseProvider(optionsSchema.parse(options));
  }

  /** Validates that `repository` is the canonical top level of a Git work tree. */
  static async open(options: TreehouseOptions): Promise<TreehouseProvider> {
    const provider = TreehouseProvider.connect(options);
    resolveExecutable(provider.options.treehouse);
    resolveExecutable(provider.options.git);
    await provider.validateRepository();
    return provider;
  }

  private async validateRepository(): Promise<void> {
    const { repository } = this.options;
    if (await realpath(repository) !== repository) throw new Error("Repository path must be canonical");
    // Git prints forward slashes on Windows, so compare the canonical form of its answer.
    const top = await realpath(await this.git(repository, ["rev-parse", "--show-toplevel"]));
    if (top !== repository) throw new Error("Repository path must be the top level of a Git work tree");
  }

  async acquire(request: { holder: string; baseRef: string; branch: string }): Promise<Allocation> {
    await this.validateRepository();
    const holder = argument.parse(request.holder);
    const baseRef = argument.parse(request.baseRef);
    const branch = argument.parse(request.branch);
    const pool = await this.pool();
    const args = ["get", "--lease", "--json", "--lease-holder", holder, "--base", baseRef, "--branch", branch];
    const result = await this.treehouse([...args, ...(this.options.fetch ? [] : ["--no-fetch"])]);
    if (result.timedOut || result.exitCode === null) {
      throw new WorkspaceError("outcome_unknown", `Treehouse did not report the result of acquiring for ${holder}`, describeCommand(result));
    }
    if (result.exitCode !== 0) {
      // Confirm the refusal left no lease behind before reporting nothing was created.
      const left = (await this.leases()).filter(lease => lease.holder === holder && lease.branch === branch);
      if (left.length > 0) throw new WorkspaceError("unexpected_state", `Treehouse reported failure but leased a workspace for ${holder}`, describeCommand(result));
      throw new WorkspaceError("rejected", `Treehouse refused to acquire a workspace for ${holder}`, describeCommand(result));
    }
    let acquired: z.infer<typeof acquiredSchema>;
    try { acquired = acquiredSchema.parse(JSON.parse(result.stdout)); }
    catch { throw new WorkspaceError("outcome_unknown", `Unreadable Treehouse result for ${holder}`, describeCommand(result)); }
    return { ...await this.verify(acquired, holder, branch), pool };
  }

  async recyclableRoots(): Promise<string[]> { return [this.options.poolRoot]; }

  async returnLease(lease: LeaseIdentity, options: { discardChanges: boolean }): Promise<void> {
    await this.validateRepository();
    const holder = argument.parse(lease.holder);
    const leaseId = argument.parse(lease.leaseId);
    if (!isAbsolute(lease.path)) throw new WorkspaceError("rejected", "Workspace path must be absolute");
    // Treehouse asks before discarding uncommitted changes. Without `discardChanges` its input is closed, so it declines.
    const poolBefore = await this.pool().catch(() => undefined);
    const result = await this.treehouse(["return", "--if-lease-holder", holder, "--if-lease-id", leaseId, lease.path], options.discardChanges ? "y\n" : undefined);
    // Absence from the listing proves a return only if Treehouse reported success and the listing is of the same pool:
    // a lease in a pool that is no longer listed, or a wrong lease ID, is also absent.
    const poolAfter = await this.pool().catch(() => undefined);
    const listing = poolBefore !== undefined && poolAfter === poolBefore ? await this.leases().catch(() => undefined) : undefined;
    const completed = !result.timedOut && result.exitCode !== null;
    if (listing && completed && result.exitCode === 0 && !listing.some(l => l.leaseId === leaseId || l.path === lease.path)) return;
    if (listing && completed && result.exitCode !== 0 && listing.some(l => l.path === lease.path)) {
      if (result.exitCode === 3) throw new WorkspaceError("rejected", `The workspace for lease ${leaseId} has uncommitted changes`, describeCommand(result));
      throw new WorkspaceError("rejected", `Treehouse did not return lease ${leaseId}`, describeCommand(result));
    }
    throw new WorkspaceError("outcome_unknown", `Whether lease ${leaseId} was returned is unknown`, describeCommand(result));
  }

  async leases(): Promise<Lease[]> {
    const result = await this.treehouse(["status", "--json"]);
    if (result.timedOut || result.exitCode !== 0) {
      throw new WorkspaceError("unreadable", "Treehouse status failed", describeCommand(result));
    }
    let rows: z.infer<typeof statusSchema>;
    try { rows = statusSchema.parse(JSON.parse(result.stdout)); }
    catch { throw new WorkspaceError("unreadable", "Unreadable Treehouse status", describeCommand(result)); }
    return rows.filter(row => row.lease_id !== "").map(row => ({
      leaseId: row.lease_id, holder: row.lease_holder, path: row.path, branch: row.branch === "" ? null : row.branch,
    }));
  }

  /**
   * Treehouse names a repository's pool after its origin remote's URL, or after its path when it has no origin
   * (ResolvePoolDir in Treehouse 3.1.3), under the pool root. Adding or changing the origin therefore moves the
   * repository to a new, empty pool, and leases in the old pool stop being listed. This identifier is made from the
   * same inputs, so it changes whenever Treehouse's pool does.
   */
  async pool(): Promise<string> {
    const { git, repository, environment, poolRoot } = this.options;
    const origin = await runCommand(resolveExecutable(git), ["remote", "get-url", "origin"], { cwd: repository, env: environment, timeoutMs: gitTimeoutMs });
    if (origin.timedOut || origin.exitCode === null) throw new WorkspaceError("unreadable", "The repository's origin remote could not be read", describeCommand(origin));
    return JSON.stringify(origin.exitCode === 0 ? { root: poolRoot, origin: origin.stdout.trim() } : { root: poolRoot, repository });
  }

  /** A lease now exists, so any mismatch is unexpected state to preserve, never a reason to acquire again. */
  private async verify(acquired: z.infer<typeof acquiredSchema>, holder: string, branch: string): Promise<Omit<Allocation, "pool">> {
    const unexpected = (message: string) => new WorkspaceError("unexpected_state", `${message} (lease ${acquired.lease_id})`);
    if (acquired.lease_holder !== holder) throw unexpected("Lease holder does not match the task");
    if (!isAbsolute(acquired.path)) throw unexpected("Workspace path is not absolute");
    const path = await realpath(acquired.path).catch(() => { throw unexpected("Workspace path does not exist"); });
    const pool = await realpath(this.options.poolRoot);
    if (path !== acquired.path || !inside(pool, path) || path === pool) throw unexpected("Workspace is not a canonical path in the pool");
    const listed = (await this.leases()).find(lease => lease.leaseId === acquired.lease_id);
    if (!listed || listed.path !== path || listed.holder !== holder) throw unexpected("Lease is not listed as acquired");
    const read = (args: string[]) => this.git(path, args).catch(() => { throw unexpected(`git ${args.join(" ")} failed in the workspace`); });
    const checkedOut = await read(["branch", "--show-current"]);
    if (checkedOut !== branch) throw unexpected(`Workspace has branch ${JSON.stringify(checkedOut)} checked out`);
    const head = commit.safeParse(await read(["rev-parse", "HEAD"]));
    if (!head.success) throw unexpected("Workspace starting commit is unreadable");
    return { leaseId: acquired.lease_id, holder, path, branch, startingCommit: head.data, backingRepository: this.options.repository };
  }

  private treehouse(args: string[], input?: string) {
    const { treehouse, poolRoot, repository, environment, timeoutMs } = this.options;
    return runCommand(resolveExecutable(treehouse), ["--root", poolRoot, ...args], { cwd: repository, env: environment, timeoutMs, ...(input === undefined ? {} : { input }) });
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const result = await runCommand(resolveExecutable(this.options.git), args, { cwd, env: this.options.environment, timeoutMs: gitTimeoutMs });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${describeCommand(result)}`);
    return result.stdout.trim();
  }
}
