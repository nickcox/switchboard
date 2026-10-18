import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { resolveStopped } from "../../src/dispatch/resolve.ts";
import { status } from "../../src/dispatch/status.ts";
import { fixture, task } from "./fixture.ts";

// Phase 1 PRD acceptance criterion 8: kill the dispatcher after leasing, after the in-flight update and after worker
// launch. The next invocation must refuse the unresolved attempt, report owner state and never dispatch the task again.
const child = resolve(import.meta.dirname, "../fixtures/crash-dispatch.ts");

async function crashAt(stage: string, scenario = "commit-result") {
  const f = await fixture({ tasks: [task("crash-a1"), task("crash-b1")], scenario });
  const run = spawnSync(process.execPath, [child, f.config, stage], { env: { ...process.env, ...f.environment }, encoding: "utf8" });
  // Windows has no signals: Node.js ends the process at once with exit code 1 and reports no signal. An empty stderr
  // tells that apart from an ordinary failure, which prints its error.
  if (process.platform === "win32") assert.deepEqual([run.status, run.signal, run.stderr], [1, null, ""], `dispatcher was not killed at ${stage}`);
  else assert.equal(run.signal, "SIGKILL", `dispatcher was not killed at ${stage}: ${run.stderr}`);
  return f;
}

test("killed after leasing: the leased task is not dispatched again and status reports it", async () => {
  const f = await crashAt("after-lease");
  assert.equal((await f.deps.attempts.forTask("crash-a1"))[0]!.entries.at(-1)?.kind, "requested");
  assert.equal((await f.deps.workspaces.leases()).filter(l => l.holder === "crash-a1").length, 1);
  const view = await status(f.deps);
  assert.equal(view.reason, "attention");
  // The lease was created but never logged, so status reports it as not accounted for by any attempt.
  assert.equal(view.unaccountedLeases[0]?.holder, "crash-a1");
  const next = await dispatchOnce(f.deps);
  assert.equal(next.attempt?.taskId, "crash-b1");
  assert.equal((await dispatchOnce(f.deps, { taskId: "crash-a1" })).nextAction.code, "choose_another_task");
});

test("killed after the in-flight update: the in-flight task is not dispatched again", async () => {
  const f = await crashAt("after-start");
  assert.equal((await f.tasks.read("crash-a1"))?.state, "in_flight");
  assert.equal((await f.deps.attempts.forTask("crash-a1"))[0]!.entries.at(-1)?.kind, "leased");
  const next = await dispatchOnce(f.deps);
  assert.equal(next.attempt?.taskId, "crash-b1");
  assert.equal((await dispatchOnce(f.deps, { taskId: "crash-a1" })).nextAction.code, "choose_another_task");
});

test("killed after launch: dispatch is refused until the operator confirms the worker stopped", async () => {
  const f = await crashAt("after-launch", "delay-exit");
  // The orphaned synthetic worker exits once its input closes; wait for it so the test leaves no process behind.
  await sleep(500);
  assert.equal((await f.deps.attempts.forTask("crash-a1"))[0]!.entries.at(-1)?.kind, "launched");
  const blocked = await dispatchOnce(f.deps);
  assert.equal(blocked.nextAction.code, "stop_worker");
  const view = await status(f.deps);
  const stuck = view.attempts.find(a => a.attempt.taskId === "crash-a1");
  assert.equal(stuck?.possiblyRunning, true);
  assert.equal(view.nextAction.code, "stop_worker");

  assert.equal((await resolveStopped(f.deps, { leaseId: stuck!.attempt.leaseId!, confirmed: true })).reason, "resolved");
  const next = await dispatchOnce(f.deps);
  assert.equal(next.attempt?.taskId, "crash-b1");
  assert.equal((await f.tasks.read("crash-a1"))?.state, "in_flight");
});
