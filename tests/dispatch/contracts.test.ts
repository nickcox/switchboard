import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchOnce, type ContractSpec } from "../../src/dispatch/dispatch.ts";
import { status } from "../../src/dispatch/status.ts";
import { fixture } from "./fixture.ts";
import { RuntimeRecords } from "../../src/runtime/records.ts";
import { requireRetainedStorage } from "../../src/infra/storage.ts";

// Per-task delivery contracts: a task's kind selects its contract from the configuration.
const scout: ContractSpec = { kind: "artefact", acceptance: "independent_deliverable", requiredEvidence: ["tests"], requiredDeliverables: ["report"] };
const scoutTask = (id: string) => ["add", id, `Investigate ${id}`, "--repo", "fixture", "--kind", "scout", "--body", "Write a short report"];

test("a task kind with a report contract is done when its report is retained outside the workspace", async () => {
  const f = await fixture({ tasks: [scoutTask("scout-a1")], scenario: "artefact-result", byTaskKind: { scout } });
  const outcome = await dispatchOnce(f.deps);
  assert.equal(outcome.reason, "done", JSON.stringify(outcome, null, 2));
  assert.equal((await f.tasks.read("scout-a1"))?.state, "done");
  assert.equal(outcome.retention?.retained, true);
  assert.equal(outcome.nextAction.code, "finish_attempt");
  assert.equal((await status(f.deps)).attempts[0]?.nextAction.code, "finish_attempt");
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

test("every named Git branch and commit is retained-checked, including a second output-branch commit", async () => {
  for (const branch of ["does-not-exist", "output"]) {
    const f = await fixture({ tasks: [["add", "multi-a1", "Multiple commits", "--repo", "fixture"]], scenario: "commit-result", acceptance: "independent_deliverable" });
    f.deps.delivery.default.requiredDeliverables = ["code", "second"];
    const launch = f.deps.launch;
    f.deps.launch = async (...args) => {
      const report = await launch({ ...args[0], delivery: { ...args[0].delivery, requiredDeliverables: ["code"] } }, args[1], args[2]);
      assert.ok(report.result);
      report.result.workReferences.push({ kind: "git", name: "second", branch: branch === "output" ? args[0].delivery.outputBranch : branch, commit: "c".repeat(40) });
      return report;
    };
    const outcome = await dispatchOnce(f.deps);
    assert.equal(outcome.reason, "held", branch);
    assert.equal(outcome.retention?.retained, false);
  }
});

test("a required report supplied as a Git reference to a missing branch is not retained, whatever else is reported", async () => {
  // Review finding 7: an unrelated artefact must not stand in for the required report.
  const f = await fixture({ tasks: [scoutTask("kind-a1")], scenario: "artefact-result", byTaskKind: { scout } });
  const launch = f.deps.launch;
  f.deps.launch = async (...args) => {
    const report = await launch(...args);
    assert.ok(report.result);
    const extra = join(report.binding.artefactDirectory!, "extra.md");
    writeFileSync(extra, "Unrelated\n");
    report.result.workReferences = [
      { kind: "git", name: "report", branch: "does-not-exist", commit: "c".repeat(40) },
      { kind: "artefact", name: "extra", path: extra, description: "Unrelated" },
    ];
    return report;
  };
  const outcome = await dispatchOnce(f.deps);
  assert.equal(outcome.reason, "held");
  assert.equal(outcome.retention?.retained, false);
  assert.match(outcome.retention!.findings.join(), /does-not-exist/);
});

test("a code contract can also require a report, which must be retained in the artefact directory", async () => {
  const f = await fixture({ tasks: [["add", "both-a1", "Code and report", "--repo", "fixture"]], scenario: "commit-result" });
  f.deps.delivery.default.requiredDeliverables = ["code", "report"];
  const launch = f.deps.launch;
  f.deps.launch = async (...args) => {
    const report = await launch({ ...args[0], delivery: { ...args[0].delivery, requiredDeliverables: ["code"] } }, args[1], args[2]);
    assert.ok(report.result);
    const path = join(report.binding.artefactDirectory!, "report.md");
    writeFileSync(path, "Report\n");
    report.result.workReferences.push({ kind: "artefact", name: "report", path, description: "Required report" });
    return report;
  };
  const outcome = await dispatchOnce(f.deps);
  assert.equal(outcome.reason, "held");
  assert.equal(outcome.retention?.retained, true, JSON.stringify(outcome.retention));
  assert.equal(outcome.nextAction.code, "review_then_finish");
});

test("a report outside the attempt's artefact directory is not retained, even outside every workspace", async () => {
  const f = await fixture({ tasks: [scoutTask("elsewhere-a1")], scenario: "artefact-result", byTaskKind: { scout } });
  const path = join(f.dir, "report-elsewhere.md");
  writeFileSync(path, "Report outside the artefact directory\n");
  const launch = f.deps.launch;
  f.deps.launch = async (...args) => {
    const report = await launch(...args);
    assert.ok(report.result);
    report.result.workReferences = [{ kind: "artefact", name: "report", path, description: "Required report" }];
    return report;
  };
  const outcome = await dispatchOnce(f.deps);
  assert.equal(outcome.reason, "held");
  assert.equal(outcome.retention?.retained, false);
  assert.match(outcome.retention!.findings.join(), /outside the assigned artefact directory/);
});

test("runtime storage in an earlier recyclable workspace is refused before writing an attempt", async () => {
  const f = await fixture({ tasks: [scoutTask("storage-a1")], byTaskKind: { scout } });
  const earlier = await f.deps.workspaces.acquire({ holder: "earlier", baseRef: "main", branch: "earlier" });
  const root = join(earlier.path, "runtime");
  const runtime = f.deps.runtime;
  for (const storage of ["runtime", "attempts"]) {
    f.deps.runtime = storage === "runtime" ? new RuntimeRecords(root) : runtime;
    if (storage === "attempts") f.deps.attempts = Object.assign(Object.create(Object.getPrototypeOf(f.deps.attempts)), f.deps.attempts, {
      checkStorage: (roots: string[]) => requireRetainedStorage(root, roots),
    });
    const outcome = await dispatchOnce(f.deps);
    assert.equal(outcome.reason, "refused", storage);
    assert.equal(outcome.nextAction.code, "fix_configuration");
    assert.equal(existsSync(root), false);
    assert.equal((await f.deps.workspaces.leases()).length, 1);
  }
});

test("a report in an earlier recyclable workspace is not retained", async () => {
  const f = await fixture({ tasks: [scoutTask("storage-b1")], scenario: "artefact-result", byTaskKind: { scout } });
  const earlier = await f.deps.workspaces.acquire({ holder: "earlier", baseRef: "main", branch: "earlier" });
  const path = join(earlier.path, "report.md");
  writeFileSync(path, "Report in another workspace\n");
  const launch = f.deps.launch;
  f.deps.launch = async (...args) => {
    const report = await launch(...args);
    assert.ok(report.result);
    report.result.workReferences = [{ kind: "artefact", name: "report", path, description: "Required report" }];
    return report;
  };
  const outcome = await dispatchOnce(f.deps);
  assert.equal(outcome.reason, "held");
  assert.equal(outcome.retention?.retained, false);
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
  assert.equal(outcome.nextAction.code, "review_then_finish");
  const contract = (await f.deps.attempts.forTask("plain-a1"))[0]!.entries[0]!.data.contract as { name: string } | undefined;
  assert.equal(contract?.name, "default");
});
