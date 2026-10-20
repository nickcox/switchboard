import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { onPath } from "../../src/infra/executables.ts";
import { fastForward } from "../../src/workspaces/integration.ts";

// Phase 2 review findings 6 and 17 (docs/phases/02-reconciliation-and-recovery/review-2026-10-21.md).

const git = onPath("git");
const evidence = resolve(import.meta.dirname, "../../.investigation/integration-unit");
mkdirSync(evidence, { recursive: true });

function fixture() {
  const dir = realpathSync(mkdtempSync(join(evidence, "case-")));
  const environment = {
    PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_AUTHOR_NAME: "Switchboard fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Switchboard fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const repository = join(dir, "repository");
  mkdirSync(repository);
  const run = (args: string[], cwd = repository) => execFileSync(git, args, { cwd, env: environment, encoding: "utf8" }).trim();
  const commit = (file: string, cwd = repository) => {
    writeFileSync(join(cwd, file), `${file}\n`);
    run(["add", file], cwd);
    run(["-c", "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"), "commit", "-q", "--no-gpg-sign", "-m", file], cwd);
    return run(["rev-parse", "HEAD"], cwd);
  };
  run(["init", "-q", "-b", "main"]);
  const base = commit("base.txt");
  // The output branch is one commit ahead of main, in a separate worktree as a leased workspace would be.
  const workspace = join(dir, "workspace");
  run(["worktree", "add", "-q", "-b", "output", workspace, "main"]);
  const output = commit("output.txt", workspace);
  return { dir, repository, environment, run, base, output, options: { git, environment, repository } };
}

test("finding 6: a failed worktree inventory refuses the fast-forward instead of updating the ref under a checkout", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  const shim = join(f.dir, "git-shim");
  writeFileSync(shim, `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = list ]; then printf "worktree /elsewhere\\000HEAD ${"0".repeat(40)}\\000detached\\000\\000"; echo "inventory failed" >&2; exit 1; fi\nexec "${git}" "$@"\n`, { mode: 0o755 });
  await assert.rejects(fastForward({ ...f.options, git: shim }, "main", f.base, f.output), /worktree/);
  assert.equal(f.run(["rev-parse", "main"]), f.base);
  assert.equal(f.run(["status", "--porcelain"]), "");
});

test("finding 17: a branch checked out in a worktree whose path contains a newline is fast-forwarded there", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  const odd = join(f.dir, "odd\nworktree");
  f.run(["worktree", "add", "-q", odd, "-b", "target", f.base]);
  await fastForward(f.options, "target", f.base, f.output);
  assert.equal(f.run(["rev-parse", "target"]), f.output);
  assert.equal(existsSync(join(odd, "output.txt")), true);
});
