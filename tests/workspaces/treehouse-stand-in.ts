import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { runCommand, type CommandResult } from "../../src/infra/command.ts";
import { TreehouseProvider } from "../../src/workspaces/treehouse.ts";

/**
 * Answers the Treehouse 3.1 commands Switchboard runs (`get --lease`, `status --json` and conditional `return`) in this
 * process, with Git worktrees laid out as Treehouse lays them out. Starting Treehouse is most of a dispatch test's time,
 * especially on Windows, where each `status` lists every process on the machine. Everything else in the provider runs
 * unchanged. tests/workspaces/treehouse.test.ts runs the same tests against this and the real Treehouse.
 *
 * Its leases exist only in its own state file, so Treehouse in another process cannot see them: tests that run
 * Switchboard in a separate process use the real Treehouse.
 */
export class TreehouseStandIn extends TreehouseProvider {
  protected override treehouse(args: string[], input?: string): Promise<CommandResult> {
    const [command, ...rest] = args;
    const root = this.options.poolRoot;
    // Treehouse holds its state lock for each command; commands in this process wait for each other in the same way.
    const run = (locks.get(root) ?? Promise.resolve()).then(() => this.run(root, command, rest, input));
    locks.set(root, run.catch(() => {}));
    return run;
  }

  private async run(root: string, command: string | undefined, args: string[], input: string | undefined): Promise<CommandResult> {
    if (command === "get") return this.get(root, options(args));
    if (command === "status" && args[0] === "--json") return this.status(root);
    if (command === "return") return this.return(root, options(args), args.at(-1)!, input);
    return result(2, "", `stand-in: unsupported command ${command}`);
  }

  private async get(root: string, flags: Map<string, string>): Promise<CommandResult> {
    const holder = flags.get("--lease-holder"), base = flags.get("--base"), branch = flags.get("--branch");
    if (!flags.has("--lease") || !flags.has("--json") || !holder || !base || !branch) return result(2, "", "stand-in: unsupported get");
    if (!await this.succeeds(this.options.repository, ["rev-parse", "--verify", "-q", `refs/heads/${base}^{commit}`])) {
      return result(1, "", `base branch "${base}" does not exist`);
    }
    if (await this.succeeds(this.options.repository, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])) return result(1, "", `branch "${branch}" already exists`);
    const pool = await this.poolDirectory(root);
    const state = read(pool);
    let workspace = state.find(w => w.lease_id === "");
    if (workspace) {
      if (!await this.succeeds(workspace.path, ["switch", "-q", "-c", branch, base])) return result(1, "", `could not check out ${branch}`);
    } else {
      const name = String(state.length + 1);
      const path = join(pool, name, basename(this.options.repository));
      mkdirSync(join(pool, name), { recursive: true });
      if (!await this.succeeds(this.options.repository, ["worktree", "add", "-q", "-b", branch, path, base])) return result(1, "", `could not create ${path}`);
      workspace = { name, path: realpathSync.native(path), lease_id: "", lease_holder: "" };
      state.push(workspace);
    }
    workspace.lease_id = randomBytes(16).toString("hex");
    workspace.lease_holder = holder;
    write(pool, state);
    return result(0, JSON.stringify({ path: workspace.path, lease_id: workspace.lease_id, lease_holder: holder, base_branch: base }));
  }

  private async status(root: string): Promise<CommandResult> {
    const rows = [];
    for (const workspace of read(await this.poolDirectory(root))) {
      const branch = workspace.lease_id === "" ? "" : (await this.runGit(workspace.path, ["branch", "--show-current"])).stdout.trim();
      rows.push({ name: workspace.name, path: workspace.path, status: workspace.lease_id === "" ? "available" : "leased", branch, lease_id: workspace.lease_id, lease_holder: workspace.lease_holder });
    }
    return result(0, JSON.stringify(rows));
  }

  /** Like Treehouse, finds the workspace from its path in any pool, including one the repository no longer uses. */
  private async return(root: string, flags: Map<string, string>, path: string, input: string | undefined): Promise<CommandResult> {
    const directory = join(root, ".treehouse");
    for (const pool of existsSync(directory) ? readdirSync(directory).map(name => join(directory, name)) : []) {
      const state = read(pool);
      const workspace = state.find(w => w.path === path);
      if (!workspace) continue;
      if (workspace.lease_id === "" || workspace.lease_id !== flags.get("--if-lease-id") || workspace.lease_holder !== flags.get("--if-lease-holder")) {
        return result(1, "", `failed to return worktree: lease precondition failed: lease identity does not match worktree ${path}`);
      }
      if ((await this.runGit(path, ["status", "--porcelain"])).stdout.trim() !== "") {
        if (!input?.trim().toLowerCase().startsWith("y")) return result(3, "", "worktree not returned: it has uncommitted changes and the confirmation could not be answered");
        await this.runGit(path, ["reset", "-q", "--hard"]);
        await this.runGit(path, ["clean", "-q", "-fd"]);
      }
      // Treehouse detaches a returned workspace at the repository's current commit, which releases the output branch.
      const head = (await this.runGit(this.options.repository, ["rev-parse", "HEAD"])).stdout.trim();
      if (!await this.succeeds(path, ["checkout", "-q", "--detach", head])) return result(1, "", `could not reset ${path}`);
      workspace.lease_id = "";
      workspace.lease_holder = "";
      write(pool, state);
      return result(0, "");
    }
    return result(1, "", `${path} is not a Treehouse worktree`);
  }

  /** Treehouse names the pool after the origin remote's URL, or the repository's path when it has no origin. */
  private async poolDirectory(root: string): Promise<string> {
    const origin = await this.runGit(this.options.repository, ["remote", "get-url", "origin"]);
    const key = origin.exitCode === 0 ? origin.stdout.trim() : this.options.repository;
    return join(root, ".treehouse", `${basename(this.options.repository)}-${createHash("sha256").update(key).digest("hex").slice(0, 6)}`);
  }

  private runGit(cwd: string, args: string[]): Promise<CommandResult> {
    const git = this.options.git;
    return runCommand(typeof git === "function" ? git() : git, args, { cwd, env: this.options.environment, timeoutMs: 15000 });
  }

  private async succeeds(cwd: string, args: string[]): Promise<boolean> { return (await this.runGit(cwd, args)).exitCode === 0; }
}

type Workspace = { name: string; path: string; lease_id: string; lease_holder: string };

const locks = new Map<string, Promise<unknown>>();

function read(pool: string): Workspace[] {
  const file = join(pool, "stand-in-state.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
}

function write(pool: string, state: Workspace[]): void {
  mkdirSync(pool, { recursive: true });
  writeFileSync(join(pool, "stand-in-state.json"), JSON.stringify(state));
}

/** Reads `--name value` pairs, and flags without a value, from the arguments after the command. */
function options(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (!args[i]!.startsWith("--")) continue;
    const value = args[i + 1];
    if (value !== undefined && !value.startsWith("--")) { flags.set(args[i]!, value); i++; }
    else flags.set(args[i]!, "");
  }
  return flags;
}

function result(exitCode: number, stdout: string, stderr = ""): CommandResult {
  return { command: { executable: "treehouse (stand-in)", args: [] }, exitCode, stdout, stderr, timedOut: false, truncated: false };
}
