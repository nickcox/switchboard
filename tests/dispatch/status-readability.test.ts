import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { dispatchOnce, type Dependencies } from "../../src/dispatch/dispatch.ts";
import { finish } from "../../src/dispatch/finish.ts";
import { describeStatus, status, type StatusResult } from "../../src/dispatch/status.ts";
import { attemptsWith, fixture, task } from "./fixture.ts";
import { LegacyAttempts } from "../fixtures/legacy-attempts.ts";
import { testCaller } from "../caller.ts";
import { importAttempts } from "../../src/attempts/import.ts";
import { AttemptStore } from "../../src/attempts/store.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";
import { RuntimeRecords } from "../../src/runtime/records.ts";
import { PiWorker } from "../../src/runtime/pi/worker.ts";
import { configSchema } from "../../src/config.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function settled(f: Fixture, id: string) {
  const ref = await f.deps.attempts.create(id, {}, 0);
  await f.tasks.done(id);
  await f.deps.attempts.append(ref, "halted", { stage: "fixture", reason: "task_done" });
  return ref;
}
function cli(f: Fixture, json: boolean, filtered: boolean) {
  const result = spawnSync(process.execPath, [resolve("src/cli.ts"), "status", ...(filtered ? ["--attention-only"] : []),
    ...(json ? ["--json"] : []), "--config", f.config], { encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  return result.stdout;
}

test("mixed context: active, finished and historical attempts agree in text and JSON attention-only output", async () => {
  const f = await fixture({ tasks: [task("active-a1"), task("finished-a1"), task("historical-a1"), task("failed-a1")],
    scenario: "commit-result", acceptance: "independent_deliverable", maxAttempts: 4 });
  const config = configSchema.parse(JSON.parse(readFileSync(f.config, "utf8")));
  const legacy = new LegacyAttempts(config.runtimeRoot, config.contextId);
  const historical = await legacy.create("historical-a1", {}, 0);
  await legacy.append(historical, "task_recorded", { outcome: "done", reason: "Done", category: "done" });
  await f.tasks.done("historical-a1");
  const failure = await legacy.create("failed-a1", {}, 0);
  await legacy.append(failure, "task_recorded", { outcome: "hold", reason: "Needs repair", category: "failed" });
  await f.tasks.hold("failed-a1", "Needs repair");
  f.tasks.close();
  await importAttempts(config, testCaller);
  const tasks = await SqliteTaskStore.open({ caller: testCaller, path: config.databasePath!, repo: "fixture" });
  const runtime = new RuntimeRecords(config.runtimeRoot, tasks.database);
  const worker = new PiWorker(runtime, { executable: process.execPath, entrypoint: resolve("tests/fixtures/pi-rpc.ts"),
    provider: "fixture", model: "fixture", shellTool: "bash", keepAwake: false, requestMs: 2000, runMs: 5000, stopMs: 600,
    environment: { ...f.environment, FAKE_PI_SCENARIO: "commit-result", FAKE_PI_LOG: join(f.dir, "mixed-requests.jsonl") } });
  const deps: Dependencies = { ...f.deps, tasks, attempts: new AttemptStore(tasks.database, config.contextId, testCaller), runtime,
    launch: (input, signal, onRequest) => worker.execute(input, signal, onRequest ? { onRequest } : {}) };
  try {
    await dispatchOnce(deps, { taskId: "active-a1" });
    const completed = await dispatchOnce(deps, { taskId: "finished-a1" });
    const finished = await finish(deps, { leaseId: completed.attempt!.leaseId!, noProcesses: true });
    assert.equal(finished.ok, true, JSON.stringify(finished));

    const all = JSON.parse(cli(f, true, false)) as StatusResult;
    assert.equal(all.attempts.length, 4);
    assert.equal(all.omittedCount, undefined, "Default JSON does not gain filter metadata");
    assert.equal(all.attempts.find(a => a.attempt.taskId === "historical-a1")!.specificationStatus, "historical");
    assert.equal(all.attempts.find(a => a.attempt.taskId === "historical-a1")!.nextAction.code, "none");
    const normalText = cli(f, false, false);
    assert.match(normalText, /historical-a1 attempt 1:[\s\S]*Stored specification incomplete – historical attempt; no launch required/);
    assert.match(normalText, /active-a1 attempt 1: awaiting finish/);
    assert.doesNotMatch(normalText, /Omitted attempts/);

    const view = JSON.parse(cli(f, true, true)) as StatusResult;
    const text = cli(f, false, true);
    assert.deepEqual(view.attempts.map(a => a.attempt.taskId).sort(), ["active-a1", "failed-a1"]);
    assert.equal(view.omittedCount, 2);
    assert.match(text, new RegExp(`Omitted attempts needing no attention: ${view.omittedCount}\\n`));
    for (const id of ["active-a1", "failed-a1"]) assert.match(text, new RegExp(`- ${id} attempt 1:`));
    for (const id of ["finished-a1", "historical-a1"]) assert.doesNotMatch(text, new RegExp(`- ${id} attempt 1:`));
    assert.equal(view.reason, all.reason);
    assert.deepEqual(view.capacity, all.capacity);
    assert.deepEqual(view.nextAction, all.nextAction);
  } finally { tasks.close(); }
});

test("an incomplete specification on a pending launch still warns and remains visible", async () => {
  const f = await fixture({ tasks: [task("pending-a1")] });
  try {
    await f.deps.attempts.create("pending-a1", {}, 0);
    const records = f.deps.attempts.list().map(record => ({ ...record, specification: {
      version: 1 as const, contextId: f.deps.contextId, taskId: record.taskId, provenance: {},
    } }));
    const view = await status({ ...f.deps, attempts: attemptsWith(f, { list: () => records }) }, { attentionOnly: true });
    assert.equal(view.attempts[0]!.specificationStatus, "incomplete");
    assert.equal(view.omittedCount, 0);
    assert.match(describeStatus(view), /Stored specification incomplete – this attempt cannot be launched; inspect and resolve it/);
    assert.doesNotMatch(describeStatus(view), /historical attempt/);
  } finally { f.tasks.close(); }
});

test("attention-only reports zero omissions, including an empty context", async () => {
  const f = await fixture({ tasks: [task("pending-a1")] });
  try {
    for (const populated of [false, true]) {
      if (populated) await f.deps.attempts.create("pending-a1", {}, 0);
      const view = await status(f.deps, { attentionOnly: true });
      assert.equal(view.omittedCount, 0);
      assert.equal(view.attempts.length, populated ? 1 : 0);
      assert.match(describeStatus(view), /Omitted attempts needing no attention: 0\n/);
      assert.equal(JSON.parse(JSON.stringify(view)).omittedCount, 0);
    }
  } finally { f.tasks.close(); }
});

test("a returned failed attempt still needs attention even if its task hold was released", async () => {
  const f = await fixture({ tasks: [task("failed-a1")] });
  try {
    const ref = await f.deps.attempts.create("failed-a1", {}, 0);
    await f.deps.attempts.append(ref, "worker_finished", { status: "failed", runtimeDirectory: f.dir });
    await f.deps.attempts.append(ref, "halted", { stage: "worker", reason: "failed" });
    const view = await status(f.deps, { attentionOnly: true });
    assert.equal(view.attempts[0]!.state, "finished");
    assert.equal(view.attempts[0]!.nextAction.code, "inspect_attempt");
    assert.equal(view.reason, "attention");
    assert.equal(view.omittedCount, 0);
    await f.tasks.done("failed-a1");
    const resolved = await status(f.deps, { attentionOnly: true });
    assert.equal(resolved.omittedCount, 1, "A completed task resolves the failed attempt");
  } finally { f.tasks.close(); }
});

test("attention-only retains a completed attempt's lease until it is returned", async () => {
  const f = await fixture({ tasks: [task("retained-a1")], scenario: "commit-result", acceptance: "independent_deliverable" });
  try {
    const result = await dispatchOnce(f.deps);
    const retained = await status(f.deps, { attentionOnly: true });
    assert.equal(retained.attempts[0]!.leaseHeld, true);
    assert.equal(retained.attempts[0]!.nextAction.code, "finish_attempt");
    assert.equal(retained.omittedCount, 0);
    assert.equal((await finish(f.deps, { leaseId: result.attempt!.leaseId!, noProcesses: true })).ok, true);
    const returned = await status(f.deps, { attentionOnly: true });
    assert.equal(returned.omittedCount, 1);
    assert.deepEqual(returned.attempts, []);
  } finally { f.tasks.close(); }
});

test("status observes absent, existing and recreated output refs without changing Git or attempt records", async () => {
  const f = await fixture({ tasks: [task("branch-a1")] });
  try {
    const ref = await settled(f, "branch-a1");
    const branch = "switchboard/observed";
    await f.deps.attempts.append(ref, "leased", { leaseId: "old-lease", workspace: f.deps.repository,
      baseRef: "main", outputBranch: branch, startingCommit: f.run(["rev-parse", "HEAD"]) });
    const before = JSON.stringify(f.deps.attempts.read(ref));
    const absent = await status(f.deps);
    assert.equal(absent.attempts[0]!.outputBranchCleanup!.status, "deleted");
    assert.match(describeStatus(absent), /Output branch switchboard\/observed: deleted/);
    assert.equal(JSON.stringify(f.deps.attempts.read(ref)), before);
    f.run(["branch", branch]);
    const present = await status(f.deps);
    assert.equal(present.attempts[0]!.outputBranchCleanup!.status, "kept");
    await f.deps.attempts.append(ref, "output_branch_cleanup", { branch, status: "deleted" });
    const recreated = await status(f.deps);
    assert.equal(recreated.attempts[0]!.outputBranchCleanup!.status, "kept");
    assert.match(recreated.attempts[0]!.outputBranchCleanup!.detail!, /exists despite recorded deletion/);
    assert.equal(f.run(["branch", "--list", branch]).trim(), branch);
  } finally { f.tasks.close(); }
});

test("unreadable Git is unknown, never deleted, and remains in attention-only output", async () => {
  const f = await fixture({ tasks: [task("unknown-a1")] });
  try {
    const ref = await settled(f, "unknown-a1");
    await f.deps.attempts.append(ref, "leased", { leaseId: "old-lease", workspace: f.dir,
      baseRef: "main", outputBranch: "switchboard/unknown", startingCommit: f.run(["rev-parse", "HEAD"]) });
    await f.deps.attempts.append(ref, "output_branch_cleanup", { branch: "switchboard/unknown", status: "deleted" });
    const view = await status({ ...f.deps, repository: join(f.dir, "missing-repository") }, { attentionOnly: true });
    assert.equal(view.attempts[0]!.outputBranchCleanup!.status, "unknown");
    assert.match(describeStatus(view), /Output branch switchboard\/unknown: unknown – Could not read output branch/);
    assert.equal(view.omittedCount, 0);
    assert.equal(view.reason, "attention");
  } finally { f.tasks.close(); }
});
