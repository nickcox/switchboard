import assert from "node:assert/strict";
import { test } from "node:test";
import { runSteps } from "../../src/dispatch/steps.ts";
import { result } from "../../src/dispatch/result.ts";

const refusal = result({ ok: false, reason: "refused", stage: "finish", lease: "preserved", observed: {}, nextAction: "inspect_attempt" });

test("the step runner plans without effects and runs exactly that list in order", async () => {
  const effects: string[] = [];
  const steps = ["rebase", "accept", "integrate"].map(description => ({ description, run: async () => { effects.push(description); } }));
  const stopped = () => refusal;
  const plan = await runSteps(steps, { dryRun: true, stopped });
  assert.deepEqual(effects, []);
  const run = await runSteps(steps, { stopped });
  assert.deepEqual(run.descriptions, plan.descriptions);
  assert.deepEqual(effects, plan.descriptions);
});

test("the step runner stops at a refusal or exception and names the failed step", async () => {
  for (const throws of [false, true]) {
    const effects: string[] = [];
    const run = await runSteps([
      { description: "before", run: async () => { effects.push("before"); } },
      { description: "failure", run: async () => { if (throws) throw new Error("failed"); return refusal; } },
      { description: "after", run: async () => { effects.push("after"); } },
    ], { stopped: (error, description) => { assert.equal(description, "failure"); assert.match(String(error), /failed/); return refusal; } });
    assert.deepEqual(effects, ["before"]);
    assert.equal(run.result, refusal);
  }
});
