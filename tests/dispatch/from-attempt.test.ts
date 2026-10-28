import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { discard, finish } from "../../src/dispatch/finish.ts";
import { resolveStopped } from "../../src/dispatch/resolve.ts";
import { prune } from "../../src/dispatch/prune.ts";
import { reserveFromAttempt } from "../../src/dispatch/reserve.ts";
import { describe } from "../../src/dispatch/result.ts";
import { onPath } from "../../src/infra/executables.ts";
import { startingPointBranch } from "../../src/workspaces/starting-point.ts";
import { WorkspaceError } from "../../src/workspaces/provider.ts";
import { describeStatus, status } from "../../src/dispatch/status.ts";
import { watch } from "../../src/dispatch/watch.ts";
import { PiWorker } from "../../src/runtime/pi/worker.ts";
import { fixture, task } from "./fixture.ts";

const taskId = "continue-a1";
const options = { taskId, startingPoint: { taskId, attempt: 1 }, requestId: "new-request" };
const cli = resolve(import.meta.dirname, "../../src/cli.ts");
const crash = resolve(import.meta.dirname, "../fixtures/crash-dispatch.ts");

async function completed() {
  const f = await fixture({ tasks: [task(taskId)], scenario: "commit-result" });
  await f.tasks.update(taskId, { acceptanceCriteria: ["Keep the earlier work", "Add the remaining change"] });
  const first = await dispatchOnce(f.deps, { taskId, requestId: "original" });
  assert.equal(first.retention?.retained, true);
  await f.tasks.release(taskId);
  return { ...f, first };
}

function sourceRows(f: Awaited<ReturnType<typeof completed>>) {
  const ref = f.deps.attempts.findForTask(taskId, 1)!;
  return {
    record: ref,
    branch: f.run(["rev-parse", ref.allocation!.outputBranch]),
    lease: ref.allocation!.leaseId,
    launches: f.tasks.database.all("SELECT * FROM launches WHERE attempt = 1"),
    observations: f.tasks.database.all("SELECT * FROM worker_observations"),
  };
}

test("dispatch starts at the exact recorded output, stores and shows an immutable handover, and leaves its source alone", async () => {
  const f = await completed();
  try {
    const source = f.deps.attempts.findForTask(taskId, 1)!;
    const commit = f.first.attempt!.resultCommit!;
    await f.deps.attempts.append(source, "operator_request", { id: randomUUID(), kind: "steer", sender: "operator", outcome: "delivered", message: "Unrelated log entry" });
    const check = { name: "tests", commit, status: "failed" as const, exitCode: 1, timedOut: false, durationMs: 42, stdout: "Edge case test failed", stderr: "Failure details" };
    await f.deps.attempts.append(source, "check_finished", { ...check, commit: source.allocation!.startingCommit, stdout: "Old check output" });
    await f.deps.attempts.append(source, "check_finished", { ...check, status: "passed", stdout: "Superseded check output" });
    await f.deps.attempts.append(source, "check_finished", check);
    // Neither a later source branch head nor a newer target commit is the requested starting point.
    f.run(["commit", "--allow-empty", "--no-gpg-sign", "-m", "Later source work"], source.allocation!.workspace);
    const laterSource = f.run(["rev-parse", "HEAD"], source.allocation!.workspace);
    f.run(["commit", "--allow-empty", "--no-gpg-sign", "-m", "New target work"]);
    const target = f.run(["rev-parse", "main"]);
    const before = sourceRows(f);
    const launch = f.deps.launch;
    const acquire = f.deps.workspaces.acquire.bind(f.deps.workspaces);
    let acquisitions = 0;
    let launches = 0;
    let instructions = "";
    f.deps.workspaces.acquire = async request => {
      acquisitions++;
      assert.equal(request.startingCommit, f.first.attempt!.resultCommit);
      const reserved = f.deps.attempts.findForTask(taskId, 2)!;
      assert.ok(reserved.specification?.handover?.includes("Finish the edge case, then run checks"));
      assert.equal(reserved.allocation, undefined);
      return acquire(request);
    };
    f.deps.launch = async (input, ...rest) => {
      launches++;
      assert.equal(f.run(["rev-parse", "HEAD"], input.workspace), f.first.attempt!.resultCommit);
      assert.equal(input.delivery.startingCommit, f.first.attempt!.resultCommit);
      assert.notEqual(input.delivery.startingCommit, laterSource);
      assert.notEqual(input.delivery.startingCommit, target);
      assert.notEqual(input.identity.leaseId, source.allocation!.leaseId);
      assert.notEqual(input.identity.sessionId, f.first.attempt!.sessionId);
      assert.notEqual(input.workspace, source.allocation!.workspace);
      instructions = input.instructions;
      return launch(input, ...rest);
    };
    const outcome = await dispatchOnce(f.deps, { ...options, note: "Finish the edge case, then run checks" });
    assert.equal(outcome.retention?.retained, true, JSON.stringify(outcome));
    assert.equal(acquisitions, 1);
    assert.equal(launches, 1);
    const next = f.deps.attempts.findForTask(taskId, 2)!;
    const handover = next.specification!.handover!;
    for (const text of ["Implement the fixture change", "Keep the earlier work", "Add the remaining change", "completed", "Synthetic worker completion", "Synthetic worker output", f.first.attempt!.resultCommit!, "Synthetic fixture evidence", "Edge case test failed", "Finish the edge case, then run checks"]) assert.ok(handover.includes(text), text);
    for (const text of ["Unrelated log entry", "Old review findings", "Old check output", "Superseded check output", '"entries"', "worker_finished", "task_recorded"]) assert.ok(!handover.includes(text), text);
    for (const text of ["Review findings for", "Check results for", "Edge case test failed", "Failure details", '"exitCode": 1']) assert.ok(handover.includes(text), text);
    assert.ok(!handover.includes(laterSource));
    assert.ok(!handover.includes("Later source work"));
    assert.ok(instructions.endsWith(handover));
    assert.equal(next.allocation!.startingCommit, f.first.attempt!.resultCommit);
    assert.equal(next.allocation!.baseRef, "main");
    assert.equal(f.run(["branch", "--list", startingPointBranch(next.specification!.outputBranch!)]), "");
    assert.equal((outcome.observed.startingPointCleanup as { status: string }).status, "removed");
    const after = sourceRows(f);
    assert.deepEqual(after.record, before.record);
    assert.equal(after.branch, before.branch);
    assert.deepEqual(after.launches, before.launches);
    assert.deepEqual(after.observations.filter(row => before.observations.some(old => old.directory === row.directory)), before.observations);
    assert.ok((await f.deps.workspaces.leases()).some(l => l.leaseId === before.lease));
    // Later task edits, source notes and file changes cannot rewrite the stored handover.
    await f.tasks.update(taskId, { body: "Later task instructions" });
    await f.deps.attempts.append(source, "operator_request", { id: randomUUID(), kind: "steer", sender: "operator", outcome: "undelivered", message: "Later operator note" });
    const runtime = (await f.runtime.discover(f.deps.contextId)).find(r => r.binding.input.identity.leaseId === source.allocation!.leaseId)!;
    writeFileSync(runtime.binding.resultPath, "changed after validation");
    const view = await status(f.deps);
    assert.equal(view.attempts.find(a => a.attempt.attempt === 2)!.specification!.handover, handover);
    assert.ok(describeStatus(view).includes(handover));
    const notes: string[] = [];
    await watch(f.deps, { leaseId: next.allocation!.leaseId, follow: false, print: entry => { if (entry.kind === "note") notes.push(entry.text); } });
    assert.ok(notes.includes(handover));
    assert.equal((await dispatchOnce(f.deps, { ...options, note: "Finish the edge case, then run checks" })).reason, "existing_request");
    assert.equal((await dispatchOnce(f.deps, { ...options, note: "Changed request" })).reason, "request_input_mismatch");
    assert.equal(acquisitions, 1);
    assert.equal(launches, 1);
  } finally { f.tasks.close(); }
});

for (const allocated of [false, true]) test(`prune removes an interrupted starting-point ref ${allocated ? "after allocation is recorded" : "once the attempt is closed"}`, async () => {
  const f = await completed();
  try {
    assert.equal((await reserveFromAttempt(f.deps, options)).reason, "reserved");
    const next = f.deps.attempts.findForTask(taskId, 2)!;
    const specification = next.specification!;
    const branch = startingPointBranch(specification.outputBranch!);
    if (allocated) {
      const allocation = await f.deps.workspaces.acquire({ holder: taskId, baseRef: specification.baseRef!, branch: specification.outputBranch!, startingCommit: specification.startingPoint!.commit });
      await f.deps.attempts.append(next, "leased", {
        leaseId: allocation.leaseId, workspace: allocation.path, baseRef: specification.baseRef!, outputBranch: allocation.branch,
        startingCommit: allocation.startingCommit, backingRepository: allocation.backingRepository, pool: allocation.pool,
      });
    } else {
      f.run(["branch", branch, specification.startingPoint!.commit]);
      await prune(f.deps, { olderThan: 1 });
      assert.equal(f.run(["rev-parse", branch]), specification.startingPoint!.commit, "An open acquisition must keep its base");
      await f.deps.attempts.append(next, "halted", { stage: "acquire", reason: "outcome_unknown" });
    }
    const before = f.deps.attempts.findForTask(taskId, 2)!;
    const preview = await prune(f.deps, { olderThan: 1, dryRun: true });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.ok(describe(preview).includes(`Would remove starting-point branch ${branch}`));
    assert.equal(f.run(["rev-parse", branch]), specification.startingPoint!.commit);
    const pruned = await prune(f.deps, { olderThan: 1 });
    assert.equal(pruned.ok, true, JSON.stringify(pruned));
    assert.equal(f.run(["branch", "--list", branch]), "");
    assert.deepEqual(f.deps.attempts.findForTask(taskId, 2), before, "Ref cleanup does not alter attempt records or outcomes");
  } finally { f.tasks.close(); }
});

test("dispatch removes a prepared starting-point ref when acquisition is rejected and the attempt closes without an allocation", async () => {
  const f = await completed();
  try {
    let branch = "";
    f.deps.workspaces.acquire = async request => {
      branch = startingPointBranch(request.branch);
      f.run(["branch", branch, request.startingCommit!]);
      throw new WorkspaceError("rejected", "Fixture acquisition refused");
    };
    const outcome = await dispatchOnce(f.deps, options);
    assert.equal(outcome.reason, "stopped", JSON.stringify(outcome));
    assert.ok(outcome.detail?.includes("Fixture acquisition refused"));
    assert.equal(f.deps.attempts.findForTask(taskId, 2)!.allocation, undefined);
    assert.equal((outcome.observed.startingPointCleanup as { status: string }).status, "removed");
    assert.equal(f.run(["branch", "--list", branch]), "");
    assert.equal((await f.deps.workspaces.leases()).length, 1);
  } finally { f.tasks.close(); }
});

for (const moved of [false, true]) test(`starting-point cleanup ${moved ? "leaves a moved branch" : "failure does not affect dispatch"} and prune reports it`, async () => {
  const f = await completed();
  let lock: string | undefined;
  try {
    const acquire = f.deps.workspaces.acquire.bind(f.deps.workspaces);
    let branch = "";
    const other = f.run(["rev-parse", "main"]);
    f.deps.workspaces.acquire = async request => {
      const allocation = await acquire(request);
      branch = startingPointBranch(request.branch);
      if (moved) f.run(["update-ref", `refs/heads/${branch}`, other]);
      else {
        lock = join(f.deps.repository, ".git", "refs", "heads", `${branch}.lock`);
        writeFileSync(lock, "fixture lock");
      }
      return allocation;
    };
    const outcome = await dispatchOnce(f.deps, options);
    assert.equal(outcome.reason, "held", JSON.stringify(outcome));
    assert.equal(outcome.retention?.retained, true);
    assert.equal(f.deps.attempts.findForTask(taskId, 2)!.entries.at(-1)!.data.category, "review_required");
    const cleanup = outcome.observed.startingPointCleanup as { status: string; detail: string };
    assert.equal(cleanup.status, "preserved");
    assert.ok(describe(outcome).includes(cleanup.detail));
    assert.ok(cleanup.detail.includes(moved ? "no longer points" : "Could not remove"), cleanup.detail);
    assert.equal(f.run(["rev-parse", branch]), moved ? other : f.first.attempt!.resultCommit);
    const pruned = await prune(f.deps, { olderThan: 1 });
    assert.equal(pruned.ok, true, JSON.stringify(pruned));
    assert.ok((pruned.observed.startingPointCleanup as { status: string }[]).some(c => c.status === "preserved"));
    assert.ok(describe(pruned).includes(moved ? "no longer points" : "Could not remove"));
    assert.equal(f.run(["rev-parse", branch]), moved ? other : f.first.attempt!.resultCommit);
    if (lock) {
      rmSync(lock);
      lock = undefined;
      await prune(f.deps, { olderThan: 1 });
      assert.equal(f.run(["branch", "--list", branch]), "");
    }
  } finally {
    if (lock) rmSync(lock, { force: true });
    f.tasks.close();
  }
});

test("handover uses the configured Git executable and host environment, not the process PATH or environment", async () => {
  const f = await completed();
  const path = process.env.PATH;
  const count = process.env.GIT_CONFIG_COUNT;
  try {
    f.deps.policy = { git: onPath("git"), environment: f.environment, repository: f.deps.repository, baseRef: "main", globalFile: join(f.dir, "missing-policy.json"), context: {} };
    process.env.PATH = "";
    process.env.GIT_CONFIG_COUNT = "not a number";
    const reserved = await reserveFromAttempt(f.deps, options);
    assert.equal(reserved.reason, "reserved", JSON.stringify(reserved));
    const written = f.deps.attempts.findForTask(taskId, 2)!.specification!.handover!;
    assert.ok(written.includes(f.first.attempt!.resultCommit!));
    assert.ok(written.includes("Synthetic worker output"));
  } finally {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
    if (count === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = count;
    f.tasks.close();
  }
});

test("an allocation at the wrong commit is preserved for inspection and never launched", async () => {
  const f = await completed();
  try {
    const acquire = f.deps.workspaces.acquire.bind(f.deps.workspaces);
    f.deps.workspaces.acquire = request => acquire({ holder: request.holder, baseRef: request.baseRef, branch: request.branch });
    f.deps.launch = async () => { assert.fail("Must not launch from the wrong commit"); };
    const outcome = await dispatchOnce(f.deps, options);
    assert.equal(outcome.reason, "stopped");
    assert.equal(outcome.lease, "preserved");
    assert.ok(outcome.detail?.includes("does not start at the recorded earlier output commit"));
    const next = f.deps.attempts.findForTask(taskId, 2)!;
    assert.notEqual(next.allocation!.startingCommit, next.specification!.startingPoint!.commit);
    assert.equal((await dispatchOnce(f.deps, options)).reason, "existing_request");
    assert.equal((await f.deps.workspaces.leases()).length, 2);
  } finally { f.tasks.close(); }
});

test("inheriting the earlier commit without adding any commit is not retained", async () => {
  const f = await completed();
  try {
    const worker = new PiWorker(f.runtime, { executable: process.execPath, entrypoint: resolve(import.meta.dirname, "../fixtures/pi-rpc.ts"), provider: "fixture", model: "fixture", shellTool: "bash", requestMs: 2000, runMs: 5000, stopMs: 600,
      environment: { ...f.environment, FAKE_PI_SCENARIO: "no-new-commit", FAKE_PI_LOG: join(f.dir, "second-worker.jsonl") } });
    f.deps.launch = (input, signal, onRequest) => worker.execute(input, signal, onRequest ? { onRequest } : {});
    const outcome = await dispatchOnce(f.deps, options);
    assert.equal(outcome.reason, "held");
    assert.equal(outcome.retention?.retained, false);
    assert.ok(outcome.retention?.findings.some(f => f.includes("no commits beyond its starting commit")));
    assert.equal(f.deps.attempts.findForTask(taskId, 2)!.entries.at(-1)!.data.category, "not_retained");
    const finishing = await finish(f.deps, { leaseId: outcome.attempt!.leaseId!, noProcesses: false, dryRun: false });
    assert.equal(finishing.ok, false);
  } finally { f.tasks.close(); }
});

for (const kind of ["not retained", "unknown", "wrong task", "missing attempt", "worker running", "attempt limit", "held", "done"] as const) test(`dispatch passes through reservation refusal: ${kind}`, async () => {
  const f = await completed();
  try {
    let request = options;
    const expected = { "not retained": "not_retained", unknown: "starting_point_unknown", "wrong task": "starting_point_wrong_task", "missing attempt": "starting_point_unknown", "worker running": "possibly_running", "attempt limit": "attempt_limit", held: "not_ready", done: "not_ready" }[kind];
    if (kind === "not retained") f.run(["update-ref", "-d", `refs/heads/${f.first.attempt!.outputBranch}`]);
    if (kind === "unknown") f.deps.workspaces.leases = async () => { throw new Error("Treehouse unavailable"); };
    if (kind === "wrong task") request = { ...options, startingPoint: { taskId: "other", attempt: 1 } };
    if (kind === "missing attempt") request = { ...options, startingPoint: { taskId, attempt: 99 } };
    if (kind === "worker running") await f.tasks.database.transaction(() => f.tasks.database.run("DELETE FROM worker_observations WHERE kind = 'exit'"));
    if (kind === "attempt limit") f.deps.maxAttemptsPerTask = 1;
    if (kind === "held") await f.tasks.hold(taskId, "Review first");
    if (kind === "done") await f.tasks.done(taskId);
    f.deps.workspaces.acquire = async () => { assert.fail("Must not acquire"); };
    f.deps.launch = async () => { assert.fail("Must not launch"); };
    const before = f.deps.attempts.list();
    const refused = await dispatchOnce(f.deps, request);
    assert.equal(refused.observed.reason, expected, JSON.stringify(refused));
    assert.deepEqual(f.deps.attempts.list(), before);
    assert.equal(await f.deps.attempts.findByRequest(options.requestId), undefined);
  } finally { f.tasks.close(); }
});

for (const stage of ["after-reservation", "after-lease", "after-launch"]) test(`a continuation crash ${stage} never repeats acquisition or launch`, async () => {
  const f = await completed();
  try {
    const source = f.deps.attempts.findForTask(taskId, 1)!;
    if (stage === "after-launch") {
      const config = JSON.parse(readFileSync(f.config, "utf8"));
      config.worker.environment.FAKE_PI_SCENARIO = "delay-exit";
      // Do not let the earlier worker's prompt satisfy the crash hook.
      config.worker.environment.FAKE_PI_LOG = join(f.dir, "crashed-worker.jsonl");
      writeFileSync(f.config, JSON.stringify(config));
    }
    const killed = spawnSync(process.execPath, [crash, f.config, stage, taskId, "1"], { env: { ...process.env, ...f.environment }, encoding: "utf8" });
    if (process.platform === "win32") assert.deepEqual([killed.status, killed.signal, killed.stderr], [1, null, ""]);
    else assert.equal(killed.signal, "SIGKILL", killed.stderr);
    if (stage === "after-launch") await sleep(500);
    const next = f.deps.attempts.findForTask(taskId, 2)!;
    assert.ok(next.specification!.handover);
    const leases = await f.deps.workspaces.leases();
    assert.equal(leases.length, stage === "after-reservation" ? 1 : 2);
    const launches = f.tasks.database.all("SELECT * FROM launches");
    assert.equal(launches.length, stage === "after-launch" ? 2 : 1);
    f.deps.workspaces.acquire = async () => { assert.fail("Must not acquire again"); };
    f.deps.launch = async () => { assert.fail("Must not launch again"); };
    const replay = await dispatchOnce(f.deps, { ...options, requestId: `crash-${stage}` });
    assert.equal(replay.reason, "existing_request");
    assert.equal(replay.attempt!.attempt, 2);
    assert.equal(replay.lease, stage === "after-reservation" ? "none" : "preserved");
    assert.equal((await dispatchOnce(f.deps, { ...options, requestId: "another-request" })).ok, false);
    assert.deepEqual(await f.deps.workspaces.leases(), leases);
    assert.deepEqual(f.tasks.database.all("SELECT * FROM launches"), launches);
    assert.deepEqual(f.deps.attempts.read(source), source);
  } finally { f.tasks.close(); }
});

for (const mode of ["note", "note-file"]) test(`CLI --from-attempt accepts --${mode} and dry-run makes no reservation`, async () => {
  const f = await completed();
  try {
    const note = "Check the remaining edge case\nKeep the earlier output";
    const file = join(f.dir, "handover-note.txt");
    writeFileSync(file, note);
    const args = ["dispatch", "--once", "--task", taskId, "--from-attempt", "1", `--${mode}`, mode === "note" ? note : file, "--request-id", "cli-request", "--json", "--config", f.config];
    const run = (extra: string[] = []) => spawnSync(process.execPath, [cli, ...args, ...extra], { env: { ...process.env, ...f.environment }, encoding: "utf8" });
    const preview = run(["--dry-run"]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).reason, "dry_run");
    assert.equal((await f.deps.attempts.forTask(taskId)).length, 1);
    assert.equal((await f.deps.workspaces.leases()).length, 1);
    const dispatched = run();
    const outcome = JSON.parse(dispatched.stdout);
    assert.equal(outcome.reason, "held", dispatched.stdout + dispatched.stderr);
    assert.equal(outcome.retention.retained, true);
    assert.ok(f.deps.attempts.findForTask(taskId, 2)!.specification!.handover!.includes(note));
  } finally { f.tasks.close(); }
});

test("CLI rejects invalid starting-point and note options before opening any owners", () => {
  const invalid = [
    ["--from-attempt", "1"],
    ...["0", "-1", "1.5", "bad", "9007199254740992"].map(n => ["--task", taskId, "--from-attempt", n]),
    ["--task", taskId, "--note", "Needs a source"],
    ["--task", taskId, "--note-file", "missing-file"],
    ["--task", taskId, "--from-attempt", "1", "--note", "Both", "--note-file", "missing-file"],
  ];
  for (const args of invalid) {
    const run = spawnSync(process.execPath, [cli, "dispatch", "--once", ...args, "--config", "missing-config"], { encoding: "utf8" });
    assert.equal(run.status, 2, JSON.stringify(args));
    assert.ok(run.stderr.includes("--from-attempt"), run.stderr);
    assert.ok(!run.stderr.includes("Configuration error"), run.stderr);
  }
  const unreadable = spawnSync(process.execPath, [cli, "dispatch", "--once", "--task", taskId, "--from-attempt", "1", "--note-file", "missing-file", "--config", "missing-config"], { encoding: "utf8" });
  assert.equal(unreadable.status, 2);
  assert.ok(unreadable.stderr.startsWith("Could not read --note-file:"));
});

test("the earlier attempt can still be finished, discarded or resolved without changing the new branch or records", async () => {
  for (const action of ["finish", "discard", "resolve"]) {
    const f = await completed();
    try {
      const next = await dispatchOnce(f.deps, options);
      const record = f.deps.attempts.findForTask(taskId, 2)!;
      const head = f.run(["rev-parse", record.allocation!.outputBranch]);
      const leaseId = f.first.attempt!.leaseId!;
      if (action === "resolve") {
        const runtime = (await f.runtime.discover(f.deps.contextId)).find(r => r.binding.input.identity.leaseId === leaseId)!;
        // Lose only the earlier exit observation; its already-exited synthetic worker can be confirmed separately.
        await f.tasks.database.transaction(() => f.tasks.database.run("DELETE FROM worker_observations WHERE directory = ? AND kind = 'exit'", runtime.directory));
      }
      const outcome = action === "finish"
        ? await finish(f.deps, { leaseId, acceptOutput: true, noProcesses: true, dryRun: false })
        : action === "discard" ? await discard(f.deps, { leaseId, confirm: true, noProcesses: true, dryRun: false })
        : await resolveStopped(f.deps, { leaseId, confirmed: true, note: "Earlier worker stopped separately" });
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      assert.equal(f.run(["rev-parse", record.allocation!.outputBranch]), head);
      assert.deepEqual(f.deps.attempts.read(record), record);
      assert.ok((await f.deps.workspaces.leases()).some(l => l.leaseId === next.attempt!.leaseId));
    } finally { f.tasks.close(); }
  }
});
