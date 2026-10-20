import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dispatchOnce, type Dependencies } from "../../src/dispatch/dispatch.ts";
import { fixture, task } from "./fixture.ts";

// A launch error is only "not started" when no worker can exist: the runtime reserves its records before starting one.
type Stage = "before reservation" | "after reservation" | "after exit";
async function failingLaunch(stage: Stage) {
  const f = await fixture({ tasks: [task("launch-a1"), task("other-b1")], scenario: "commit-result" });
  const launch: Dependencies["launch"] = async input => {
    if (stage !== "before reservation") {
      mkdirSync(input.workspace, { recursive: true });
      const reserved = await f.runtime.reserve(input);
      if (stage === "after exit") await f.runtime.recordChildExit(reserved, { started: true, code: 0, signal: null });
    }
    throw new Error(`runtime failed ${stage}`);
  };
  return { f, outcome: await dispatchOnce({ ...f.deps, launch }) };
}

test("a launch error before the runtime reserved its records is finalised as not started", async () => {
  const { f, outcome } = await failingLaunch("before reservation");
  assert.equal(outcome.reason, "held");
  assert.equal(outcome.worker?.status, "not_started");
  assert.equal((await dispatchOnce(f.deps)).attempt?.taskId, "other-b1");
});

test("a launch error after the runtime reserved its records leaves the attempt unresolved and blocks dispatch", async () => {
  const { f, outcome } = await failingLaunch("after reservation");
  assert.equal(outcome.reason, "stopped");
  assert.equal(outcome.stage, "launch");
  assert.equal(outcome.nextAction.code, "stop_worker");
  assert.equal((await f.tasks.read("launch-a1"))?.state, "in_flight");
  assert.ok(!(await f.deps.attempts.forTask("launch-a1"))[0]!.entries.some(e => e.kind === "task_recorded"));
  const next = await dispatchOnce(f.deps);
  assert.equal(next.reason, "refused");
  assert.equal(next.nextAction.code, "stop_worker");
});

test("a launch error after the worker's exit was observed is finalised", async () => {
  const { f, outcome } = await failingLaunch("after exit");
  assert.equal(outcome.reason, "held");
  assert.equal((await dispatchOnce(f.deps)).attempt?.taskId, "other-b1");
});
