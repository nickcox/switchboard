import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WorkspaceError } from "../../src/workspaces/provider.ts";
import { TreehouseProvider } from "../../src/workspaces/treehouse.ts";
import { onPath } from "../../src/infra/executables.ts";

// Runs the real Treehouse CLI against disposable repositories and pools. Requires treehouse and git on PATH.
const treehouse = onPath("treehouse");
const git = onPath("git");
const evidence = resolve(import.meta.dirname, "../../.investigation/workspaces-unit");
mkdirSync(evidence, { recursive: true });

function fixture() {
  const dir = realpathSync(mkdtempSync(join(evidence, "case-")));
  const home = join(dir, "home");
  mkdirSync(home);
  const environment = {
    PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Switchboard fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Switchboard fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const repository = join(dir, "repository");
  const run = (args: string[], cwd = repository) => execFileSync(git, args, { cwd, env: environment, encoding: "utf8" }).trim();
  mkdirSync(repository);
  run(["init", "-q", "-b", "main"]);
  writeFileSync(join(repository, "tracked.txt"), "base\n");
  run(["add", "."]);
  // Commits exist only in disposable fixture repositories.
  run(["-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-gpg-sign", "-m", "Fixture base"]);
  const options = { treehouse, git, repository, poolRoot: join(dir, "pool"), environment };
  return { dir, repository, options, run, base: run(["rev-parse", "HEAD"]) };
}

test("adding an origin remote moves Treehouse to a new pool, so earlier leases stop being listed", async () => {
  const f = fixture();
  const provider = await TreehouseProvider.open(f.options);
  const before = await provider.pool();
  const allocation = await provider.acquire({ holder: "task-a1", baseRef: "main", branch: "switchboard/task-a1/1" });
  assert.equal(allocation.pool, before);
  f.run(["remote", "add", "origin", "https://example.invalid/fixture.git"]);
  assert.notEqual(await provider.pool(), before);
  assert.deepEqual(await provider.leases(), []);
});

test("acquire returns a verified allocation on the requested branch and starting commit", async () => {
  const f = fixture();
  const provider = await TreehouseProvider.open(f.options);
  assert.deepEqual(await provider.leases(), []);
  const allocation = await provider.acquire({ holder: "task-a1", baseRef: "main", branch: "switchboard/task-a1/1" });
  assert.equal(allocation.holder, "task-a1");
  assert.equal(allocation.branch, "switchboard/task-a1/1");
  assert.equal(allocation.startingCommit, f.base);
  assert.equal(f.run(["branch", "--show-current"], allocation.path), "switchboard/task-a1/1");
  assert.deepEqual(await provider.leases(), [
    { leaseId: allocation.leaseId, holder: "task-a1", path: allocation.path, branch: "switchboard/task-a1/1" },
  ]);
});

test("an unknown base is rejected and leaves no lease", async () => {
  const provider = await TreehouseProvider.open(fixture().options);
  await assert.rejects(provider.acquire({ holder: "task-a1", baseRef: "missing-base", branch: "out/1" }),
    (error: unknown) => error instanceof WorkspaceError && error.reason === "rejected");
  assert.deepEqual(await provider.leases(), []);
});

test("an existing output branch is rejected and leaves no lease", async () => {
  const f = fixture();
  f.run(["branch", "switchboard/task-a1/1"]);
  const provider = await TreehouseProvider.open(f.options);
  await assert.rejects(provider.acquire({ holder: "task-a1", baseRef: "main", branch: "switchboard/task-a1/1" }),
    (error: unknown) => error instanceof WorkspaceError && error.reason === "rejected");
  assert.deepEqual(await provider.leases(), []);
});

test("Treehouse allows a second lease with the same holder, so callers must check first", async () => {
  const provider = await TreehouseProvider.open(fixture().options);
  await provider.acquire({ holder: "task-a1", baseRef: "main", branch: "switchboard/task-a1/1" });
  await provider.acquire({ holder: "task-a1", baseRef: "main", branch: "switchboard/task-a1/2" });
  assert.equal((await provider.leases()).filter(lease => lease.holder === "task-a1").length, 2);
});

test("a request that does not finish is an unknown outcome", async () => {
  const provider = await TreehouseProvider.open({ ...fixture().options, timeoutMs: 1 });
  await assert.rejects(provider.acquire({ holder: "task-a1", baseRef: "main", branch: "out/1" }),
    (error: unknown) => error instanceof WorkspaceError && error.reason === "outcome_unknown");
});

test("arguments that look like options are refused before running Treehouse", async () => {
  const provider = await TreehouseProvider.open(fixture().options);
  await assert.rejects(provider.acquire({ holder: "--force", baseRef: "main", branch: "out/1" }));
  await assert.rejects(provider.acquire({ holder: "task-a1", baseRef: "main", branch: "-b" }));
  assert.deepEqual(await provider.leases(), []);
});

test("open requires the canonical top level of a Git work tree", async () => {
  const f = fixture();
  mkdirSync(join(f.repository, "subdirectory"));
  await assert.rejects(TreehouseProvider.open({ ...f.options, repository: join(f.repository, "subdirectory") }), /top level/);
  await assert.rejects(TreehouseProvider.open({ ...f.options, repository: `${f.repository}/subdirectory/..` }), /canonical/);
  await assert.rejects(TreehouseProvider.open({ ...f.options, repository: "repository" }));
});
