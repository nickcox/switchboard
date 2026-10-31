import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dispatchOnce, type Dependencies } from "../../src/dispatch/dispatch.ts";
import { discard, finish } from "../../src/dispatch/finish.ts";
import { describeStatus, status } from "../../src/dispatch/status.ts";
import { onPath } from "../../src/infra/executables.ts";
import type { LeaseIdentity } from "../../src/workspaces/provider.ts";
import { attemptsWith, fixture, task } from "./fixture.ts";

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
    assert.deepEqual(record.entries.find(e => e.kind === "output_accepted")?.data, { commit });
    const accepted = record.confirmations!.find(c => c.fact === "output_accepted")!;
    assert.deepEqual(accepted.scope, { commit });
    assert.match(accepted.confirmedBy, /^operator:/);
    assert.ok(Number.isFinite(Date.parse(accepted.confirmedAt)));
    const returning = record.entries.find(e => e.kind === "lease_return_started")!;
    assert.deepEqual(record.confirmations!.find(c => c.fact === "no_processes")!.scope, { leaseId, returnId: returning.data.returnId });
    assert.equal((await f.tasks.read("finish-a1"))?.state, "done");
    assert.equal(await listed(f, leaseId), false);
    if (policy === "local-merge") assert.equal(f.run(["rev-parse", "main"]), commit);
  });
}

for (const reason of ["interrupted", "over budget"]) {
  test(`accept-output accepts an attempt held as ${reason}`, async () => {
    const { f, leaseId } = await failedOutput();
    const current = (await f.tasks.read("finish-a1"))!;
    await f.tasks.hold(current.id, `Switchboard attempt 1: ${reason}`);
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

test("accept-output dry run does not record acceptance, then finish retains the lease", async () => {
  const { f, leaseId } = await failedOutput();
  const plan = await finish(f.deps, { leaseId, noProcesses: false, acceptOutput: true, dryRun: true });
  assert.equal(plan.reason, "planned");
  assert.match(plan.detail ?? "", /accept output commit.*record the task as done.*retain lease/);
  assert.equal((await kinds(f)).includes("output_accepted"), false);
  const outcome = await finish(f.deps, { leaseId, noProcesses: false, acceptOutput: true });
  assert.equal(outcome.reason, "finished");
  assert.equal(outcome.lease, "preserved");
  assert.equal(outcome.nextAction.code, "finish_attempt");
  assert.equal((await kinds(f)).includes("output_accepted"), true);
  assert.equal((await kinds(f)).includes("lease_return_started"), false);
  assert.equal(await listed(f, leaseId), true);
});

for (const fault of ["missing branch", "no new commits", "untracked", "uncommitted", "unknown"] as const) {
  test(`accept-output refuses ${fault}`, async () => {
    const { f, leaseId, branch, workspace } = await failedOutput();
    let deps = f.deps;
    if (fault === "missing branch") f.run(["update-ref", "-d", `refs/heads/${branch}`]);
    if (fault === "no new commits") f.run(["update-ref", `refs/heads/${branch}`, "main"]);
    if (fault === "untracked") writeFileSync(join(workspace, "extra.txt"), "extra");
    if (fault === "uncommitted") writeFileSync(join(workspace, "tracked.txt"), "changed");
    if (fault === "unknown") deps = { ...deps, tasks: { ...deps.tasks, read: async () => { throw new Error("Unreadable"); } } as Dependencies["tasks"] };
    const outcome = await finish(deps, { leaseId, noProcesses: true, acceptOutput: true });
    assert.equal(outcome.reason, fault === "unknown" ? "owner_read_retryable" : "refused", outcome.detail ?? "");
    assert.equal((await kinds(f)).includes("output_accepted"), false);
    assert.equal(await listed(f, leaseId), true);
  });
}

for (const step of ["output_accepted", "integrated", "task_recorded"] as const) {
  for (const when of ["before", "after"] as const) {
    test(`finish resumes ${when} ${step} without process confirmation or repeating completed records`, async () => {
      const { f, leaseId, branch } = await failedOutput();
      let interrupted = false;
      const interrupt = async <T>(action: () => Promise<T>): Promise<T> => {
        if (interrupted) return action();
        interrupted = true;
        if (when === "after") await action();
        throw new Error(`Interrupted ${when} ${step}`);
      };
      const attempts = attemptsWith(f, {
        appendConfirmed: async (...args) => step === "output_accepted" && args[1] === step
          ? interrupt(() => f.deps.attempts.appendConfirmed(...args)) : f.deps.attempts.appendConfirmed(...args),
        append: async (...args) => step === "integrated" && args[1] === step
          ? interrupt(() => f.deps.attempts.append(...args)) : f.deps.attempts.append(...args),
        finishAttempt: async (...args) => step === "task_recorded"
          ? interrupt(() => f.deps.attempts.finishAttempt(...args)) : f.deps.attempts.finishAttempt(...args),
      });
      const deps = { ...f.deps, policy: localMerge(f), attempts };
      const first = await finish(deps, { leaseId, noProcesses: false, acceptOutput: true });
      assert.equal(first.reason, "stopped", first.detail ?? "");
      assert.equal(await listed(f, leaseId), true);
      assert.equal((await kinds(f)).includes("lease_return_started"), false);
      const plan = await finish(deps, { leaseId, noProcesses: false, acceptOutput: step === "output_accepted" && when === "before", dryRun: true });
      assert.equal(plan.reason, "planned", plan.detail ?? "");
      if ((await kinds(f)).includes("output_accepted")) assert.doesNotMatch(plan.detail ?? "", /accept output commit/);
      if ((await kinds(f)).includes("integrated")) assert.doesNotMatch(plan.detail ?? "", /fast-forward|record that/);
      const resumed = await finish(deps, { leaseId, noProcesses: false, acceptOutput: step === "output_accepted" && when === "before" });
      assert.equal(resumed.reason, "finished", resumed.detail ?? "");
      assert.equal(resumed.lease, "preserved");
      assert.equal(f.run(["rev-parse", "main"]), f.run(["rev-parse", branch]));
      const completed = await kinds(f);
      assert.equal(completed.filter(k => k === "output_accepted").length, 1);
      assert.equal(completed.filter(k => k === "integrated").length, 1);
      const record = (await f.deps.attempts.forTask("finish-a1"))[0]!;
      assert.equal(record.entries.filter(e => e.kind === "task_recorded" && e.data.outcome === "done").length, 1);
      assert.equal((await finish(deps, { leaseId, noProcesses: true })).reason, "finished");
      assert.deepEqual(await kinds(f), [...completed, "lease_return_started", "lease_returned", "output_branch_cleanup"]);
    });
  }
}

test("accepted output survives a partial failure without needing a worker result on the next run", async () => {
  const { f, leaseId } = await failedOutput();
  let failures = 1;
  const deps = { ...f.deps, policy: localMerge(f), attempts: attemptsWith(f, {
    finishAttempt: async (...args) => {
      if (failures-- > 0) throw new Error("Task store unavailable");
      return f.deps.attempts.finishAttempt(...args);
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

test("accept-output applies only to a held attempt, not a stopped one with commits on its branch", async () => {
  const f = await fixture({ tasks: [task("finish-a1")] });
  const { TaskStoreError } = await import("../../src/tasks/store.ts");
  const attempts = attemptsWith(f, { startReservedTask: async () => { throw new TaskStoreError("rejected", "refused"); } });
  const outcome = await dispatchOnce({ ...f.deps, attempts });
  const leaseId = outcome.attempt!.leaseId!, workspace = outcome.attempt!.workspace!;
  const git = (...args: string[]) => execFileSync(onPath("git"), ["-C", workspace, ...args], { env: f.environment });
  writeFileSync(join(workspace, "work.txt"), "committed\n");
  git("add", "work.txt");
  git("commit", "-q", "--no-gpg-sign", "-m", "Work");
  assert.equal(await state(f.deps), "stopped");
  assert.equal((await finish(f.deps, { leaseId, noProcesses: true, acceptOutput: true })).reason, "refused");
  assert.equal(await listed(f, leaseId), true);
});


test("a later finish integrates the accepted commit, not commits added to the branch since", async () => {
  const { f, leaseId, workspace } = await failedOutput();
  let failures = 1;
  const deps = { ...f.deps, policy: localMerge(f), attempts: attemptsWith(f, {
    finishAttempt: async (...args) => {
      if (failures-- > 0) throw new Error("Task store unavailable");
      return f.deps.attempts.finishAttempt(...args);
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

test("finish integrates the worker's exact result commit, not a later branch head", async () => {
  const { f, leaseId, branch, workspace } = await reviewed();
  const commit = f.run(["rev-parse", branch]);
  writeFileSync(join(workspace, "later.txt"), "committed after the worker result\n");
  const git = (...args: string[]) => execFileSync(onPath("git"), ["-C", workspace, ...args], { env: f.environment });
  git("add", "later.txt");
  git("commit", "-q", "--no-gpg-sign", "-m", "Later");
  const deps = { ...f.deps, policy: localMerge(f) };
  const plan = await finish(deps, { leaseId, noProcesses: false, dryRun: true });
  assert.match(plan.detail ?? "", new RegExp(`fast-forward main to ${commit}`));
  const outcome = await finish(deps, { leaseId, noProcesses: false });
  assert.equal(outcome.reason, "finished", outcome.detail ?? "");
  assert.equal(f.run(["rev-parse", "main"]), commit);
  assert.notEqual(f.run(["rev-parse", branch]), commit);
  const completed = await kinds(f);
  assert.equal((await finish(deps, { leaseId, noProcesses: true })).reason, "finished");
  assert.deepEqual(await kinds(f), [...completed, "lease_return_started", "lease_returned", "output_branch_cleanup"]);
  assert.equal(f.run(["rev-parse", "main"]), commit);
});

test("dispatch finalisation uses the recorded report, not a changed file or launch report", async () => {
  const f = await fixture({ tasks: [task("finish-a1")], scenario: "commit-result", acceptance: "independent_deliverable" });
  const launch = f.deps.launch;
  let recorded;
  f.deps.launch = async (...args) => {
    const report = await launch(...args);
    const runtime = (await f.runtime.discover("fixture-context"))[0]!;
    recorded = runtime.validatedResult!.content;
    writeFileSync(runtime.binding.resultPath, JSON.stringify({ ...recorded, summary: "Changed file" }));
    report.result = { ...recorded, summary: "Changed launch report", workReferences: [] };
    return report;
  };
  const outcome = await dispatchOnce(f.deps);
  assert.equal(outcome.reason, "done", outcome.detail ?? "");
  assert.equal(outcome.worker?.summary, recorded!.summary);
  assert.match(outcome.resultDiscrepancy ?? "", /differs/);
  assert.equal(outcome.attempt?.resultCommit, f.run(["rev-parse", outcome.attempt!.outputBranch!]));
});

test("recorded results keep the exact report and commit after the file is changed", async () => {
  const { f, leaseId, branch, workspace } = await reviewed();
  const runtime = (await f.runtime.discover("fixture-context"))[0]!;
  const recorded = runtime.validatedResult!;
  assert.equal(recorded.validationVersion, 1);
  assert.equal(recorded.sourcePath, runtime.binding.resultPath);
  assert.equal(recorded.digest, createHash("sha256").update(readFileSync(recorded.sourcePath)).digest("hex"));
  assert.ok(Number.isFinite(Date.parse(recorded.validatedAt)));
  const commit = f.run(["rev-parse", branch]);
  writeFileSync(join(workspace, "later.txt"), "not the recorded work\n");
  execFileSync(onPath("git"), ["-C", workspace, "add", "later.txt"], { env: f.environment });
  execFileSync(onPath("git"), ["-C", workspace, "commit", "-q", "--no-gpg-sign", "-m", "Later"], { env: f.environment });
  const changed = structuredClone(recorded.content);
  changed.summary = "Replacement report";
  changed.workReferences = [{ kind: "git", name: "output", branch, commit: f.run(["rev-parse", branch]) }];
  writeFileSync(recorded.sourcePath, JSON.stringify(changed));
  const deps = { ...f.deps, policy: localMerge(f) };
  const view = await status(deps);
  assert.deepEqual(view.attempts[0]!.validatedResult, recorded);
  assert.match(view.attempts[0]!.resultDiscrepancy ?? "", /differs/);
  assert.match(describeStatus(view), /Result discrepancy/);
  const retained: string[] = [];
  const outcome = await finish({ ...deps, retention: async request => {
    retained.push(...(request.gitReferences ?? []).map(ref => ref.commit));
    return deps.retention(request);
  } }, { leaseId, noProcesses: true });
  assert.equal(outcome.reason, "finished", outcome.detail ?? "");
  assert.match(outcome.resultDiscrepancy ?? "", /differs/);
  assert.ok(retained.length > 0);
  assert.ok(retained.every(value => value === commit));
  assert.equal(f.run(["rev-parse", "main"]), commit);
  assert.deepEqual((await f.runtime.discover("fixture-context"))[0]!.validatedResult, recorded);
});

for (const change of ["missing", "invalid"] as const) {
  test(`A result file that is ${change} cannot replace a recorded result or block its retention`, async () => {
    const { f, leaseId } = await reviewed();
    const runtime = (await f.runtime.discover("fixture-context"))[0]!;
    if (change === "missing") rmSync(runtime.binding.resultPath);
    else writeFileSync(runtime.binding.resultPath, "not JSON");
    const outcome = await finish(f.deps, { leaseId, noProcesses: true });
    assert.equal(outcome.reason, "finished", outcome.detail ?? "");
    assert.match(outcome.resultDiscrepancy ?? "", /cannot be compared/);
  });
}

for (const valid of [true, false]) {
  test(`an older attempt validates its file once before finishing (${valid ? "valid" : "invalid"})`, async () => {
    const { f, leaseId } = await reviewed();
    const runtime = (await f.runtime.discover("fixture-context"))[0]!;
    await f.tasks.database.transaction(() => {
      f.tasks.database.run("DELETE FROM worker_observations WHERE directory = ? AND kind = 'validated_result'", runtime.directory);
    });
    if (!valid) {
      const changed = structuredClone(runtime.validatedResult!.content);
      changed.identity.sessionId = randomUUID();
      writeFileSync(runtime.binding.resultPath, JSON.stringify(changed));
    }
    const plan = await finish(f.deps, { leaseId, noProcesses: false, dryRun: true });
    assert.equal(plan.reason, valid ? "planned" : "refused", plan.detail ?? "");
    assert.equal((await f.runtime.discover("fixture-context"))[0]!.validatedResult, undefined);
    let checked = false;
    const outcome = await finish({ ...f.deps, retention: async request => {
      assert.ok((await f.runtime.discover("fixture-context"))[0]!.validatedResult, "Record must precede retention");
      checked = true;
      return f.deps.retention(request);
    } }, { leaseId, noProcesses: false });
    assert.equal(outcome.reason, valid ? "finished" : "refused", outcome.detail ?? "");
    assert.equal(checked, valid);
    if (valid) {
      const recorded = (await f.runtime.discover("fixture-context"))[0]!.validatedResult!;
      writeFileSync(runtime.binding.resultPath, "{}");
      const returned = await finish(f.deps, { leaseId, noProcesses: true });
      assert.equal(returned.reason, "finished", JSON.stringify(returned));
      assert.deepEqual((await f.runtime.discover("fixture-context"))[0]!.validatedResult, recorded);
    }
  });
}

test("accept-output can explicitly accept a newer commit after earlier output was integrated", async () => {
  const { f, leaseId, branch, workspace } = await failedOutput();
  const deps = { ...f.deps, policy: localMerge(f) };
  assert.equal((await finish(deps, { leaseId, noProcesses: false, acceptOutput: true })).reason, "finished");
  const first = f.run(["rev-parse", "main"]);
  writeFileSync(join(workspace, "later.txt"), "operator-reviewed follow-up\n");
  const git = (...args: string[]) => execFileSync(onPath("git"), ["-C", workspace, ...args], { env: f.environment });
  git("add", "later.txt");
  git("commit", "-q", "--no-gpg-sign", "-m", "Follow-up");
  assert.equal((await finish(deps, { leaseId, noProcesses: false })).reason, "finished");
  assert.equal(f.run(["rev-parse", "main"]), first);
  const plan = await finish(deps, { leaseId, noProcesses: false, acceptOutput: true, dryRun: true });
  const latest = f.run(["rev-parse", branch]);
  assert.match(plan.detail ?? "", new RegExp(`accept output commit ${latest}.*fast-forward main to ${latest}`));
  assert.equal((await finish(deps, { leaseId, noProcesses: true, acceptOutput: true })).reason, "finished");
  assert.equal(f.run(["rev-parse", "main"]), latest);
});

test("accepted output is checked again immediately before the lease is returned", async () => {
  const { f, leaseId, workspace } = await failedOutput();
  const deps = { ...f.deps, attempts: attemptsWith(f, {
    finishAttempt: async (...args) => {
      writeFileSync(join(workspace, "late.txt"), "written while finishing\n");
      return f.deps.attempts.finishAttempt(...args);
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

for (const policy of ["manual", "local-merge"] as const) {
  test(`finish under ${policy} completes work without process confirmation, then only returns the lease`, async () => {
    const { f, leaseId, branch } = await reviewed();
    await f.tasks.add({ id: "dependent-b1", title: "Dependent", repo: "fixture" });
    await f.tasks.block("dependent-b1", "finish-a1");
    const deps = policy === "manual" ? f.deps : { ...f.deps, policy: localMerge(f) };
    const before = await kinds(f);
    const plan = await finish(deps, { leaseId, noProcesses: false, dryRun: true });
    assert.match(plan.detail ?? "", /record the task as done, then retain lease/);
    assert.deepEqual(await kinds(f), before);
    assert.equal((await f.tasks.ready()).includes("dependent-b1"), false);
    const outcome = await finish(deps, { leaseId, noProcesses: false });
    assert.equal(outcome.reason, "finished", outcome.detail ?? "");
    assert.equal(outcome.lease, "preserved");
    assert.match(outcome.detail ?? "", new RegExp(`Lease retained.*finish --lease ${leaseId} --no-processes`));
    assert.equal(await listed(f, leaseId), true);
    assert.equal((await f.tasks.read("finish-a1"))?.state, "done");
    if (policy === "local-merge") assert.equal(f.run(["rev-parse", "main"]), f.run(["rev-parse", branch]));
    const view = await status(deps);
    assert.ok(view.ready.includes("dependent-b1"));
    assert.equal(view.attempts[0]?.state, "awaiting_finish");
    assert.match(describeStatus(view), new RegExp(`task is done with its lease retained.*finish --lease ${leaseId} --no-processes`));
    assert.equal((await dispatchOnce(deps, { taskId: "dependent-b1", dryRun: true })).reason, "dry_run");
    if (policy === "manual") {
      const dependent = await dispatchOnce(deps, { taskId: "dependent-b1" });
      assert.equal(dependent.reason, "held", dependent.detail ?? "");
      assert.equal(dependent.nextAction.code, "review_then_finish");
      assert.equal(dependent.attempt?.taskId, "dependent-b1");
      assert.notEqual(dependent.attempt?.leaseId, leaseId);
      assert.equal(await listed(f, leaseId), true);
    }
    const completed = await kinds(f);
    const repeated = await finish(deps, { leaseId, noProcesses: false });
    assert.equal(repeated.reason, "finished");
    assert.deepEqual(await kinds(f), completed);
    const returning = await finish(deps, { leaseId, noProcesses: true, dryRun: true });
    assert.equal(returning.detail, `Would return lease ${leaseId}`);
    assert.deepEqual(await kinds(f), completed);
    assert.equal((await finish(deps, { leaseId, noProcesses: true })).reason, "finished");
    assert.deepEqual(await kinds(f), [...completed, "lease_return_started", "lease_returned", "output_branch_cleanup"]);
    assert.equal(await listed(f, leaseId), false);
  });
}

test("finish under the manual policy records the task as done and returns the lease", async () => {
  const { f, leaseId } = await reviewed();
  const outcome = await finish(f.deps, { leaseId, noProcesses: true });
  assert.equal(outcome.reason, "finished", outcome.detail ?? "");
  assert.equal((await f.tasks.read("finish-a1"))?.state, "done");
  assert.equal(await listed(f, leaseId), false);
  assert.deepEqual((await kinds(f)).slice(-4), ["task_recorded", "lease_return_started", "lease_returned", "output_branch_cleanup"]);
  assert.equal(await state(f.deps), "finished");
  assert.equal((await finish(f.deps, { leaseId, noProcesses: true })).reason, "refused");
});

test("finish under local-merge fast-forwards the target branch to the output branch first", async () => {
  const { f, leaseId, branch } = await reviewed();
  const deps = { ...f.deps, policy: localMerge(f) };
  const head = f.run(["rev-parse", branch]);
  const before = await kinds(f);
  const plan = await finish(deps, { leaseId, noProcesses: true, dryRun: true });
  assert.equal(plan.detail, `Would fast-forward main to ${head}, then record the task as done, then return lease ${leaseId}`);
  assert.deepEqual(await kinds(f), before);
  const outcome = await finish(deps, { leaseId, noProcesses: true });
  assert.equal(outcome.reason, "finished", outcome.detail ?? "");
  assert.equal(f.run(["rev-parse", "main"]), head);
  assert.deepEqual((await kinds(f)).slice(-5), ["integrated", "task_recorded", "lease_return_started", "lease_returned", "output_branch_cleanup"]);
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
  await runtime.storage.releaseClaim(runtime.claimId);
  assert.equal((await finish(f.deps, { leaseId: "lease-running", noProcesses: true, acceptOutput: true })).nextAction.code, "stop_worker");
  await f.tasks.database.transaction(() => f.tasks.database.run("UPDATE worker_claims SET released_at = NULL, heartbeat_at = ? WHERE id = ?", new Date().toISOString(), runtime.claimId));
  assert.equal((await finish(f.deps, { leaseId: "lease-running", noProcesses: true, acceptOutput: true })).nextAction.code, "watch_attempt");
  await runtime.storage.releaseClaim(runtime.claimId);
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
  assert.deepEqual((await kinds(f)).slice(-4), ["discarded", "lease_return_started", "lease_returned", "output_branch_cleanup"]);
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
    const attempts = attemptsWith(f, {
      startReservedTask: async ref => {
        if (pause === "before") { entered(); await barrier; }
        const started = await f.deps.attempts.startReservedTask(ref);
        if (pause === "after") { entered(); await barrier; }
        return started;
      },
    });
    let launched: "not called" | "started" | "refused" = "not called";
    const launch: Dependencies["launch"] = async (...args) => {
      try { const report = await f.deps.launch(...args); launched = "started"; return report; }
      catch (error) { launched = "refused"; throw error; }
    };
    const dispatching = dispatchOnce({ ...f.deps, attempts, launch });
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
  const deps = { ...f.deps, attempts: attemptsWith(f, {
    finishAttempt: async (...args) => {
      // Point the output branch at a commit with the same tree but not the reported commit: the workspace stays clean,
      // so Treehouse would return it, but the reported work is no longer on the branch.
      const tree = f.run(["rev-parse", `${branch}^{tree}`]);
      f.run(["update-ref", `refs/heads/${branch}`, f.run(["commit-tree", tree, "-m", "Same tree, different commit"])]);
      return f.deps.attempts.finishAttempt(...args);
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
  const before = await kinds(f);
  for (const noProcesses of [false, true]) {
    const plan = await finish(f.deps, { leaseId, noProcesses, dryRun: true });
    assert.equal(plan.reason, "planned");
    assert.match(plan.detail ?? "", /Output branch .*kept.*not in target branch main/);
    assert.deepEqual(await kinds(f), before);
  }
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
  assert.deepEqual(integrated.map(e => e.data.commit), [f.run(["rev-parse", "main"])]);
});

// Phase 2 review findings 8, 9, 11 and 16. Each test asserts the attempt's state before the command's outcome, so it
// cannot pass by refusing for another reason.

test("finding 16: accept-output refuses an attempt whose lease is in another pool", async () => {
  const { f, leaseId } = await failedOutput();
  f.run(["remote", "add", "origin", "https://example.invalid/fixture.git"]);
  assert.equal(await state(f.deps), "lease_in_other_pool");
  assert.equal((await finish(f.deps, { leaseId, noProcesses: true, acceptOutput: true })).reason, "refused");
  f.run(["remote", "remove", "origin"]);
  assert.equal(await listed(f, leaseId), true);
  assert.equal((await kinds(f)).includes("output_accepted"), false);
});

test("finding 16: accept-output refuses an unfinished attempt", async () => {
  const f = await fixture({ tasks: [task("finish-a1")] });
  const ref = await f.deps.attempts.create("finish-a1", { pool: await f.deps.workspaces.pool() }, 0);
  await f.deps.attempts.append(ref, "leased", { leaseId: "unfinished", workspace: f.dir, baseRef: "main", outputBranch: "o", startingCommit: f.run(["rev-parse", "main"]), pool: await f.deps.workspaces.pool() });
  assert.equal(await state(f.deps), "unfinished");
  assert.equal((await finish(f.deps, { leaseId: "unfinished", noProcesses: true, acceptOutput: true })).reason, "refused");
});

test("finding 8: once the output is fixed, a not-retained attempt can be finished", async () => {
  const f = await fixture({ tasks: [task("finish-a1")], scenario: "commit-result" });
  let failures = 1;
  const retention: Dependencies["retention"] = async request => {
    const checked = await f.deps.retention(request);
    return failures-- > 0 ? { ...checked, retained: false, findings: ["temporarily unavailable"] } : checked;
  };
  const leaseId = (await dispatchOnce({ ...f.deps, retention })).attempt!.leaseId!;
  assert.equal(await state(f.deps), "not_retained");
  const outcome = await finish(f.deps, { leaseId, noProcesses: true });
  assert.equal(outcome.reason, "finished", outcome.detail ?? "");
  assert.equal((await f.tasks.read("finish-a1"))?.state, "done");
});

test("finding 8: a not-retained attempt whose output is still not retained is refused", async () => {
  const f = await fixture({ tasks: [task("finish-a1")], acceptance: "independent_deliverable" });
  const leaseId = (await dispatchOnce(f.deps)).attempt!.leaseId!;
  assert.equal(await state(f.deps), "not_retained");
  assert.equal((await finish(f.deps, { leaseId, noProcesses: true })).reason, "refused");
  assert.equal(await listed(f, leaseId), true);
});

test("after the operator records reviewed work as done, the attempt can be finished", async () => {
  const f = await fixture({ tasks: [task("finish-a1")], scenario: "commit-result" });
  const leaseId = (await dispatchOnce(f.deps)).attempt!.leaseId!;
  assert.equal(await state(f.deps), "awaiting_review");
  await f.tasks.done("finish-a1", "Completed by the operator");
  const outcome = await finish(f.deps, { leaseId, noProcesses: true });
  assert.equal(outcome.reason, "finished", outcome.detail ?? "");
  assert.ok((await kinds(f)).includes("task_recorded"));
});

test("finding 11: discard holds a task that was queued and not held", async () => {
  const f = await fixture({ tasks: [task("finish-a1")] });
  const { TaskStoreError } = await import("../../src/tasks/store.ts");
  const attempts = attemptsWith(f, { startReservedTask: async () => { throw new TaskStoreError("rejected", "refused"); } });
  const leaseId = (await dispatchOnce({ ...f.deps, attempts })).attempt!.leaseId!;
  assert.equal(await state(f.deps), "stopped");
  assert.equal((await f.tasks.read("finish-a1"))?.held, false);
  assert.equal((await discard(f.deps, { leaseId, noProcesses: true, confirm: true })).reason, "discarded");
  const held = await f.tasks.read("finish-a1");
  assert.deepEqual([held?.state, held?.held], ["queued", true]);
  assert.deepEqual(await f.tasks.ready(), []);
});

test("finish completes a failed outcome transaction from the worker's completed result", async () => {
  const f = await fixture({ tasks: [task("finish-a1")], scenario: "commit-result" });
  const attempts = attemptsWith(f, { recordOutcome: async () => { throw new Error("database unavailable"); } });
  const leaseId = (await dispatchOnce({ ...f.deps, attempts })).attempt!.leaseId!;
  assert.equal(await state(f.deps), "stopped");
  assert.equal((await f.tasks.read("finish-a1"))!.state, "in_flight");
  const result = await finish(f.deps, { leaseId, noProcesses: true });
  assert.equal(result.reason, "finished", result.detail ?? "");
  assert.equal((await f.tasks.read("finish-a1"))!.state, "done");
  assert.equal((await kinds(f)).filter(kind => kind === "task_recorded").length, 1);
});

test("an outcome from a worker that held its task is not finished as done", async () => {
  const f = await fixture({ tasks: [task("finish-a1")], scenario: "hold" });
  const leaseId = (await dispatchOnce(f.deps)).attempt!.leaseId!;
  assert.equal(await state(f.deps), "held");
  assert.equal((await finish(f.deps, { leaseId, noProcesses: true })).reason, "refused");
  assert.notEqual((await f.tasks.read("finish-a1"))?.state, "done");
  assert.equal(await listed(f, leaseId), true);
});
