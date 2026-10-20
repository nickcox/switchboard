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

test("accept-output refuses an output branch with no commits beyond its starting commit, even with a clean workspace", async () => {
  const { f, leaseId, workspace } = await failedOutput();
  const start = (await f.deps.attempts.forTask("finish-a1"))[0]!.entries.find(e => e.kind === "leased")!.data.startingCommit as string;
  execFileSync(onPath("git"), ["-C", workspace, "reset", "-q", "--hard", start], { env: f.environment });
  const outcome = await finish(f.deps, { leaseId, noProcesses: true, acceptOutput: true });
  assert.equal(outcome.reason, "refused");
  assert.match(outcome.detail ?? "", /commits beyond/);
  assert.equal(await listed(f, leaseId), true);
});

test("accept-output applies only to a held attempt, not one whose task update is unconfirmed", async () => {
  const f = await fixture({ tasks: [task("finish-a1")], scenario: "commit-result" });
  const tasks = Object.assign(Object.create(Object.getPrototypeOf(f.tasks)), f.tasks, { recordHold: async () => { throw new Error("lost"); } });
  const leaseId = (await dispatchOnce({ ...f.deps, tasks })).attempt!.leaseId!;
  assert.equal(await state(f.deps), "task_update_unconfirmed");
  assert.equal((await finish(f.deps, { leaseId, noProcesses: true, acceptOutput: true })).reason, "refused");
  assert.equal(await listed(f, leaseId), true);
});

test("a later finish integrates the accepted commit, not commits added to the branch since", async () => {
  const { f, leaseId, workspace } = await failedOutput();
  let failures = 1;
  const deps = { ...f.deps, policy: localMerge(f), tasks: Object.assign(Object.create(Object.getPrototypeOf(f.tasks)), f.tasks, {
    recordDone: async (id: string, note: string) => {
      if (failures-- > 0) throw new Error("Task store unavailable");
      return f.tasks.recordDone(id, note);
    },
  }) };
  // The first run fails before integrating, so local-merge has nothing recorded yet.
  const first = await finish({ ...deps, policy: { ...localMerge(f), context: { kind: "manual" } } }, { leaseId, noProcesses: true, acceptOutput: true });
  assert.equal(first.reason, "stopped");
  const accepted = (await f.deps.attempts.forTask("finish-a1"))[0]!.entries.find(e => e.kind === "output_accepted")!.data.commit;
  writeFileSync(join(workspace, "later.txt"), "added after acceptance\n");
  const git = (...args: string[]) => execFileSync(onPath("git"), ["-C", workspace, ...args], { env: f.environment });
  git("add", "later.txt");
  git("commit", "-q", "--no-gpg-sign", "-m", "Later");
  assert.equal((await finish(deps, { leaseId, noProcesses: true })).reason, "finished");
  assert.equal(f.run(["rev-parse", "main"]), accepted);
});

test("accepted output is checked again immediately before the lease is returned", async () => {
  const { f, leaseId, workspace } = await failedOutput();
  const deps = { ...f.deps, tasks: Object.assign(Object.create(Object.getPrototypeOf(f.tasks)), f.tasks, {
    recordDone: async (id: string, note: string) => {
      writeFileSync(join(workspace, "late.txt"), "written while finishing\n");
      return f.tasks.recordDone(id, note);
    },
  }) };
  const outcome = await finish(deps, { leaseId, noProcesses: true, acceptOutput: true });
  assert.equal(outcome.reason, "stopped");
  assert.match(outcome.detail ?? "", /no longer retained/);
  assert.equal(await listed(f, leaseId), true);
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
  assert.deepEqual((await kinds(f)).slice(-3), ["task_recorded", "lease_return_started", "lease_returned"]);
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
  assert.deepEqual((await kinds(f)).slice(-4), ["integrated", "task_recorded", "lease_return_started", "lease_returned"]);
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
  assert.deepEqual((await kinds(f)).slice(-3), ["discarded", "lease_return_started", "lease_returned"]);
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

// Phase 2 review findings 1, 2 and 12 (docs/phases/02-reconciliation-and-recovery/review-2026-10-21.md).

for (const pause of ["before", "after"] as const) {
  test(`finding 1: discard during a dispatch paused ${pause} its task start fences the launch, so no worker starts`, async () => {
    const f = await fixture({ tasks: [task("finish-a1")], scenario: "commit-result" });
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const tasks = Object.assign(Object.create(Object.getPrototypeOf(f.tasks)), f.tasks, {
      start: async (id: string) => {
        if (pause === "before") { entered(); await barrier; }
        const started = await f.tasks.start(id);
        if (pause === "after") { entered(); await barrier; }
        return started;
      },
    });
    let launched: "not called" | "started" | "refused" = "not called";
    const launch: Dependencies["launch"] = async (...args) => {
      try { const report = await f.deps.launch(...args); launched = "started"; return report; }
      catch (error) { launched = "refused"; throw error; }
    };
    const dispatching = dispatchOnce({ ...f.deps, tasks, launch });
    await reached;
    const leaseId = (await status(f.deps)).attempts.find(a => a.attempt.taskId === "finish-a1")!.attempt.leaseId!;
    const discarded = await discard(f.deps, { leaseId, noProcesses: true, confirm: true });
    release();
    const outcome = await dispatching;
    assert.equal(discarded.reason, "discarded", discarded.detail ?? "");
    assert.notEqual(launched, "started", JSON.stringify({ discarded: discarded.reason, outcome: outcome.reason }));
    assert.equal(await listed(f, leaseId), false);
    assert.equal((await f.runtime.discover("fixture-context")).some(r => r.binding.input.identity.leaseId === leaseId), false);
  });
}

test("finding 2: an ordinary finish checks retention again immediately before returning the lease", async () => {
  const { f, leaseId, branch } = await reviewed();
  const deps = { ...f.deps, tasks: Object.assign(Object.create(Object.getPrototypeOf(f.tasks)), f.tasks, {
    recordDone: async (id: string, note: string) => {
      // Point the output branch at a commit with the same tree but not the reported commit: the workspace stays clean,
      // so Treehouse would return it, but the reported work is no longer on the branch.
      const tree = f.run(["rev-parse", `${branch}^{tree}`]);
      f.run(["update-ref", `refs/heads/${branch}`, f.run(["commit-tree", tree, "-m", "Same tree, different commit"])]);
      return f.tasks.recordDone(id, note);
    },
  }) };
  const outcome = await finish(deps, { leaseId, noProcesses: true });
  assert.notEqual(outcome.reason, "finished");
  assert.equal(await listed(f, leaseId), true);
});

test("finding 12: a lease returned before its log entry failed is recorded by the next run", async () => {
  const { f, leaseId } = await reviewed();
  let failures = 1;
  const attempts = Object.assign(Object.create(Object.getPrototypeOf(f.deps.attempts)), f.deps.attempts, {
    append: async (...args: Parameters<Dependencies["attempts"]["append"]>) => {
      if (args[1] === "lease_returned" && failures-- > 0) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return f.deps.attempts.append(...args);
    },
  });
  const first = await finish({ ...f.deps, attempts }, { leaseId, noProcesses: true });
  assert.equal(first.reason, "stopped");
  assert.equal(first.lease, "none");
  assert.equal(await listed(f, leaseId), false);
  const second = await finish(f.deps, { leaseId, noProcesses: true });
  assert.equal(second.reason, "finished", second.detail ?? "");
  assert.equal((await kinds(f)).filter(k => k === "lease_returned").length, 1);
});

test("finding 12: a fast-forward made before its log entry failed is recorded by the next run", async () => {
  const { f, leaseId, branch } = await reviewed();
  let failures = 1;
  const attempts = Object.assign(Object.create(Object.getPrototypeOf(f.deps.attempts)), f.deps.attempts, {
    append: async (...args: Parameters<Dependencies["attempts"]["append"]>) => {
      if (args[1] === "integrated" && failures-- > 0) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return f.deps.attempts.append(...args);
    },
  });
  assert.equal((await finish({ ...f.deps, attempts, policy: localMerge(f) }, { leaseId, noProcesses: true })).reason, "stopped");
  assert.equal(f.run(["rev-parse", "main"]), f.run(["rev-parse", branch]));
  assert.equal((await finish({ ...f.deps, policy: localMerge(f) }, { leaseId, noProcesses: true })).reason, "finished");
  const integrated = (await f.deps.attempts.forTask("finish-a1"))[0]!.entries.filter(e => e.kind === "integrated");
  assert.deepEqual(integrated.map(e => e.data.commit), [f.run(["rev-parse", branch])]);
});
