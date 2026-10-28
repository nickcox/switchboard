import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { AttemptStore } from "../../src/attempts/store.ts";
import { createDependencies, loadConfig } from "../../src/config.ts";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { status } from "../../src/dispatch/status.ts";
import { attemptsWith, fixture, task } from "./fixture.ts";

for (const [field, value] of [["title", "New title"], ["body", "New instructions"], ["repo", "other"], ["kind", "unconfigured"]] as const) {
  test(`changing ${field} during acquisition holds the attempt with its unused lease and never launches`, async () => {
    const f = await fixture({ tasks: [task("snapshot-a1")] });
    const acquire = f.deps.workspaces.acquire.bind(f.deps.workspaces);
    f.deps.workspaces.acquire = async request => {
      const allocation = await acquire(request);
      await f.tasks.update("snapshot-a1", { [field]: value });
      return allocation;
    };
    let launches = 0;
    f.deps.launch = async () => { launches++; throw new Error("Must not launch"); };
    try {
      const result = await dispatchOnce(f.deps);
      assert.equal(result.reason, "task_definition_changed", JSON.stringify(result));
      assert.equal(result.lease, "preserved");
      assert.equal(result.nextAction.code, "return_unused_lease");
      assert.match(result.detail!, /release the task and dispatch a new attempt/);
      assert.equal(launches, 0);
      const current = (await f.tasks.read("snapshot-a1"))!;
      assert.equal(current.state, "queued");
      assert.equal(current.holdReason, "task_definition_changed");
      assert.equal(current.definitionRevision, 2);
      const [record] = await f.deps.attempts.forTask("snapshot-a1");
      assert.equal(record!.specification!.definitionRevision, 1);
      assert.equal(record!.specification!.title, "Task snapshot-a1");
      assert.equal(record!.specification!.instructions, "Implement the fixture change");
      assert.equal(record!.specification!.repository, "fixture");
      assert.equal(record!.specification!.kind, null);
      assert.deepEqual(record!.specification!.delivery, f.deps.delivery.default);
      assert.equal(record!.allocation!.leaseId, result.attempt!.leaseId);
      assert.equal(record!.allocation!.backingRepository, f.deps.repository);
      assert.equal(record!.allocation!.startingCommit, f.run(["rev-parse", "main"]));
      assert.deepEqual(record!.entries.map(e => e.kind), ["requested", "leased", "halted"]);
      assert.equal(record!.entries.at(-1)!.data.reason, "task_definition_changed");
      assert.equal((await f.deps.workspaces.leases()).length, 1);
      assert.equal(f.tasks.database.get("SELECT count(*) AS n FROM launches")!.n, 0);
      if (field === "kind") {
        assert.equal(current.kind, "unconfigured");
        assert.equal(f.deps.delivery.byTaskKind.unconfigured, undefined);
      }
    } finally { f.tasks.close(); }
  });
}

for (const change of ["hold", "dependency", "state"] as const) {
  test(`a readiness ${change} during acquisition still refuses start without changing the definition revision`, async () => {
    const f = await fixture({ tasks: [task("snapshot-a1"), task("blocker-a1")] });
    const acquire = f.deps.workspaces.acquire.bind(f.deps.workspaces);
    f.deps.workspaces.acquire = async request => {
      const allocation = await acquire(request);
      if (change === "hold") await f.tasks.hold("snapshot-a1", "Operator hold");
      else if (change === "dependency") await f.tasks.block("snapshot-a1", "blocker-a1");
      else await f.tasks.done("snapshot-a1");
      return allocation;
    };
    let launches = 0;
    f.deps.launch = async () => { launches++; throw new Error("Must not launch"); };
    try {
      const result = await dispatchOnce(f.deps, { taskId: "snapshot-a1" });
      assert.equal(result.reason, "stopped");
      assert.equal(result.stage, "start");
      assert.equal(result.lease, "preserved");
      assert.equal(result.nextAction.code, "return_unused_lease");
      assert.equal(launches, 0);
      assert.equal((await f.tasks.read("snapshot-a1"))!.definitionRevision, 1);
      const [record] = await f.deps.attempts.forTask("snapshot-a1");
      assert.equal(record!.entries.some(e => e.kind === "task_started" || e.kind === "launched"), false);
    } finally { f.tasks.close(); }
  });
}

test("a definition changed before the reservation transaction refuses without an attempt or acquisition", async () => {
  const f = await fixture({ tasks: [task("snapshot-a1")] });
  let acquisitions = 0;
  const attempts = attemptsWith(f, { reserveAttempt: async options => {
    await f.tasks.update(options.taskId, { kind: "unconfigured" });
    return f.deps.attempts.reserveAttempt(options);
  } });
  const acquire = f.deps.workspaces.acquire.bind(f.deps.workspaces);
  f.deps.workspaces.acquire = async request => { acquisitions++; return acquire(request); };
  try {
    const result = await dispatchOnce({ ...f.deps, attempts });
    assert.equal(result.reason, "refused");
    assert.equal(result.observed.reason, "task_changed");
    assert.equal(acquisitions, 0);
    assert.deepEqual(attempts.list(), []);
  } finally { f.tasks.close(); }
});

test("a changed definition never replaces a newer operator hold during acquisition", async () => {
  const f = await fixture({ tasks: [task("snapshot-a1")] });
  const acquire = f.deps.workspaces.acquire.bind(f.deps.workspaces);
  f.deps.workspaces.acquire = async request => {
    const allocation = await acquire(request);
    await f.tasks.update("snapshot-a1", { body: "New instructions" });
    await f.tasks.hold("snapshot-a1", "Operator decision");
    return allocation;
  };
  try {
    assert.equal((await dispatchOnce(f.deps)).reason, "task_definition_changed");
    assert.equal((await f.tasks.read("snapshot-a1"))!.holdReason, "Operator decision");
  } finally { f.tasks.close(); }
});

test("task and configuration changes after start leave the worker's input and runtime settings unchanged", async () => {
  const f = await fixture({ tasks: [task("snapshot-a1")], scenario: "commit-result" });
  const original = structuredClone({ delivery: f.deps.delivery, settings: f.deps.runtimeSettings, repository: f.deps.repository });
  const attempts = attemptsWith(f, { startReservedTask: async ref => {
    const started = await f.deps.attempts.startReservedTask(ref);
    await f.tasks.update(ref.taskId, { title: "New title", body: "New instructions", repo: "other", kind: "unconfigured" });
    await f.tasks.hold(ref.taskId, "Newer operator hold");
    f.deps.delivery.baseRef = "missing";
    f.deps.delivery.branchPrefix = "changed/";
    f.deps.delivery.default.kind = "artefact";
    f.deps.delivery.default.requiredEvidence.push("new evidence");
    f.deps.runtimeSettings.provider = "changed";
    f.deps.runtimeSettings.model = "changed";
    f.deps.runtimeSettings.runMs = 1;
    deps.repository = "/not-the-repository";
    return started;
  } });
  const launch = f.deps.launch;
  let launches = 0;
  const deps = { ...f.deps, attempts, launch: async (...args: Parameters<typeof launch>) => {
    launches++;
    const [input, , , settings] = args;
    assert.equal(input.instructions, "Implement the fixture change");
    assert.deepEqual(input.delivery, { ...original.delivery.default, baseRef: "main", outputBranch: "switchboard/snapshot-a1/attempt-1", startingCommit: f.run(["rev-parse", "main"]) });
    assert.deepEqual(settings, original.settings);
    return launch(...args);
  } };
  try {
    const result = await dispatchOnce(deps);
    assert.equal(launches, 1);
    assert.equal(result.reason, "held", JSON.stringify(result));
    assert.equal(result.retention!.retained, true);
    assert.equal((await f.tasks.read("snapshot-a1"))!.holdReason, "Newer operator hold");
    const [record] = await attempts.forTask("snapshot-a1");
    assert.equal(record!.specification!.instructions, "Implement the fixture change");
    assert.equal(record!.allocation!.backingRepository, original.repository);
    assert.equal(record!.entries.at(-1)!.data.applied, false);
  } finally { f.tasks.close(); }
});

test("inspection after reopening shows the same stored specification, not the new configuration", async () => {
  const f = await fixture({ tasks: [task("snapshot-a1")], scenario: "commit-result" });
  const config = JSON.parse(readFileSync(f.config, "utf8"));
  config.worker.environment.SECRET_CREDENTIAL = "never-store-this-value";
  config.worker.maxCost = 100;
  config.worker.maxTokens = 1000000;
  writeFileSync(f.config, JSON.stringify(config));
  f.tasks.close();
  const deps = await createDependencies(await loadConfig(f.config));
  let specification;
  try {
    const result = await dispatchOnce(deps);
    assert.equal(result.reason, "held", JSON.stringify(result));
    specification = (await status(deps)).attempts[0]!.specification!;
    assert.ok(specification);
    assert.equal(specification.runtime!.maxCost, 100);
    assert.equal(specification.runtime!.maxTokens, 1000000);
    assert.equal(specification.provenance["runtime.model"], `${f.config}#worker.model`);
    assert.equal(specification.provenance["runtime.shellTool"], "default:worker.shellTool");
    assert.equal(specification.provenance["delivery.kind"], `${f.config}#delivery.kind`);
    assert.doesNotMatch(JSON.stringify(specification), /never-store-this-value|SECRET_CREDENTIAL|environment/);
  } finally { deps.attempts.database.close(); }
  config.worker.provider = "another-provider";
  config.worker.model = "another-model";
  config.worker.maxCost = 1;
  config.delivery.baseRef = "another-base";
  config.delivery.kind = "artefact";
  writeFileSync(f.config, JSON.stringify(config));
  const restarted = await createDependencies(await loadConfig(f.config));
  try {
    const inspected = (await status(restarted)).attempts[0]!;
    assert.equal(inspected.specificationComplete, true);
    assert.deepEqual(inspected.specification, specification);
    assert.deepEqual(new AttemptStore(restarted.attempts.database, restarted.contextId).list()[0]!.specification, specification);
  } finally { restarted.attempts.database.close(); }
});
