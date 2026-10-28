import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { finish } from "../../src/dispatch/finish.ts";
import { describe } from "../../src/dispatch/result.ts";
import { describeStatus, status } from "../../src/dispatch/status.ts";
import { watch } from "../../src/dispatch/watch.ts";
import { fixture, task } from "./fixture.ts";

for (const scenario of ["missing-criteria", "duplicate-criteria", "extra-criteria"]) {
  test(`${scenario} is held as an invalid result, not accepted as completed work`, async () => {
    const f = await fixture({ tasks: [task("criteria-a1")], scenario });
    try {
      await f.tasks.update("criteria-a1", { acceptanceCriteria: ["First", "Second"] });
      const result = await dispatchOnce(f.deps);
      assert.equal(result.reason, "held", JSON.stringify(result));
      assert.equal(result.worker!.status, "failed");
      assert.equal((await f.tasks.read("criteria-a1"))!.holdReason, "Switchboard attempt 1 failed");
      const [runtime] = await f.runtime.discover(f.deps.contextId);
      assert.equal(runtime!.validatedResult, undefined);
      const [attempt] = await f.deps.attempts.forTask("criteria-a1");
      const finished = attempt!.entries.find(entry => entry.kind === "worker_finished")!;
      assert.equal(finished.data.reason, "invalid_result");
    } finally { f.tasks.close(); }
  });
}

test("a complete criteria report is accepted, recorded and shown by dispatch, status, watch and finish", async () => {
  const f = await fixture({ tasks: [task("criteria-a1")], scenario: "commit-result" });
  try {
    await f.tasks.update("criteria-a1", { acceptanceCriteria: ["First", "Second"] });
    const dispatched = await dispatchOnce(f.deps);
    assert.equal(dispatched.reason, "held", JSON.stringify(dispatched));
    assert.equal(dispatched.worker!.status, "reported");
    assert.equal(dispatched.retention!.retained, true);
    assert.deepEqual(dispatched.criteriaReport!.map(entry => entry.criterion), ["First", "Second"]);
    assert.match(describe(dispatched), /Criterion 1: met – First/);
    const inspected = await status(f.deps);
    assert.deepEqual(inspected.attempts[0]!.criteriaReport, dispatched.criteriaReport);
    assert.match(describeStatus(inspected), /Criterion 2: met – Second/);
    const activity: string[] = [];
    await watch(f.deps, { leaseId: dispatched.attempt!.leaseId!, follow: false, print: entry => {
      if (entry.kind === "note") activity.push(entry.text);
    } });
    assert.match(activity.join("\n"), /Criterion 1: met – First/);
    const finished = await finish(f.deps, { leaseId: dispatched.attempt!.leaseId!, noProcesses: false });
    assert.equal(finished.reason, "finished", JSON.stringify(finished));
    assert.deepEqual(finished.criteriaReport, dispatched.criteriaReport);
    assert.match(describe(finished), /Evidence \(worker claim\): Synthetic fixture evidence/);
  } finally { f.tasks.close(); }
});
