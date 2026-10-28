import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchOnce, type Dependencies } from "../../src/dispatch/dispatch.ts";
import type { ReadFailure } from "../../src/dispatch/failure.ts";
import { discard, finish } from "../../src/dispatch/finish.ts";
import { status } from "../../src/dispatch/status.ts";
import { onPath } from "../../src/infra/executables.ts";
import { checkRetention } from "../../src/workspaces/retention.ts";
import { TreehouseProvider } from "../../src/workspaces/treehouse.ts";
import { fixture, task } from "./fixture.ts";

// Executable shims exercise adapter diagnostics as well as the operation's read boundaries.
const shimOptions = { skip: process.platform === "win32" };
async function reviewed() {
  const f = await fixture({ tasks: [task("commands-a1")], scenario: "commit-result" });
  const outcome = await dispatchOnce(f.deps);
  return { f, leaseId: outcome.attempt!.leaseId!, commit: outcome.attempt!.resultCommit! };
}

for (const command of ["rev-parse", "merge-base", "rev-list", "status"]) {
  for (const intent of [false, true]) {
    test(`finish: retention Git ${command} fails ${intent ? "after intent" : "before effects"} with its output kept`, shimOptions, async () => {
      const { f, leaseId } = await reviewed();
      const marker = join(f.dir, "failed");
      const git = join(f.dir, "git-read-failure");
      writeFileSync(git, `#!/bin/sh\nif [ "$1" = '${command}' ] && [ ! -f '${marker}' ]; then touch '${marker}'; echo 'partial ${command}'; echo 'failed ${command}' >&2; exit 23; fi\nexec '${onPath("git")}' "$@"\n`, { mode: 0o755 });
      if (intent) {
        const record = (await f.deps.attempts.findByLease(leaseId))!;
        const returnId = randomUUID();
        await f.deps.attempts.appendConfirmed(record, "lease_return_started", { leaseId, by: "finish", returnId },
          { fact: "no_processes", scope: { leaseId, returnId } });
      }
      let returns = 0;
      const workspaces = Object.assign(Object.create(Object.getPrototypeOf(f.deps.workspaces)), f.deps.workspaces, {
        returnLease: async (...args: Parameters<Dependencies["workspaces"]["returnLease"]>) => { returns++; return f.deps.workspaces.returnLease(...args); },
      });
      const deps = { ...f.deps, workspaces, retention: (request: Parameters<Dependencies["retention"]>[0]) => checkRetention(git, f.environment, request) };
      const first = await finish(deps, { leaseId, noProcesses: true });
      assert.equal(first.reason, intent ? "reconciliation_required" : "owner_read_retryable", first.detail ?? "");
      const view = await status(f.deps, { activity: false, transcript: false });
      const failure = view.attempts[0]!.latestReadFailure!;
      assert.equal(failure.owner, "Git retention");
      assert.equal(failure.classification, intent ? "effect_uncertain" : "owner_read");
      assert.equal(failure.diagnostics.command?.exitCode, 23);
      assert.equal(failure.diagnostics.command?.stdout, `partial ${command}\n`);
      assert.equal(failure.diagnostics.command?.stderr, `failed ${command}\n`);
      assert.equal(failure.diagnostics.command?.command?.args[0], command);
      assert.equal(returns, 0);
      const second = await finish(deps, { leaseId, noProcesses: true });
      assert.equal(second.reason, intent ? "reconciliation_required" : "finished", second.detail ?? "");
      assert.equal(returns, intent ? 0 : 1);
    });
  }
}

for (const operation of ["finish", "discard"] as const) {
  test(`${operation}: Treehouse's actual post-return listing failure is kept and never causes another return`, shimOptions, async () => {
    const { f, leaseId } = await reviewed();
    const returned = join(f.dir, "returned");
    const failed = join(f.dir, "listing-failed");
    const treehouse = join(f.dir, "treehouse-read-failure");
    writeFileSync(treehouse, `#!/bin/sh\nif [ "$3" = return ]; then echo return >> '${returned}'; '${onPath("treehouse")}' "$@"; exit $?; fi\nif [ "$3" = status ] && [ -f '${returned}' ] && [ ! -f '${failed}' ]; then touch '${failed}'; echo 'partial lease listing'; echo 'listing unavailable' >&2; exit 23; fi\nexec '${onPath("treehouse")}' "$@"\n`, { mode: 0o755 });
    const workspaces = TreehouseProvider.connect({ treehouse, git: onPath("git"), repository: f.deps.repository, poolRoot: join(f.dir, "pool"), environment: f.environment });
    const deps = { ...f.deps, workspaces };
    const run = () => operation === "finish" ? finish(deps, { leaseId, noProcesses: true }) : discard(deps, { leaseId, noProcesses: true, confirm: true });
    const first = await run();
    assert.equal(first.reason, "reconciliation_required", first.detail ?? "");
    const view = await status(f.deps, { activity: false, transcript: false });
    const failure = view.attempts[0]!.latestReadFailure!;
    assert.equal(failure.owner, "Treehouse leases");
    assert.equal(failure.classification, "effect_uncertain");
    assert.equal(failure.diagnostics.command?.exitCode, 23);
    assert.equal(failure.diagnostics.command?.stdout, "partial lease listing\n");
    assert.equal(failure.diagnostics.command?.stderr, "listing unavailable\n");
    assert.ok(failure.diagnostics.command?.command?.args.includes("status"));
    assert.equal((await run()).reason, operation === "finish" ? "finished" : "discarded");
    assert.equal(readFileSync(returned, "utf8"), "return\n");
  });
}

test("finish: a failed Git read-back after fast-forward requires reconciliation and never repeats integration", shimOptions, async () => {
  const { f, leaseId, commit } = await reviewed();
  f.run(["branch", "target", "main"]);
  const count = join(f.dir, "target-reads");
  const effects = join(f.dir, "integration-effects");
  const git = join(f.dir, "git-read-back-failure");
  writeFileSync(git, `#!/bin/sh\nif [ "$1" = rev-parse ] && [ "$4" = 'refs/heads/target^{commit}' ] && [ -f '${count}' ]; then echo 'target read-back output'; echo 'target read-back error' >&2; exit 23; fi\nif [ "$1" = update-ref ] || [ "$1" = merge ]; then echo effect >> '${effects}'; touch '${count}'; fi\nexec '${onPath("git")}' "$@"\n`, { mode: 0o755 });
  const deps = { ...f.deps, policy: { git, environment: f.environment, repository: f.deps.repository, baseRef: "main",
    globalFile: join(f.dir, "no-policy"), context: { kind: "local-merge" as const, targetBranch: "target" } } };
  const first = await finish(deps, { leaseId, noProcesses: true });
  assert.equal(first.reason, "reconciliation_required", first.detail ?? "");
  assert.equal(f.run(["rev-parse", "target"]), commit);
  assert.equal((await finish(deps, { leaseId, noProcesses: true })).reason, "reconciliation_required");
  assert.equal(readFileSync(effects, "utf8"), "effect\n");
  assert.equal((await f.deps.workspaces.leases()).length, 1);
});

for (const operation of ["finish", "discard"] as const) {
  test(`${operation}: a failed Git pool read is not mistaken for a repository without an origin`, shimOptions, async () => {
    const { f, leaseId } = await reviewed();
    const failed = join(f.dir, "pool-read-failed");
    const git = join(f.dir, "git-pool-failure");
    writeFileSync(git, `#!/bin/sh\nif [ "$1" = remote ] && [ ! -f '${failed}' ]; then touch '${failed}'; echo 'pool output'; echo 'pool error' >&2; exit 23; fi\nexec '${onPath("git")}' "$@"\n`, { mode: 0o755 });
    const workspaces = TreehouseProvider.connect({ treehouse: onPath("treehouse"), git, repository: f.deps.repository,
      poolRoot: join(f.dir, "pool"), environment: f.environment });
    const deps = { ...f.deps, workspaces };
    const run = () => operation === "finish" ? finish(deps, { leaseId, noProcesses: true }) : discard(deps, { leaseId, noProcesses: true, confirm: true });
    const first = await run();
    assert.equal(first.reason, "owner_read_retryable", first.detail ?? "");
    const view = await status(f.deps, { activity: false, transcript: false });
    const failure = view.attempts[0]!.latestReadFailure!;
    assert.equal(failure.owner, "Git workspace pool");
    assert.equal(failure.diagnostics.command?.exitCode, 23);
    assert.equal(failure.diagnostics.command?.stdout, "pool output\n");
    assert.equal(failure.diagnostics.command?.stderr, "pool error\n");
    assert.equal((await run()).reason, operation === "finish" ? "finished" : "discarded");
  });
}

for (const point of ["pool-preflight", "repository-intent", "workspace-effect", "treehouse-effect"] as const) {
  test(`dispatch: real adapter ${point} failure retains command output and never acquires twice`, shimOptions, async () => {
    const f = await fixture({ tasks: [task("commands-a1")] });
    const git = join(f.dir, "git-dispatch-failure"), treehouse = join(f.dir, "treehouse-dispatch-failure");
    const acquisitions = join(f.dir, "acquisitions"), listing = join(f.dir, "listed");
    const condition = point === "pool-preflight" ? '[ "$1" = remote ]' : point === "repository-intent"
      ? '[ "$1" = rev-parse ] && [ "$2" = --show-toplevel ]' : point === "workspace-effect" ? '[ "$1" = branch ]' : 'false';
    writeFileSync(git, `#!/bin/sh\nif ${condition}; then echo 'dispatch output'; echo 'dispatch error' >&2; exit 23; fi\nexec '${onPath("git")}' "$@"\n`, { mode: 0o755 });
    writeFileSync(treehouse, `#!/bin/sh\nif [ "$3" = get ]; then echo acquire >> '${acquisitions}'; fi\nif [ '${point}' = treehouse-effect ] && [ "$3" = status ]; then if [ -f '${listing}' ]; then echo 'dispatch output'; echo 'dispatch error' >&2; exit 23; fi; touch '${listing}'; fi\nexec '${onPath("treehouse")}' "$@"\n`, { mode: 0o755 });
    const workspaces = TreehouseProvider.connect({ treehouse, git, repository: f.deps.repository, poolRoot: join(f.dir, "pool"), environment: f.environment });
    const first = await dispatchOnce({ ...f.deps, workspaces }, { requestId: "faulted-command" });
    assert.equal(first.reason, point === "pool-preflight" ? "owner_read_retryable" : "reconciliation_required", first.detail ?? "");
    const failure = first.observed.readFailure as ReadFailure;
    assert.equal(failure.diagnostics.command?.exitCode, 23);
    assert.equal(failure.diagnostics.command?.stdout, "dispatch output\n");
    assert.equal(failure.diagnostics.command?.stderr, "dispatch error\n");
    assert.equal(failure.owner, point === "pool-preflight" ? "Git workspace pool" : point === "repository-intent" ? "Git repository" : point === "workspace-effect" ? "Git workspace" : "Treehouse leases");
    const acquired = point === "workspace-effect" || point === "treehouse-effect";
    assert.equal((await f.deps.workspaces.leases()).length, acquired ? 1 : 0);
    if (point === "pool-preflight") assert.deepEqual(f.deps.attempts.list(), []);
    else {
      assert.equal((await dispatchOnce(f.deps, { requestId: "faulted-command" })).reason, "existing_request");
      assert.equal(f.deps.attempts.list().length, 1);
    }
    if (acquired) assert.equal(readFileSync(acquisitions, "utf8"), "acquire\n");
  });
}
