import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { finish, discard } from "../../src/dispatch/finish.ts";
import { prune } from "../../src/dispatch/prune.ts";
import { cleanupOutputBranches } from "../../src/dispatch/cleanup-output-branches.ts";
import { createReview } from "../../src/dispatch/review.ts";
import { describeStatus, status } from "../../src/dispatch/status.ts";
import { onPath } from "../../src/infra/executables.ts";
import { PiWorker } from "../../src/runtime/pi/worker.ts";
import { attemptsWith, fixture, task } from "./fixture.ts";

const taskId = "branches-a1";
const review = { kind: "artefact" as const, acceptance: "independent_deliverable" as const, requiredEvidence: [], requiredDeliverables: ["report"] };
async function output() {
  const f = await fixture({ tasks: [task(taskId)], scenario: "commit-result", byTaskKind: { review } });
  const first = await dispatchOnce(f.deps);
  assert.equal(first.retention?.retained, true);
  const { leaseId, outputBranch: branch, resultCommit: commit } = first.attempt!;
  const policy = { git: onPath("git"), environment: f.environment, repository: f.deps.repository, baseRef: "main",
    globalFile: join(f.dir, "no-policy.json"), context: { kind: "local-merge" as const } };
  return { ...f, leaseId: leaseId!, branch: branch!, commit: commit!, merged: { ...f.deps, policy } };
}
function exists(f: Awaited<ReturnType<typeof output>>) {
  return f.run(["branch", "--list", f.branch]) !== "";
}
function lock(f: Awaited<ReturnType<typeof output>>) {
  const path = join(f.deps.repository, ".git", "refs", "heads", `${f.branch}.lock`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "fixture lock");
  return path;
}

for (const policy of ["manual", "local-merge"] as const) test(`output branch follows confirmed finish under ${policy}`, async () => {
  const f = await output();
  try {
    const deps = policy === "manual" ? f.deps : f.merged;
    assert.equal((await finish(deps, { leaseId: f.leaseId, noProcesses: false })).reason, "finished");
    assert.equal(exists(f), true, "Retaining the lease retains the branch");
    const result = await finish(deps, { leaseId: f.leaseId, noProcesses: true });
    assert.equal(result.reason, "finished", JSON.stringify(result));
    assert.equal(result.lease, "none");
    assert.equal(exists(f), policy === "manual");
    assert.match(result.detail!, policy === "manual" ? /kept.*not in target branch main/ : /deleted/);
    const view = await status(deps);
    assert.equal(view.attempts[0]!.outputBranchCleanup!.status, policy === "manual" ? "kept" : "deleted");
    assert.match(describeStatus(view), policy === "manual" ? /Output branch .*kept.*not in target branch main/ : /Output branch .*deleted/);
    const entries = f.deps.attempts.findForTask(taskId)!.entries;
    assert.equal(entries.at(-2)!.kind, "lease_returned");
    assert.equal(entries.at(-1)!.kind, "output_branch_cleanup");
  } finally { f.tasks.close(); }
});

test("discard deletes only the recorded output branch after returning its lease", async () => {
  const f = await output();
  try {
    const result = await discard(f.deps, { leaseId: f.leaseId, noProcesses: true, confirm: true });
    assert.equal(result.reason, "discarded", JSON.stringify(result));
    assert.equal(result.lease, "none");
    assert.equal(exists(f), false);
    assert.match(result.detail!, /deleted/);
  } finally { f.tasks.close(); }
});

test("a moved output branch is kept even after local integration or discard", async () => {
  for (const by of ["finish", "discard"] as const) {
    const f = await output();
    try {
      f.run(["commit", "--allow-empty", "--no-gpg-sign", "-m", "Later work"], f.deps.attempts.findForTask(taskId)!.allocation!.workspace);
      const moved = f.run(["rev-parse", f.branch]);
      const result = by === "finish" ? await finish(f.merged, { leaseId: f.leaseId, noProcesses: true })
        : await discard(f.deps, { leaseId: f.leaseId, noProcesses: true, confirm: true });
      assert.equal(result.lease, "none", JSON.stringify(result));
      assert.match(result.detail!, /kept.*no longer points at recorded commit/);
      assert.equal(f.run(["rev-parse", f.branch]), moved);
    } finally { f.tasks.close(); }
  }
});

test("failed deletion is recorded and never prevents a lease return", async () => {
  const f = await output();
  const path = lock(f);
  try {
    const result = await finish(f.merged, { leaseId: f.leaseId, noProcesses: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.lease, "none");
    assert.equal((await f.deps.workspaces.leases()).length, 0);
    assert.equal(exists(f), true);
    assert.match(result.detail!, /kept.*Could not delete output branch/);
    assert.match(JSON.stringify(f.deps.attempts.findForTask(taskId)!.entries.at(-1)!.data), /Could not delete output branch/);
  } finally { rmSync(path, { force: true }); f.tasks.close(); }
});

test("Git's old-value check preserves a branch moved between inspection and deletion", { skip: process.platform === "win32" }, async () => {
  const f = await output();
  try {
    const git = onPath("git");
    const shim = join(f.dir, "git-moved-output");
    const earlier = f.run(["rev-parse", `${f.commit}^`]);
    writeFileSync(shim, `#!/bin/sh\nif [ "$1" = update-ref ] && [ "$3" = -d ] && [ "$4" = 'refs/heads/${f.branch}' ]; then '${git}' update-ref 'refs/heads/${f.branch}' '${earlier}'; fi\nexec '${git}' "$@"\n`, { mode: 0o755 });
    const result = await finish({ ...f.merged, policy: { ...f.merged.policy, git: shim } }, { leaseId: f.leaseId, noProcesses: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.lease, "none");
    assert.equal(f.run(["rev-parse", f.branch]), earlier);
    assert.match(result.detail!, /kept.*Could not delete output branch/);
    assert.match(result.detail!, /expected/);
  } finally { f.tasks.close(); }
});

test("a failed cleanup log write does not fail or undo the lease return or deletion", async () => {
  const f = await output();
  try {
    const attempts = attemptsWith(f, { append: async (...args) => {
      if (args[1] === "output_branch_cleanup") throw new Error("Fixture recording failure");
      return f.deps.attempts.append(...args);
    } });
    const result = await finish({ ...f.merged, attempts }, { leaseId: f.leaseId, noProcesses: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.lease, "none");
    assert.equal(exists(f), false);
    assert.match(result.detail!, /deleted.*Could not record branch cleanup: Fixture recording failure/);
  } finally { f.tasks.close(); }
});

test("integrated output with no branch can be reviewed and continued from", async () => {
  const f = await output();
  try {
    f.run(["branch", "integration", "main"]);
    const merged = { ...f.merged, policy: { ...f.merged.policy, context: { kind: "local-merge" as const, targetBranch: "integration" } } };
    assert.equal((await finish(merged, { leaseId: f.leaseId, noProcesses: true })).ok, true);
    assert.notEqual(f.run(["rev-parse", "main"]), f.commit, "Retention uses the recorded integration target, not today's configuration");
    assert.equal(exists(f), false);
    const created = await createReview(f.deps, { taskId, attempt: 1 });
    assert.equal(created.reason, "review_created", JSON.stringify(created));
    const worker = new PiWorker(f.runtime, { executable: process.execPath, entrypoint: resolve("tests/fixtures/pi-rpc.ts"), provider: "fixture", model: "fixture", shellTool: "bash",
      requestMs: 2000, runMs: 5000, stopMs: 600, environment: { ...f.environment, FAKE_PI_SCENARIO: "review-pass", FAKE_PI_LOG: join(f.dir, "review.jsonl") } });
    const reviewed = await dispatchOnce({ ...f.deps, launch: (input, signal, onRequest) => worker.execute(input, signal, onRequest ? { onRequest } : {}) }, { taskId: created.task!.id });
    assert.equal(reviewed.reason, "done", JSON.stringify(reviewed));
    assert.equal(f.deps.attempts.findForTask(taskId)!.entries.find(e => e.kind === "review_recorded")!.data.verdict, "passed");
    assert.equal((await discard(f.deps, { leaseId: reviewed.attempt!.leaseId!, noProcesses: true, confirm: true })).ok, true);
    await f.tasks.reopen(taskId);
    const next = await dispatchOnce(f.deps, { taskId, startingPoint: { taskId, attempt: 1 } });
    assert.equal(next.retention?.retained, true, JSON.stringify(next));
    assert.equal(next.attempt!.startingCommit, f.commit);
    assert.equal(exists(f), false);
  } finally { f.tasks.close(); }
});

test("one-time cleanup plans without changes, then deletes integrated branches and reports kept branches", async () => {
  for (const policy of ["manual", "local-merge", "discard"] as const) {
    const f = await output();
    const path = lock(f);
    try {
      const result = policy === "discard" ? await discard(f.deps, { leaseId: f.leaseId, noProcesses: true, confirm: true })
        : await finish(policy === "manual" ? f.deps : f.merged, { leaseId: f.leaseId, noProcesses: true });
      assert.equal(result.ok, true, JSON.stringify(result));
      rmSync(path);
      const before = f.deps.attempts.findForTask(taskId)!.entries.length;
      const plan = await cleanupOutputBranches(f.deps, { dryRun: true });
      assert.equal(plan.ok, true);
      assert.match(plan.detail!, policy === "manual" ? /kept.*not in target branch main/ : /planned/);
      assert.equal(exists(f), true);
      assert.equal(f.deps.attempts.findForTask(taskId)!.entries.length, before);
      const run = spawnSync(process.execPath, [resolve("src/cli.ts"), "cleanup-output-branches", "--json", "--config", f.config], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr || run.stdout);
      assert.match(JSON.parse(run.stdout).detail, policy === "manual" ? /kept.*not in target branch main/ : /deleted/);
      assert.equal(exists(f), policy === "manual");
    } finally { rmSync(path, { force: true }); f.tasks.close(); }
  }
});

test("one-time cleanup preserves held leases and moved branches, then cleans up manually integrated output", async () => {
  const f = await output();
  try {
    const held = await cleanupOutputBranches(f.deps, {});
    assert.match(held.detail!, /kept.*Lease is still held/);
    assert.equal(exists(f), true);
    assert.equal((await finish(f.deps, { leaseId: f.leaseId, noProcesses: true })).ok, true);
    f.run(["merge", "--ff-only", f.commit]);
    f.run(["update-ref", `refs/heads/${f.branch}`, `${f.commit}^`]);
    const moved = await cleanupOutputBranches(f.deps, {});
    assert.match(moved.detail!, /kept.*no longer points at recorded commit/);
    assert.equal(exists(f), true);
    f.run(["update-ref", `refs/heads/${f.branch}`, f.commit]);
    const cleaned = await cleanupOutputBranches(f.deps, {});
    assert.match(cleaned.detail!, /deleted/);
    assert.equal(exists(f), false);
  } finally { f.tasks.close(); }
});

for (const by of ["finish", "discard"] as const) test(`one-time cleanup includes archived ${by} attempts and records its result`, async () => {
  const f = await output();
  const path = lock(f);
  try {
    const result = by === "finish" ? await finish(f.merged, { leaseId: f.leaseId, noProcesses: true })
      : await discard(f.deps, { leaseId: f.leaseId, noProcesses: true, confirm: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    rmSync(path);
    const pruned = await prune(f.deps, { olderThan: 1e-9 });
    assert.equal(pruned.ok, true, JSON.stringify(pruned));
    assert.equal(f.deps.attempts.findForTask(taskId), undefined);
    const before = f.tasks.database.get("SELECT summary FROM archived_attempts WHERE task = ?", taskId)!.summary;
    const plan = await cleanupOutputBranches(f.deps, { dryRun: true });
    assert.match(plan.detail!, /planned/);
    assert.equal(exists(f), true);
    assert.equal(f.tasks.database.get("SELECT summary FROM archived_attempts WHERE task = ?", taskId)!.summary, before);
    const cleaned = await cleanupOutputBranches(f.deps, {});
    assert.match(cleaned.detail!, /deleted/);
    assert.equal(exists(f), false);
    const archive = JSON.parse(String(f.tasks.database.get("SELECT summary FROM archived_attempts WHERE task = ?", taskId)!.summary));
    assert.equal(archive.outputBranchRecord.commit, f.commit);
    assert.equal(archive.outputBranchRecord.discarded, by === "discard");
    assert.equal(archive.outputBranchCleanup.at(-1).status, "deleted");
    assert.match(archive.outputBranchCleanup.at(-1).askedBy, /^operator:/);
  } finally { rmSync(path, { force: true }); f.tasks.close(); }
});
