import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dispatchOnce, type Dependencies } from "../../src/dispatch/dispatch.ts";
import { discard, finish } from "../../src/dispatch/finish.ts";
import { status } from "../../src/dispatch/status.ts";
import { onPath } from "../../src/infra/executables.ts";
import type { LeaseIdentity } from "../../src/workspaces/provider.ts";
import { fixture, task } from "./fixture.ts";

// Phase 2 PRD: finishing an attempt and returning a lease.

async function failedOutput() {
  const f = await fixture({ tasks: [task("finish-a1")], scenario: "commit-result" });
  const launch = f.deps.launch;
  f.deps.launch = async (...args) => {
    await launch(...args);
    const runtime = (await f.runtime.discover("fixture-context"))[0]!;
    rmSync(runtime.binding.resultPath);
    throw new Error("Provider failed after committing");
  };
  const outcome = await dispatchOnce(f.deps);
  assert.equal(await state(f.deps), "held");
  return { f, leaseId: outcome.attempt!.leaseId!, branch: outcome.attempt!.outputBranch!, workspace: outcome.attempt!.workspace! };
}

for (const policy of ["manual", "local-merge"] as const) {
  test(`accept-output accepts failed committed work under ${policy}`, async () => {
    const { f, leaseId, branch } = await failedOutput();
    const deps = policy === "manual" ? f.deps : { ...f.deps, policy: localMerge(f) };
    assert.equal((await finish(deps, { leaseId, noProcesses: true })).reason, "refused");
    const commit = f.run(["rev-parse", branch]);
    const outcome = await finish(deps, { leaseId, noProcesses: true, acceptOutput: true });
    assert.equal(outcome.reason, "finished", outcome.detail ?? "");
    const record = (await f.deps.attempts.forTask("finish-a1"))[0]!;
    assert.deepEqual(record.entries.find(e => e.kind === "output_accepted")?.data, { commit, acceptedBy: "operator" });
    assert.equal((await f.tasks.read("finish-a1"))?.state, "done");
    assert.equal(await listed(f, leaseId), false);
    if (policy === "local-merge") assert.equal(f.run(["rev-parse", "main"]), commit);
  });
}

for (const reason of ["interrupted", "over budget"]) {
  test(`accept-output accepts an attempt held as ${reason}`, async () => {
    const { f, leaseId } = await failedOutput();
    const current = (await f.tasks.read("finish-a1"))!;
    await f.tasks.recordHold(current.id, { reason: `Switchboard attempt 1: ${reason}`, body: current.body });
    assert.equal((await finish(f.deps, { leaseId, noProcesses: true, acceptOutput: true })).reason, "finished");
  });
}

test("finish CLI accepts committed output without a worker result", async () => {
  const { f, leaseId } = await failedOutput();
  const outcome = JSON.parse(execFileSync(process.execPath, [resolve("src/cli.ts"), "finish", "--lease", leaseId, "--accept-output", "--no-processes", "--json", "--config", f.config], { encoding: "utf8" }));
  assert.equal(outcome.reason, "finished");
  assert.equal(await listed(f, leaseId), false);
});

test("accepted output can finish after a failed lease return", async () => {
  const { f, leaseId } = await failedOutput();
  const deps = { ...f.deps, workspaces: Object.assign(Object.create(Object.getPrototypeOf(f.deps.workspaces)), f.deps.workspaces, {
    returnLease: async () => { throw new Error("Treehouse unavailable"); },
  }) };
  assert.equal((await finish(deps, { leaseId, noProcesses: true, acceptOutput: true })).reason, "stopped");
  assert.equal(await state(f.deps), "awaiting_finish");
  assert.equal((await finish(f.deps, { leaseId, noProcesses: true })).reason, "finished");
});

test("accept-output dry run and missing process confirmation do not record acceptance", async () => {
  const { f, leaseId } = await failedOutput();
  assert.equal((await finish(f.deps, { leaseId, noProcesses: false, acceptOutput: true })).nextAction.code, "confirm_no_processes");
  assert.equal((await finish(f.deps, { leaseId, noProcesses: false, acceptOutput: true, dryRun: true })).reason, "planned");
  assert.equal((await kinds(f)).includes("output_accepted"), false);
  assert.equal(await listed(f, leaseId), true);
});

for (const fault of ["missing branch", "no new commits", "untracked", "uncommitted", "unknown", "other pool", "unfinished"] as const) {
  test(`accept-output refuses ${fault}`, async () => {
    const { f, leaseId, branch, workspace } = await failedOutput();
    let deps = f.deps;
    if (fault === "missing branch") f.run(["update-ref", "-d", `refs/heads/${branch}`]);
    if (fault === "no new commits") f.run(["update-ref", `refs/heads/${branch}`, "main"]);
    if (fault === "untracked") writeFileSync(join(workspace, "extra.txt"), "extra");
    if (fault === "uncommitted") writeFileSync(join(workspace, "tracked.txt"), "changed");
    if (fault === "unknown") deps = { ...deps, tasks: { ...deps.tasks, read: async () => { throw new Error("Unreadable"); } } as Dependencies["tasks"] };
    if (fault === "other pool") deps = { ...deps, workspaces: Object.assign(Object.create(Object.getPrototypeOf(deps.workspaces)), deps.workspaces, { leases: async () => [] }) };
    if (fault === "unfinished") {
      deps = { ...deps, workspaces: Object.assign(Object.create(Object.getPrototypeOf(deps.workspaces)), deps.workspaces, { leases: async () => [] }) };
      // A fresh open attempt has neither an outcome nor a worker.
      const ref = await deps.attempts.create("open-a2", {}, 0);
      await deps.attempts.append(ref, "leased", { leaseId: "unfinished", workspace, baseRef: "main", outputBranch: branch, startingCommit: f.run(["rev-parse", "main"]) });
      assert.equal((await finish(deps, { leaseId: "unfinished", noProcesses: true, acceptOutput: true })).reason, "refused");
      return;
    }
    const outcome = await finish(deps, { leaseId, noProcesses: true, acceptOutput: true });
    assert.equal(outcome.reason, "refused", outcome.detail ?? "");
    assert.equal((await kinds(f)).includes("output_accepted"), false);
    assert.equal(await listed(f, leaseId), true);
  });
}

test("accepted output survives a partial failure without needing a worker result on the next run", async () => {
  const { f, leaseId } = await failedOutput();
  let failures = 1;
  const deps = { ...f.deps, policy: localMerge(f), tasks: Object.assign(Object.create(Object.getPrototypeOf(f.tasks)), f.tasks, {
    recordDone: async (id: string, note: string) => {
      if (failures-- > 0) throw new Error("Task store unavailable");
      return f.tasks.recordDone(id, note);
    },
  }) };
  assert.equal((await finish(deps, { leaseId, noProcesses: true, acceptOutput: true })).reason, "stopped");
  assert.equal((await finish(deps, { leaseId, noProcesses: true })).reason, "finished");
  assert.equal((await kinds(f)).filter(k => k === "output_accepted").length, 1);
  assert.equal((await kinds(f)).filter(k => k === "integrated").length, 1);
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
const localMerge = (f: Fixture): NonNullable<Dependencies["policy"]> => ({
  git: onPath("git"), environment: f.environment, repository: join(f.dir, "repository"), baseRef: "main",
  globalFile: join(f.dir, "no-global-policy.json"), context: { kind: "local-merge" },
});
async function reviewed(options: { acceptance?: "independent_deliverable" } = {}) {
  const f = await fixture({ tasks: [task("finish-a1")], scenario: "commit-result", ...options });
  const outcome = await dispatchOnce(f.deps);
  return { f, leaseId: outcome.attempt!.leaseId!, branch: outcome.attempt!.outputBranch!, workspace: outcome.attempt!.workspace! };
}
const listed = async (f: Fixture, leaseId: string) => (await f.deps.workspaces.leases()).some(l => l.leaseId === leaseId);
const kinds = async (f: Fixture) => (await f.deps.attempts.forTask("finish-a1"))[0]!.entries.map(e => e.kind);
const state = async (deps: Dependencies) => (await status(deps)).attempts.find(a => a.attempt.taskId === "finish-a1")?.state;

test("finish without the operator's no-processes confirmation changes nothing", async () => {
  const { f, leaseId } = await reviewed();
  const outcome = await finish(f.deps, { leaseId, noProcesses: false });
  assert.equal(outcome.reason, "refused");
  assert.equal(outcome.nextAction.code, "confirm_no_processes");
  assert.equal(await listed(f, leaseId), true);
  assert.equal((await f.tasks.read("finish-a1"))?.state, "queued");
});

test("finish under the manual policy records the task as done and returns the lease", async () => {
  const { f, leaseId } = await reviewed();
  const outcome = await finish(f.deps, { leaseId, noProcesses: true });
  assert.equal(outcome.reason, "finished", outcome.detail ?? "");
  assert.equal((await f.tasks.read("finish-a1"))?.state, "done");
  assert.equal(await listed(f, leaseId), false);
  assert.deepEqual((await kinds(f)).slice(-2), ["task_recorded", "lease_returned"]);
  assert.equal(await state(f.deps), "finished");
  assert.equal((await finish(f.deps, { leaseId, noProcesses: true })).reason, "refused");
});

test("finish under local-merge fast-forwards the target branch to the output branch first", async () => {
  const { f, leaseId, branch } = await reviewed();
  const deps = { ...f.deps, policy: localMerge(f) };
  const head = f.run(["rev-parse", branch]);
  const outcome = await finish(deps, { leaseId, noProcesses: true });
  assert.equal(outcome.reason, "finished", outcome.detail ?? "");
  assert.equal(f.run(["rev-parse", "main"]), head);
  assert.deepEqual((await kinds(f)).slice(-3), ["integrated", "task_recorded", "lease_returned"]);
});

test("finish under local-merge refuses a change that is not a fast-forward, before changing anything", async () => {
  const { f, leaseId } = await reviewed();
  writeFileSync(join(f.dir, "repository", "elsewhere.txt"), "moved on\n");
  f.run(["add", "elsewhere.txt"]);
  f.run(["commit", "-q", "--no-gpg-sign", "-m", "Main moved on"]);
  const outcome = await finish({ ...f.deps, policy: localMerge(f) }, { leaseId, noProcesses: true });
  assert.equal(outcome.reason, "refused");
  assert.match(outcome.detail ?? "", /fast-forward/);
  assert.equal(await listed(f, leaseId), true);
  assert.equal((await f.tasks.read("finish-a1"))?.state, "queued");
});

test("finish refuses when the retention check no longer passes", async () => {
  const { f, leaseId, branch } = await reviewed();
  f.run(["update-ref", "-d", `refs/heads/${branch}`]);
  const outcome = await finish(f.deps, { leaseId, noProcesses: true });
  assert.equal(outcome.reason, "refused");
  assert.match(outcome.detail ?? "", /not retained/);
  assert.equal(await listed(f, leaseId), true);
});

test("finish and discard refuse an attempt whose worker may still be running", async () => {
  const f = await fixture({ tasks: [task("finish-a1")] });
  const workspace = join(f.dir, "running-workspace");
  mkdirSync(workspace);
  const sessionId = randomUUID();
  const ref = await f.deps.attempts.create("finish-a1", {}, 0);
  await f.deps.attempts.append(ref, "leased", { leaseId: "lease-running", workspace, baseRef: "main", outputBranch: "o", startingCommit: "a".repeat(40) });
  await f.deps.attempts.append(ref, "launched", { sessionId });
  const delivery = { baseRef: "main", startingCommit: "a".repeat(40), outputBranch: "o", kind: "code" as const, acceptance: "review_or_integration" as const, requiredEvidence: [], requiredDeliverables: [] };
  const runtime = await f.runtime.reserve({ identity: { contextId: "fixture-context", taskId: "finish-a1", leaseId: "lease-running", sessionId }, workspace, instructions: "Running", acceptanceCriteria: [], delivery });
  assert.equal((await finish(f.deps, { leaseId: "lease-running", noProcesses: true, acceptOutput: true })).nextAction.code, "stop_worker");
  writeFileSync(join(runtime.directory, "heartbeat.json"), JSON.stringify({ version: 1, at: new Date().toISOString(), pid: process.pid }));
  assert.equal((await finish(f.deps, { leaseId: "lease-running", noProcesses: true, acceptOutput: true })).nextAction.code, "watch_attempt");
  rmSync(join(runtime.directory, "heartbeat.json"));
  assert.equal((await finish(f.deps, { leaseId: "lease-running", noProcesses: true })).nextAction.code, "stop_worker");
  assert.equal((await discard(f.deps, { leaseId: "lease-running", noProcesses: true, confirm: true })).nextAction.code, "stop_worker");
});

test("finish can be run again after a failed lease return, completing only what is left", async () => {
  const { f, leaseId } = await reviewed();
  let failures = 1;
  const flaky: Dependencies = { ...f.deps, policy: localMerge(f), workspaces: Object.assign(Object.create(Object.getPrototypeOf(f.deps.workspaces)), f.deps.workspaces, {
    returnLease: async (lease: LeaseIdentity, options: { discardChanges: boolean }) => {
      if (failures-- > 0) throw new Error("Treehouse unavailable");
      return f.deps.workspaces.returnLease(lease, options);
    },
  }) };
  const first = await finish(flaky, { leaseId, noProcesses: true });
  assert.equal(first.reason, "stopped");
  assert.equal((await f.tasks.read("finish-a1"))?.state, "done");
  assert.equal(await listed(f, leaseId), true);
  const second = await finish(flaky, { leaseId, noProcesses: true });
  assert.equal(second.reason, "finished", second.detail ?? "");
  const recorded = await kinds(f);
  assert.equal(recorded.filter(k => k === "integrated").length, 1);
  assert.equal(recorded.filter(k => k === "task_recorded").length, 2); // dispatch's hold, then finish's done
  assert.equal(await listed(f, leaseId), false);
});

test("the lease is returned only with its exact identity and holder", async () => {
  const { f, leaseId, workspace } = await reviewed();
  const returned: LeaseIdentity[] = [];
  const recording: Dependencies = { ...f.deps, workspaces: Object.assign(Object.create(Object.getPrototypeOf(f.deps.workspaces)), f.deps.workspaces, {
    returnLease: async (lease: LeaseIdentity, options: { discardChanges: boolean }) => { returned.push(lease); return f.deps.workspaces.returnLease(lease, options); },
  }) };
  await finish(recording, { leaseId, noProcesses: true });
  assert.deepEqual(returned, [{ leaseId, holder: "finish-a1", path: workspace }]);
});

test("discard needs explicit confirmation, then returns the lease even with uncommitted changes and leaves the task held", async () => {
  const { f, leaseId, workspace } = await reviewed();
  writeFileSync(join(workspace, "scratch.txt"), "not wanted\n");
  assert.equal((await discard(f.deps, { leaseId, noProcesses: true, confirm: false })).nextAction.code, "confirm_discard");
  assert.equal((await discard(f.deps, { leaseId, noProcesses: false, confirm: true })).nextAction.code, "confirm_no_processes");
  assert.equal(await listed(f, leaseId), true);
  const outcome = await discard(f.deps, { leaseId, noProcesses: true, confirm: true });
  assert.equal(outcome.reason, "discarded", outcome.detail ?? "");
  assert.equal(await listed(f, leaseId), false);
  const held = await f.tasks.read("finish-a1");
  assert.deepEqual([held?.state, held?.held], ["queued", true]);
  assert.deepEqual((await kinds(f)).slice(-2), ["discarded", "lease_returned"]);
});

test("finish refuses an attempt that may be changed but is not awaiting review or finish, such as one its worker held", async () => {
  // The worker reports a valid hold, so its result is readable and retained: only the state check refuses.
  const f = await fixture({ tasks: [task("finish-a1")], scenario: "hold" });
  const leaseId = (await dispatchOnce(f.deps)).attempt!.leaseId!;
  assert.equal(await state(f.deps), "held");
  const outcome = await finish(f.deps, { leaseId, noProcesses: true });
  assert.equal(outcome.reason, "refused");
  assert.equal(await listed(f, leaseId), true);
});
