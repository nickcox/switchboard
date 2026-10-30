import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { userInfo } from "node:os";
import { AttemptStore } from "../../src/attempts/store.ts";
import { callerName, type Caller } from "../../src/caller.ts";
import { dispatchOnce, type Dependencies } from "../../src/dispatch/dispatch.ts";
import { finish } from "../../src/dispatch/finish.ts";
import { createReview } from "../../src/dispatch/review.ts";
import { resolveReadFailure } from "../../src/dispatch/resolve.ts";
import { status } from "../../src/dispatch/status.ts";
import { onPath } from "../../src/infra/executables.ts";
import { ObjectiveStore, defaultPermissions } from "../../src/objectives/store.ts";
import { PiWorker } from "../../src/runtime/pi/worker.ts";
import { testCaller } from "../caller.ts";
import { attemptsWith, fixture, task } from "./fixture.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const reviewContract = { kind: "artefact" as const, acceptance: "independent_deliverable" as const, requiredEvidence: [], requiredDeliverables: ["report"] };
const localMerge = (f: Fixture) => ({
  git: onPath("git"), environment: f.environment, repository: f.deps.repository, baseRef: "main",
  globalFile: join(f.dir, "no-global-policy.json"), context: { kind: "local-merge" as const },
});

async function output(t: TestContext, failed = false) {
  const f = await fixture({ tasks: [task("rebase-a1")], scenario: "commit-result", byTaskKind: { review: reviewContract } });
  t.after(() => f.tasks.close());
  await f.tasks.update("rebase-a1", { acceptanceCriteria: ["Keep the output"] });
  if (failed) {
    const launch = f.deps.launch;
    f.deps.launch = async (...args) => {
      await launch(...args);
      rmSync((await f.runtime.discover(f.deps.contextId))[0]!.binding.resultPath);
      throw new Error("Provider failed after committing");
    };
  }
  const outcome = await dispatchOnce(f.deps);
  assert.equal(outcome.reason, "held", JSON.stringify(outcome));
  const branch = outcome.attempt!.outputBranch!;
  return { f, deps: { ...f.deps, policy: localMerge(f) }, leaseId: outcome.attempt!.leaseId!, branch,
    workspace: outcome.attempt!.workspace!, original: f.run(["rev-parse", branch]) };
}
type Output = Awaited<ReturnType<typeof output>>;
const record = (r: Output) => r.f.deps.attempts.findForTask("rebase-a1", 1)!;
const kinds = (r: Output) => record(r).entries.map(e => e.kind);
function moveMain(r: Output, file = "elsewhere.txt", content = "moved on\n") {
  writeFileSync(join(r.f.deps.repository, file), content);
  r.f.run(["add", file]);
  r.f.run(["commit", "-q", "--no-gpg-sign", "-m", `Main changed ${file}`]);
  return r.f.run(["rev-parse", "main"]);
}
function unchanged(r: Output, target: string, entries?: string[]) {
  assert.equal(r.f.run(["rev-parse", r.branch]), r.original);
  assert.equal(r.f.run(["symbolic-ref", "HEAD"], r.workspace), `refs/heads/${r.branch}`);
  assert.equal(existsSync(r.f.run(["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge"], r.workspace)), false);
  assert.equal(r.f.run(["rev-parse", "main"]), target);
  if (entries) assert.deepEqual(kinds(r), entries);
  assert.equal(r.f.tasks.database.get("SELECT state FROM tasks WHERE id = ?", "rebase-a1")!.state, "queued");
}
const options = (r: Output) => ({ leaseId: r.leaseId, noProcesses: false, rebase: true });

test("finish names --rebase when the target has moved and changes nothing", async t => {
  const r = await output(t);
  const target = moveMain(r);
  const entries = kinds(r);
  for (const dryRun of [false, true]) {
    const outcome = await finish(r.deps, { leaseId: r.leaseId, noProcesses: false, dryRun });
    assert.equal(outcome.reason, "refused");
    assert.equal(outcome.nextAction.code, "rebase_or_discard");
    assert.match(outcome.nextAction.description, /--rebase/);
    assert.equal((outcome.observed.refusal as { reason: string }).reason, "not_fast_forward");
    unchanged(r, target, entries);
  }
});

test("dry run plans the rebase, acceptance, fast-forward and outcome a run then records", async t => {
  const r = await output(t);
  const start = record(r).allocation!.startingCommit;
  const target = moveMain(r);
  const entries = kinds(r);
  const plan = await finish(r.deps, { ...options(r), dryRun: true });
  assert.equal(plan.reason, "planned", plan.detail ?? "");
  assert.match(plan.detail!, new RegExp(`rebase ${r.branch} \\(1 commit after ${start}\\) onto main at ${target}`));
  assert.match(plan.detail!, /then accept the rebased commit as operator:.*then fast-forward main to the rebased commit, then record the task as done, then retain lease/);
  unchanged(r, target, entries);
  const requests: string[] = [];
  const retention = r.deps.retention;
  r.deps.retention = async request => { if (request.resultCommit) requests.push(request.resultCommit); return retention(request); };
  const outcome = await finish(r.deps, options(r));
  assert.equal(outcome.reason, "finished", JSON.stringify(outcome));
  assert.deepEqual(outcome.observed.steps, plan.observed.steps);
  const rebased = r.f.run(["rev-parse", r.branch]);
  assert.notEqual(rebased, r.original);
  assert.equal(r.f.run(["rev-parse", `${rebased}^`]), target);
  assert.equal(r.f.run(["rev-parse", "main"]), rebased);
  assert.equal(r.f.run(["show", "-s", "--format=%s", rebased]), "Synthetic worker output");
  const scope = { commit: rebased, rebasedFrom: r.original, onto: target };
  const confirmation = record(r).confirmations!.find(c => c.fact === "output_accepted")!;
  assert.deepEqual(confirmation.scope, scope);
  assert.equal(confirmation.confirmedBy, callerName(testCaller));
  assert.deepEqual(record(r).entries.find(e => e.kind === "output_accepted")!.data, scope);
  assert.deepEqual(kinds(r).slice(entries.length), ["rebase_started", "output_rebased", "output_accepted", "integration_started", "integrated", "task_recorded"]);
  assert.ok(requests.length >= 2);
  assert.ok(requests.every(commit => commit === rebased));
  assert.equal((await r.f.tasks.read("rebase-a1"))!.state, "done");
  assert.equal((await r.deps.workspaces.leases()).length, 1);
  assert.equal((await finish(r.deps, { leaseId: r.leaseId, noProcesses: true })).reason, "finished");
  assert.equal((await r.deps.workspaces.leases()).length, 0);
  assert.equal(kinds(r).filter(kind => kind === "output_accepted").length, 1);
});

test("rebase can finish and return the lease in one run using the rebased commit throughout", async t => {
  const r = await output(t);
  const target = moveMain(r);
  const plan = await finish(r.deps, { ...options(r), noProcesses: true, dryRun: true });
  assert.equal(plan.reason, "planned", JSON.stringify(plan));
  const outcome = await finish(r.deps, { ...options(r), noProcesses: true });
  assert.equal(outcome.reason, "finished", JSON.stringify(outcome));
  assert.deepEqual(outcome.observed.steps, plan.observed.steps);
  assert.equal(outcome.lease, "none");
  const commit = r.f.run(["rev-parse", "main"]);
  assert.notEqual(commit, r.original);
  assert.equal(r.f.run(["rev-parse", `${commit}^`]), target);
  assert.equal(outcome.acceptanceEvidence!.commit, commit);
  assert.equal(record(r).entries.find(e => e.kind === "integrated")!.data.commit, commit);
  assert.equal(record(r).entries.at(-1)!.data.status, "deleted");
  assert.equal((await r.deps.workspaces.leases()).length, 0);
});

test("a conflicting rebase is aborted without moving either branch or leaving workspace changes", async t => {
  const r = await output(t);
  const target = moveMain(r, "worker-output.txt", "conflict on main\n");
  const outcome = await finish(r.deps, options(r));
  assert.equal(outcome.reason, "refused", JSON.stringify(outcome));
  assert.match(outcome.detail!, /stopped, so the branch is unchanged.*does not resolve conflicts/);
  unchanged(r, target);
  assert.equal(r.f.run(["status", "--porcelain=v1", "--untracked-files=all"], r.workspace), "");
  assert.equal(readFileSync(join(r.workspace, "worker-output.txt"), "utf8"), `synthetic worker output on ${r.branch}\n`);
  assert.deepEqual(kinds(r).slice(-2), ["rebase_started", "rebase_aborted"]);
  assert.equal(record(r).confirmations!.length, 0);
});

for (const [name, change] of [
  ["an untracked file", (r: Output) => writeFileSync(join(r.workspace, "scratch.txt"), "notes\n")],
  ["an uncommitted change", (r: Output) => writeFileSync(join(r.workspace, "worker-output.txt"), "edited\n")],
  ["a staged change", (r: Output) => { writeFileSync(join(r.workspace, "tracked.txt"), "edited\n"); r.f.run(["add", "tracked.txt"], r.workspace); }],
] as const) test(`rebase refuses a workspace with ${name} without changing it`, async t => {
  const r = await output(t);
  const target = moveMain(r);
  change(r);
  const entries = kinds(r);
  const before = r.f.run(["status", "--porcelain=v1", "--untracked-files=all"], r.workspace);
  for (const dryRun of [true, false]) {
    const outcome = await finish(r.deps, { ...options(r), dryRun });
    assert.equal(outcome.reason, "refused", JSON.stringify(outcome));
    assert.match(outcome.detail!, /uncommitted or untracked/);
    unchanged(r, target, entries);
    assert.equal(r.f.run(["status", "--porcelain=v1", "--untracked-files=all"], r.workspace), before);
  }
});

test("a commit that becomes empty stops the rebase rather than silently dropping the attempt's work", async t => {
  const r = await output(t);
  const content = readFileSync(join(r.workspace, "worker-output.txt"), "utf8");
  const target = moveMain(r, "worker-output.txt", content);
  const outcome = await finish(r.deps, options(r));
  assert.equal(outcome.reason, "refused", JSON.stringify(outcome));
  assert.match(outcome.detail!, /rebase.*stopped/);
  unchanged(r, target);
  assert.equal(record(r).confirmations!.length, 0);
});

test("rebase refuses commits beyond the exact result commit", async t => {
  const r = await output(t);
  const target = moveMain(r);
  r.f.run(["commit", "--allow-empty", "--no-gpg-sign", "-qm", "Later commit"], r.workspace);
  const head = r.f.run(["rev-parse", r.branch]);
  const entries = kinds(r);
  const outcome = await finish(r.deps, options(r));
  assert.equal(outcome.reason, "refused", JSON.stringify(outcome));
  assert.match(outcome.detail!, /commits other than the attempt's own/);
  assert.equal(r.f.run(["rev-parse", r.branch]), head);
  assert.equal(r.f.run(["rev-parse", "main"]), target);
  assert.deepEqual(kinds(r), entries);
});

test("rebase refuses a merge commit in explicitly accepted output", async t => {
  const r = await output(t, true);
  const start = record(r).allocation!.startingCommit;
  r.f.run(["switch", "-q", "-c", "side", start], r.workspace);
  writeFileSync(join(r.workspace, "side.txt"), "side\n");
  r.f.run(["add", "side.txt"], r.workspace);
  r.f.run(["commit", "-q", "--no-gpg-sign", "-m", "Side"], r.workspace);
  r.f.run(["switch", "-q", r.branch], r.workspace);
  r.f.run(["merge", "-q", "--no-gpg-sign", "--no-ff", "-m", "Merge side", "side"], r.workspace);
  const head = r.f.run(["rev-parse", r.branch]);
  const target = moveMain(r);
  const entries = kinds(r);
  const outcome = await finish(r.deps, { ...options(r), acceptOutput: true });
  assert.equal(outcome.reason, "refused", JSON.stringify(outcome));
  assert.match(outcome.detail!, /merge commits/);
  assert.equal(r.f.run(["rev-parse", r.branch]), head);
  assert.equal(r.f.run(["rev-parse", "main"]), target);
  assert.deepEqual(kinds(r), entries);
});

test("rebase accepts clean committed output after a worker failure without needing a result", async t => {
  const r = await output(t, true);
  const target = moveMain(r);
  const outcome = await finish(r.deps, { ...options(r), acceptOutput: true });
  assert.equal(outcome.reason, "finished", JSON.stringify(outcome));
  const rebased = r.f.run(["rev-parse", "main"]);
  assert.equal(r.f.run(["rev-parse", `${rebased}^`]), target);
  assert.deepEqual(record(r).confirmations!.find(c => c.fact === "output_accepted")!.scope, { commit: rebased, rebasedFrom: r.original, onto: target });
});

test("when the target moves before the fast-forward, the next rebase replays only the attempt's commits", async t => {
  const r = await output(t);
  const first = moveMain(r);
  let second: string | undefined;
  const attempts = attemptsWith(r.f, { appendConfirmed: async (...args) => {
    await r.f.deps.attempts.appendConfirmed(...args);
    if (args[1] === "output_accepted" && !second) second = moveMain(r, "again.txt");
  } });
  const stopped = await finish({ ...r.deps, attempts }, options(r));
  assert.equal(stopped.reason, "stopped", JSON.stringify(stopped));
  assert.match(stopped.detail!, /moved after integration was planned/);
  const once = r.f.run(["rev-parse", r.branch]);
  assert.equal(r.f.run(["rev-parse", `${once}^`]), first);
  assert.equal(r.f.run(["rev-parse", "main"]), second);
  const outcome = await finish(r.deps, options(r));
  assert.equal(outcome.reason, "finished", JSON.stringify(outcome));
  const twice = r.f.run(["rev-parse", "main"]);
  assert.equal(r.f.run(["rev-parse", `${twice}^`]), second);
  assert.equal(r.f.run(["rev-list", "--count", `${second}..${twice}`]), "1");
  assert.deepEqual(record(r).confirmations!.filter(c => c.fact === "output_accepted").map(c => c.scope), [
    { commit: once, rebasedFrom: r.original, onto: first }, { commit: twice, rebasedFrom: once, onto: second },
  ]);
});

test("a recorded detached candidate is recovered by the next finish without rebasing again", async t => {
  const r = await output(t);
  const target = moveMain(r);
  const attempts = attemptsWith(r.f, { append: async (...args) => {
    await r.f.deps.attempts.append(...args);
    if (args[1] === "output_rebased") throw new Error("Interrupted after recording the candidate");
  } });
  assert.equal((await finish({ ...r.deps, attempts }, options(r))).reason, "stopped");
  const candidate = record(r).entries.find(e => e.kind === "output_rebased")!.data.commit as string;
  assert.equal(r.f.run(["rev-parse", r.branch]), r.original);
  const plan = await finish(r.deps, { leaseId: r.leaseId, noProcesses: false, dryRun: true });
  assert.match(plan.detail!, new RegExp(`Would move ${r.branch} from ${r.original} to the rebased commit ${candidate}`));
  assert.equal(r.f.run(["rev-parse", r.branch]), r.original);
  const outcome = await finish(r.deps, { leaseId: r.leaseId, noProcesses: false });
  assert.equal(outcome.reason, "finished", JSON.stringify(outcome));
  assert.deepEqual(outcome.observed.steps, plan.observed.steps);
  assert.equal(r.f.run(["rev-parse", "main"]), candidate);
  assert.equal(r.f.run(["rev-parse", `${candidate}^`]), target);
  assert.equal(kinds(r).filter(kind => kind === "rebase_started").length, 1);
});

test("the same --accept-output --rebase command recovers a candidate and rebases again if the target moved", async t => {
  const r = await output(t, true);
  moveMain(r);
  const attempts = attemptsWith(r.f, { append: async (...args) => {
    await r.f.deps.attempts.append(...args);
    if (args[1] === "output_rebased") throw new Error("Interrupted after recording the candidate");
  } });
  const command = { ...options(r), acceptOutput: true };
  assert.equal((await finish({ ...r.deps, attempts }, command)).reason, "stopped");
  const candidate = record(r).entries.find(e => e.kind === "output_rebased")!.data.commit as string;
  const target = moveMain(r, "again.txt");
  const plan = await finish(r.deps, { ...command, dryRun: true });
  assert.equal(plan.reason, "planned", JSON.stringify(plan));
  assert.match(plan.detail!, /Would move .*completing an earlier rebase, then rebase/);
  assert.equal(r.f.run(["rev-parse", r.branch]), r.original);
  const outcome = await finish(r.deps, command);
  assert.equal(outcome.reason, "finished", JSON.stringify(outcome));
  assert.deepEqual(outcome.observed.steps, plan.observed.steps);
  const commit = r.f.run(["rev-parse", "main"]);
  assert.equal(r.f.run(["rev-parse", `${commit}^`]), target);
  assert.equal(r.f.run(["rev-list", "--count", `${target}..${commit}`]), "1");
  assert.deepEqual(record(r).confirmations!.find(c => c.fact === "output_accepted")!.scope, { commit, rebasedFrom: candidate, onto: target });
});

test("--rebase finishes normally when the target has not moved, and refuses under manual", async t => {
  const r = await output(t);
  const manual = await finish(r.f.deps, options(r));
  assert.equal(manual.reason, "refused");
  assert.equal(manual.nextAction.code, "fix_configuration");
  assert.equal((await finish(r.deps, options(r))).reason, "finished");
  assert.equal(r.f.run(["rev-parse", "main"]), r.original);
  assert.equal(kinds(r).includes("output_accepted"), false);
});

test("the CLI accepts --rebase and uses the person's existing approval", async t => {
  const r = await output(t);
  const target = moveMain(r);
  const config = JSON.parse(readFileSync(r.f.config, "utf8"));
  writeFileSync(r.f.config, JSON.stringify({ ...config, finalisation: { kind: "local-merge" } }));
  const cli = spawnSync(process.execPath, [resolve("src/cli.ts"), "finish", "--lease", r.leaseId, "--rebase", "--json", "--config", r.f.config], {
    // Rebasing writes commits, so the command needs the fixture's Git identity, not the host's.
    encoding: "utf8", env: { ...process.env, ...r.f.environment, USER: "not-the-caller", USERNAME: "not-the-caller" },
  });
  const outcome = JSON.parse(cli.stdout);
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  assert.equal(outcome.reason, "finished");
  const commit = r.f.run(["rev-parse", "main"]);
  const confirmation = record(r).confirmations!.find(c => c.fact === "output_accepted")!;
  assert.equal(confirmation.confirmedBy, `operator:${userInfo().username}`);
  assert.deepEqual(confirmation.scope, { commit, rebasedFrom: r.original, onto: target });
});

for (const command of ["symbolic-ref", "status", "rev-list"]) test(`a failed ${command} owner read before rebase can be retried`, { skip: process.platform === "win32" }, async t => {
  const r = await output(t);
  const target = moveMain(r);
  const marker = join(r.f.dir, "failed");
  const shim = join(r.f.dir, "git-read-failure");
  writeFileSync(shim, `#!/bin/sh\nif [ "$1" = '${command}' ] && [ ! -f '${marker}' ]; then touch '${marker}'; echo 'partial read'; echo 'read failed' >&2; exit 23; fi\nexec '${onPath("git")}' "$@"\n`, { mode: 0o755 });
  r.deps.policy.git = shim;
  const first = await finish(r.deps, options(r));
  assert.equal(first.reason, "owner_read_retryable", JSON.stringify(first));
  assert.equal(first.nextAction.code, "retry_owner_read");
  unchanged(r, target);
  const failure = record(r).entries.find(e => e.kind === "owner_read_failed")!.data;
  assert.equal(failure.owner, "Git");
  assert.equal(failure.classification, "owner_read");
  assert.match(JSON.stringify(failure), /partial read/);
  assert.match(JSON.stringify(failure), /read failed/);
  assert.equal((await finish(r.deps, options(r))).reason, "finished");
  assert.equal(kinds(r).filter(kind => kind === "rebase_started").length, 1);
});

test("a failed owner read after rebase requires reconciliation and never repeats the uncertain effect", { skip: process.platform === "win32" }, async t => {
  const r = await output(t);
  const target = moveMain(r);
  const shim = join(r.f.dir, "git-after-rebase-failure");
  const marker = join(r.f.dir, "failed");
  writeFileSync(shim, `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = list ] && [ ! -f '${marker}' ]; then touch '${marker}'; echo 'inventory failed after rebase' >&2; exit 23; fi\nexec '${onPath("git")}' "$@"\n`, { mode: 0o755 });
  r.deps.policy.git = shim;
  const first = await finish(r.deps, options(r));
  assert.equal(first.reason, "reconciliation_required", JSON.stringify(first));
  const candidate = record(r).entries.find(e => e.kind === "output_rebased")!.data.commit as string;
  assert.equal(r.f.run(["rev-parse", r.branch]), r.original);
  assert.equal(r.f.run(["rev-parse", "main"]), target);
  const failure = record(r).entries.find(e => e.kind === "owner_read_failed")!;
  assert.equal(failure.data.classification, "effect_uncertain");
  assert.equal((await finish(r.deps, options(r))).reason, "reconciliation_required");
  assert.equal(kinds(r).filter(kind => kind === "rebase_started").length, 1);
  const resolved = await resolveReadFailure(r.deps, { leaseId: r.leaseId, failureSequence: failure.sequence, outcome: "happened", note: "The detached candidate is recorded; the output branch still has its original head" });
  assert.equal(resolved.reason, "resolved", JSON.stringify(resolved));
  const outcome = await finish(r.deps, { leaseId: r.leaseId, noProcesses: false });
  assert.equal(outcome.reason, "finished", JSON.stringify(outcome));
  assert.equal(r.f.run(["rev-parse", "main"]), candidate);
  assert.equal(kinds(r).filter(kind => kind === "rebase_started").length, 1);
});

async function supervised(r: Output) {
  const objectives = new ObjectiveStore(r.f.tasks.database, testCaller);
  await objectives.add({ id: "goal", request: "Do the work", acceptanceCriteria: ["Keep the output"] });
  await r.f.tasks.update("rebase-a1", { objectiveId: "goal" });
  const caller: Caller = { kind: "supervisor", objectiveId: "goal" };
  const checks = [{ name: "tests", command: [process.execPath, "-e", "process.exit(0)"] as [string, ...string[]], timeoutMs: 5000 }];
  const deps = { ...r.deps, caller, checks, checkEnvironment: r.f.environment,
    attempts: new AttemptStore(r.f.tasks.database, r.f.deps.contextId, caller, checks) };
  return { deps, objectives };
}

async function reviewOutput(r: Output, deps: Dependencies, verdict: "passed" | "failed", commit: string) {
  const review = await createReview(deps, { taskId: "rebase-a1" });
  assert.equal(review.reason, "review_created", JSON.stringify(review));
  assert.equal((review.observed.reviewTarget as { commit: string }).commit, commit);
  const worker = new PiWorker(r.f.runtime, { executable: process.execPath, entrypoint: resolve("tests/fixtures/pi-rpc.ts"), provider: "fixture", model: "fixture", shellTool: "bash", requestMs: 2000, runMs: 5000, stopMs: 600,
    environment: { ...r.f.environment, FAKE_PI_SCENARIO: verdict === "passed" ? "review-pass" : "review-fail", FAKE_PI_LOG: join(r.f.dir, `review-${verdict}.jsonl`) } });
  deps.launch = (input, signal, onRequest) => worker.execute(input, signal, onRequest ? { onRequest } : {});
  const reviewed = await dispatchOnce(deps, { taskId: review.task!.id });
  assert.equal(reviewed.reason, "held", JSON.stringify(reviewed));
  const findings = record(r).entries.filter(e => e.kind === "review_recorded");
  assert.equal(findings.at(-1)!.data.commit, commit);
  assert.equal(findings.at(-1)!.data.verdict, verdict);
}

test("a supervisor needs the objective's rebase permission, including on dry runs", async t => {
  const r = await output(t);
  const target = moveMain(r);
  const { deps, objectives } = await supervised(r);
  await objectives.update("goal", { permissions: { ...defaultPermissions, rebase: false } });
  const entries = kinds(r);
  for (const dryRun of [true, false]) {
    const outcome = await finish(deps, { ...options(r), dryRun });
    assert.equal(outcome.reason, "refused");
    assert.match(outcome.detail!, /permission_denied.*rebase/);
    unchanged(r, target, entries);
  }
});

test("supervisor rebase records a candidate, but needs fresh passing checks and review before scoped acceptance", async t => {
  const r = await output(t);
  const target = moveMain(r);
  const { deps } = await supervised(r);
  const originalCheck = await finish({ ...deps, policy: { ...deps.policy, context: { kind: "manual" } } }, { leaseId: r.leaseId, noProcesses: false });
  assert.equal(originalCheck.checks![0]!.status, "passed");
  assert.equal(originalCheck.checks![0]!.commit, r.original);
  await reviewOutput(r, deps, "passed", r.original);
  deps.checks[0]!.command = [process.execPath, "-e", "process.exit(7)"];
  const plan = await finish(deps, { ...options(r), dryRun: true });
  assert.equal(plan.reason, "planned", JSON.stringify(plan));
  unchanged(r, target);
  const failed = await finish(deps, options(r));
  assert.equal(failed.reason, "refused", JSON.stringify(failed));
  assert.match(failed.detail!, /has not passed/);
  const candidate = r.f.run(["rev-parse", r.branch]);
  assert.notEqual(candidate, r.original);
  assert.equal(failed.acceptanceEvidence!.commit, candidate);
  assert.equal(failed.checks![0]!.commit, candidate);
  assert.equal(record(r).confirmations!.length, 0);
  assert.equal(r.f.run(["rev-parse", "main"]), target);
  assert.equal(deps.attempts.startingPointCommit(record(r)), candidate);
  assert.equal((await status(deps)).attempts[0]!.outputCommit, candidate);
  const scope = { commit: candidate, rebasedFrom: r.original, onto: target };
  await assert.rejects(deps.attempts.appendConfirmed(record(r), "output_accepted", scope, { fact: "output_accepted", scope }), /check_not_passed/);
  deps.checks[0]!.command = [process.execPath, "-e", "process.exit(0)"];
  const missing = await finish(deps, { leaseId: r.leaseId, noProcesses: false });
  assert.equal(missing.reason, "refused", JSON.stringify(missing));
  assert.match(missing.detail!, /no recorded review/);
  await assert.rejects(deps.attempts.appendConfirmed(record(r), "output_accepted", scope, { fact: "output_accepted", scope }), /review_missing/);
  for (const verdict of ["failed", "passed"] as const) {
    await reviewOutput(r, deps, verdict, candidate);
    if (verdict === "failed") {
      const denied = await finish(deps, { leaseId: r.leaseId, noProcesses: false });
      assert.equal(denied.reason, "refused", JSON.stringify(denied));
      assert.match(denied.detail!, /latest review failed/);
    }
  }
  const accepted = await finish(deps, { leaseId: r.leaseId, noProcesses: false });
  assert.equal(accepted.reason, "finished", JSON.stringify(accepted));
  assert.deepEqual(accepted.acceptanceEvidence, { commit: candidate, permission: { allowed: true } });
  assert.equal(r.f.run(["rev-parse", "main"]), candidate);
  assert.deepEqual(record(r).confirmations!.find(c => c.fact === "output_accepted")!.scope, scope);
  assert.equal(record(r).confirmations!.find(c => c.fact === "output_accepted")!.confirmedBy, "supervisor:goal");
});
