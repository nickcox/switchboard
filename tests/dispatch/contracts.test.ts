import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchOnce, type ContractSpec } from "../../src/dispatch/dispatch.ts";
import { fixture } from "./fixture.ts";

// Per-task delivery contracts: a task's kind selects its contract from the configuration.
const scout: ContractSpec = { kind: "artefact", acceptance: "independent_deliverable", requiredEvidence: ["tests"], requiredDeliverables: ["report"] };
const scoutTask = (id: string) => ["add", id, `Investigate ${id}`, "--repo", "fixture", "--kind", "scout", "--body", "Write a short report"];

test("a task kind with a report contract is done when its report is retained outside the workspace", async () => {
  const f = await fixture({ tasks: [scoutTask("scout-a1")], scenario: "artefact-result", byTaskKind: { scout } });
  const outcome = await dispatchOnce(f.deps);
  assert.equal(outcome.reason, "done", JSON.stringify(outcome, null, 2));
  assert.equal((await f.tasks.read("scout-a1"))?.state, "done");
  assert.equal(outcome.retention?.retained, true);
  const requested = (await f.deps.attempts.forTask("scout-a1"))[0]!.entries[0]!;
  assert.deepEqual(requested.data.contract, { name: "scout", ...scout });
  // The worker was told where artefacts survive.
  const prompt = readFileSync(join(f.dir, "requests.jsonl"), "utf8").split("\n").find(line => line.includes('"type":"prompt"'))!;
  assert.match(prompt, /artefacts/);
});

test("a report left only in the workspace is not retained, so the task is held", async () => {
  const f = await fixture({ tasks: [scoutTask("scout-b1")], scenario: "artefact-in-workspace", byTaskKind: { scout } });
  const outcome = await dispatchOnce(f.deps);
  assert.equal(outcome.reason, "held");
  assert.equal(outcome.retention?.retained, false);
  assert.match(outcome.retention!.findings.join(), /inside the workspace/);
  assert.equal((await f.tasks.read("scout-b1"))?.holdReason, "Switchboard attempt 1 not retained");
});

test("a task kind with no contract is refused before any change", async () => {
  const f = await fixture({ tasks: [scoutTask("scout-c1")] });
  const outcome = await dispatchOnce(f.deps);
  assert.equal(outcome.reason, "refused");
  assert.equal(outcome.nextAction.code, "fix_configuration");
  assert.match(outcome.detail!, /kind "scout"/);
  assert.deepEqual(await f.deps.attempts.list(), []);
  assert.deepEqual(await f.deps.workspaces.leases(), []);
});

test("a task with no kind uses the default contract", async () => {
  const f = await fixture({ tasks: [["add", "plain-a1", "Plain", "--repo", "fixture", "--body", "Change"]], scenario: "commit-result", byTaskKind: { scout } });
  const outcome = await dispatchOnce(f.deps);
  assert.equal(outcome.nextAction.code, "review_branch");
  const contract = (await f.deps.attempts.forTask("plain-a1"))[0]!.entries[0]!.data.contract as { name: string } | undefined;
  assert.equal(contract?.name, "default");
});
