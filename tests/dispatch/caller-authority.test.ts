import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { AttemptStore } from "../../src/attempts/store.ts";
import { callerName, type Caller } from "../../src/caller.ts";
import { createDependencies, loadConfig } from "../../src/config.ts";
import { requestControl } from "../../src/dispatch/control.ts";
import type { Dependencies } from "../../src/dispatch/dependencies.ts";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { discard, finish } from "../../src/dispatch/finish.ts";
import { prune } from "../../src/dispatch/prune.ts";
import { reserveFromAttempt } from "../../src/dispatch/reserve.ts";
import { resolveLeaseReturned, resolveReadFailure, resolveStopped } from "../../src/dispatch/resolve.ts";
import { createReview } from "../../src/dispatch/review.ts";
import { checkCaller, type ObjectivePermission } from "../../src/dispatch/safety.ts";
import { ObjectiveStore, defaultPermissions, type CompletionStatement } from "../../src/objectives/store.ts";
import { PiWorker } from "../../src/runtime/pi/worker.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";
import { importTasks } from "../../src/tasks/import.ts";
import { importAttempts, importRuntime } from "../../src/attempts/import.ts";
import { testCaller } from "../caller.ts";
import { fixture, task } from "./fixture.ts";

const supervisor: Caller = { kind: "supervisor", objectiveId: "goal" };
const reviewContract = { kind: "artefact" as const, acceptance: "independent_deliverable" as const, requiredEvidence: [], requiredDeliverables: ["report"] };
const statements: CompletionStatement[] = [{ position: 1, statement: "Completed", references: [{ kind: "accepted_commit", contextId: "fixture-context", taskId: "own", attempt: 1, commit: "a".repeat(40) }] }];

async function objectiveFixture(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture({ tasks: [task("foreign"), task("own")], scenario: "commit-result", byTaskKind: { review: reviewContract }, ...options });
  const objectives = new ObjectiveStore(f.tasks.database, testCaller);
  await objectives.add({ id: "goal", request: "Do this work", acceptanceCriteria: ["Keep the output"] });
  await objectives.add({ id: "other", request: "Other work", acceptanceCriteria: ["Other output"] });
  await f.tasks.update("own", { objectiveId: "goal", acceptanceCriteria: ["Keep the output"] });
  await f.tasks.update("foreign", { objectiveId: "other" });
  const deps: Dependencies = { ...f.deps, caller: supervisor, attempts: new AttemptStore(f.tasks.database, f.deps.contextId, supervisor) };
  return { ...f, objectives, supervisor: deps };
}
type Fixture = Awaited<ReturnType<typeof objectiveFixture>>;
const rows = (f: Fixture) => ["tasks", "task_changes", "attempt_numbers", "attempts", "attempt_entries", "confirmations", "launches", "control_requests", "objective_changes"]
  .map(table => f.tasks.database.all(`SELECT * FROM ${table}`));
const denied = (value: { ok: boolean; detail?: string }, reason: string) => {
  assert.equal(value.ok, false, JSON.stringify(value));
  assert.match(value.detail ?? "", new RegExp(reason));
};
async function output(f: Fixture) {
  const result = await dispatchOnce(f.deps, { taskId: "own" });
  assert.equal(result.reason, "held", JSON.stringify(result));
  return { leaseId: result.attempt!.leaseId!, workspace: result.attempt!.workspace!, commit: result.attempt!.resultCommit!, ref: f.deps.attempts.findForTask("own", 1)! };
}

for (const permission of Object.keys(defaultPermissions) as ObjectivePermission[]) test(`authority checks ${permission} for the supervisor, never for a person`, () => {
  const objective = { id: "goal", createdBy: callerName(testCaller), permissions: { ...defaultPermissions, [permission]: false } };
  const before = structuredClone(objective);
  const refused = checkCaller(supervisor, permission, objective, { objectiveId: "goal" });
  assert.equal(refused.allowed, false);
  if (!refused.allowed) assert.equal(refused.reason, "permission_denied");
  assert.deepEqual(checkCaller(testCaller, permission, objective, { objectiveId: "goal" }), { allowed: true });
  assert.deepEqual(checkCaller(supervisor, permission, { ...objective, permissions: defaultPermissions }, { objectiveId: "goal" }), { allowed: true });
  assert.deepEqual(objective, before);
});

test("each implemented permission is refused inside its operation before effects, including dry runs", async () => {
  const f = await objectiveFixture();
  try {
    const { leaseId } = await output(f);
    f.supervisor.policy = { git: "git", environment: f.environment, repository: f.deps.repository, baseRef: "main", globalFile: join(f.dir, "absent"), context: { kind: "local-merge", targetBranch: "main" } };
    const cases: { permission: ObjectivePermission; run: () => Promise<{ ok: boolean; detail?: string }> }[] = [
      { permission: "dispatch", run: () => dispatchOnce(f.supervisor, { taskId: "own", dryRun: true }) },
      { permission: "continueAttempts", run: () => reserveFromAttempt(f.supervisor, { taskId: "own", startingPoint: { taskId: "own", attempt: 1 }, requestId: "repair", dryRun: true }) },
      { permission: "steerWorkers", run: () => requestControl(f.supervisor, { leaseId, kind: "steer", message: "Change it", label: "operator:creator", waitMs: 1 }) },
      { permission: "stopWorkers", run: () => requestControl(f.supervisor, { leaseId, kind: "stop", waitMs: 1 }) },
      { permission: "acceptOutput", run: () => finish(f.supervisor, { leaseId, noProcesses: false, acceptOutput: true }) },
      { permission: "integrate", run: () => finish(f.supervisor, { leaseId, noProcesses: false }) },
      { permission: "completeTasks", run: () => finish(f.supervisor, { leaseId, noProcesses: false }) },
      { permission: "manageTasks", run: () => createReview(f.supervisor, { taskId: "own" }) },
    ];
    for (const entry of cases) {
      await f.objectives.update("goal", { permissions: { ...defaultPermissions, [entry.permission]: false } });
      const before = rows(f);
      denied(await entry.run(), `permission_denied.*${entry.permission}`);
      assert.deepEqual(rows(f), before, entry.permission);
    }
    await f.objectives.update("goal", { permissions: { ...defaultPermissions, completeObjective: false } });
    const objectives = new ObjectiveStore(f.tasks.database, supervisor);
    const before = rows(f);
    await assert.rejects(objectives.complete("goal", statements), /permission_denied.*completeObjective/);
    assert.deepEqual(rows(f), before);
  } finally { f.tasks.close(); }
});

test("only the creator can change objective authority or abandon it, and no supervisor can", async () => {
  const f = await objectiveFixture();
  try {
    const objectives = new ObjectiveStore(f.tasks.database, supervisor);
    const otherPerson = new ObjectiveStore(f.tasks.database, { kind: "person", id: "operator:someone-else" });
    for (const changes of [{ permissions: defaultPermissions }, { budget: { maxCost: 1, maxWorkerTimeMs: null } }, { acceptanceCriteria: ["Replacement"] }]) {
      const before = rows(f);
      await assert.rejects(objectives.update("goal", changes), /person_required/);
      await assert.rejects(objectives.update("other", changes), /person_required/);
      await assert.rejects(otherPerson.update("goal", changes), /creator_required/);
      assert.deepEqual(rows(f), before);
      await f.objectives.update("goal", changes);
    }
    await assert.rejects(objectives.abandon("goal"), /person_required/);
    await assert.rejects(otherPerson.abandon("goal"), /creator_required/);
    await assert.rejects(objectives.add({ id: "new", request: "Grant authority", acceptanceCriteria: ["Anything"] }), /person_required/);
    await f.objectives.abandon("goal");
    await f.objectives.reopen("goal");
    await objectives.update("goal", { scope: "A narrower scope", constraints: "Keep it local" });
    assert.equal(f.objectives.read("goal")!.scope, "A narrower scope");
    assert.equal(f.objectives.history("goal").at(-1)!.changedBy, "supervisor:goal");
    await assert.rejects(objectives.reopen("other"), /outside_objective/);
  } finally { f.tasks.close(); }
});

test("task mutations enforce scope and narrowed permissions in their transactions, not in arguments", async () => {
  const f = await objectiveFixture();
  const tasks = await SqliteTaskStore.open({ path: f.tasks.database.path, caller: supervisor, repo: "fixture" });
  try {
    const before = rows(f);
    for (const run of [
      () => tasks.add({ id: "unlinked", title: "Outside" }),
      () => tasks.add({ id: "elsewhere", title: "Outside", objectiveId: "other" }),
      () => tasks.update("foreign", { title: "Changed" }),
      () => tasks.update("own", { objectiveId: "other" }),
      () => tasks.update("own", { objectiveId: null }),
      () => tasks.update("foreign", { objectiveId: "goal" }),
      () => tasks.hold("foreign", "Hold"), () => tasks.release("foreign"),
      () => tasks.block("foreign", "own"), () => tasks.unblock("foreign", "own"),
      () => tasks.done("foreign"), () => tasks.reopen("foreign"),
    ]) await assert.rejects(run(), /outside_objective/);
    assert.deepEqual(rows(f), before);
    await f.objectives.update("goal", { permissions: { ...defaultPermissions, manageTasks: false } });
    await assert.rejects(tasks.add({ id: "spoofed", title: "Not authorised", objectiveId: "goal", caller: testCaller } as Parameters<typeof tasks.add>[0]), /permission_denied/);
    await assert.rejects(tasks.update("own", { title: "No" }), /permission_denied/);
    await f.objectives.update("goal", { permissions: { ...defaultPermissions, completeTasks: false } });
    await assert.rejects(tasks.done("own"), /permission_denied/);
    await f.objectives.update("goal", { permissions: defaultPermissions });
    await tasks.add({ id: "child", title: "Within scope", objectiveId: "goal" });
    await tasks.update("child", { title: "Updated" });
    await tasks.hold("child", "Wait"); await tasks.release("child");
    await tasks.block("child", "own"); await tasks.unblock("child", "own");
    await tasks.done("child"); await tasks.reopen("child");
    assert.ok(f.tasks.database.all("SELECT changed_by FROM task_changes WHERE task = 'child'").every(row => row.changed_by === "supervisor:goal"));
    await f.tasks.add({ id: "unlinked", title: "A person may create outside an objective" });
    await f.tasks.update("foreign", { title: "A person may change another objective's task" });
    await f.tasks.hold("foreign", "Wait"); await f.tasks.release("foreign");
    await f.tasks.block("foreign", "own"); await f.tasks.unblock("foreign", "own");
    await f.tasks.done("foreign"); await f.tasks.reopen("foreign");
    await f.tasks.update("foreign", { objectiveId: null });
  } finally { tasks.close(); f.tasks.close(); }
});

test("all attempt operations refuse tasks outside the caller's objective without effects", async () => {
  const f = await objectiveFixture();
  try {
    const source = await dispatchOnce(f.deps, { taskId: "foreign" });
    const leaseId = source.attempt!.leaseId!;
    const before = rows(f);
    for (const run of [
      () => dispatchOnce(f.supervisor, { taskId: "foreign" }),
      () => reserveFromAttempt(f.supervisor, { taskId: "foreign", startingPoint: { taskId: "foreign", attempt: 1 }, requestId: "foreign-repair" }),
      () => createReview(f.supervisor, { taskId: "foreign" }),
      () => finish(f.supervisor, { leaseId, noProcesses: false }),
      () => requestControl(f.supervisor, { leaseId, kind: "steer", message: "No", waitMs: 1 }),
      () => requestControl(f.supervisor, { leaseId, kind: "stop", waitMs: 1 }),
      () => resolveStopped(f.supervisor, { leaseId, confirmed: true }),
      () => resolveReadFailure(f.supervisor, { leaseId, failureSequence: 0, outcome: "happened", note: "No" }),
    ]) denied(await run(), "outside_objective");
    assert.deepEqual(rows(f), before);
    assert.equal((await createReview(f.deps, { taskId: "foreign" })).ok, true, "A person can create a review outside the supervisor's scope");
  } finally { f.tasks.close(); }
});

test("lease return is always person-only, including dry runs and resolve by task", async () => {
  const f = await objectiveFixture();
  try {
    const { leaseId } = await output(f);
    const before = rows(f);
    for (const dryRun of [false, true]) {
      denied(await finish(f.supervisor, { leaseId, noProcesses: true, dryRun }), "person_required");
      denied(await discard(f.supervisor, { leaseId, noProcesses: true, confirm: true, dryRun }), "person_required");
    }
    denied(await resolveLeaseReturned(f.supervisor, { leaseId }), "person_required");
    denied(await resolveLeaseReturned(f.supervisor, { taskId: "own" }), "person_required");
    assert.deepEqual(rows(f), before);
    assert.equal((await finish(f.deps, { leaseId, noProcesses: true })).reason, "finished");
    const confirmations = f.deps.attempts.findForTask("own", 1)!.confirmations!;
    assert.ok(confirmations.some(c => c.fact === "no_processes" && c.confirmedBy === callerName(testCaller)));
    assert.equal((await f.deps.workspaces.leases()).length, 0);
    const pending = await f.deps.attempts.create("foreign", {}, 0);
    assert.equal((await resolveLeaseReturned(f.deps, { taskId: pending.taskId })).ok, true, "A person may reconcile an unused reservation");
  } finally { f.tasks.close(); }
});

test("a person can discard the same work that the supervisor must retain", async () => {
  const f = await objectiveFixture();
  try {
    const { leaseId } = await output(f);
    denied(await discard(f.supervisor, { leaseId, noProcesses: true, confirm: true }), "person_required");
    assert.equal((await discard(f.deps, { leaseId, noProcesses: true, confirm: true })).reason, "discarded");
    assert.equal((await f.deps.workspaces.leases()).length, 0);
    assert.ok(f.deps.attempts.findForTask("own", 1)!.confirmations!.every(c => c.confirmedBy === callerName(testCaller)));
  } finally { f.tasks.close(); }
});

test("automatic selection and recorded entries use the host supervisor, never an argument caller", async () => {
  const f = await objectiveFixture();
  try {
    const plan = await dispatchOnce(f.supervisor, { dryRun: true });
    assert.equal(plan.selection!.taskId, "own", "The first ready task belongs to another objective");
    const result = await dispatchOnce(f.supervisor, { taskId: "own", caller: testCaller } as Parameters<typeof dispatchOnce>[1]);
    assert.equal(result.reason, "held", JSON.stringify(result));
    assert.ok(f.supervisor.attempts.findForTask("own", 1)!.entries.every(entry => entry.askedBy === "supervisor:goal"));
    await f.objectives.update("goal", { permissions: { ...defaultPermissions, dispatch: false } });
    denied(await dispatchOnce(f.supervisor, { taskId: "own", caller: testCaller } as Parameters<typeof dispatchOnce>[1]), "permission_denied");
    const raw = spawnSync(process.execPath, [resolve("src/cli.ts"), "dispatch", "--once", "--caller", "operator:admin"], { encoding: "utf8" });
    assert.equal(raw.status, 2);
    assert.match(raw.stderr, /Unknown option '--caller'/);
  } finally { f.tasks.close(); }
});

test("supervisor acceptance needs passing checks and review for the exact commit; a person remains unrestricted", async () => {
  const f = await objectiveFixture();
  try {
    const { leaseId, workspace, commit, ref } = await output(f);
    f.supervisor.checks = [{ name: "tests", command: [process.execPath, "-e", "process.exit(7)"], timeoutMs: 5000 }];
    f.supervisor.checkEnvironment = f.environment;
    f.supervisor.policy = { git: "git", environment: f.environment, repository: f.deps.repository, baseRef: "main", globalFile: join(f.dir, "absent"), context: { kind: "local-merge", targetBranch: "main" } };
    f.supervisor.attempts = new AttemptStore(f.tasks.database, f.deps.contextId, supervisor, f.supervisor.checks);
    denied(await finish(f.supervisor, { leaseId, noProcesses: false, acceptOutput: true }), "has not passed");
    assert.equal(f.supervisor.attempts.findForTask("own", 1)!.confirmations!.length, 0);
    f.supervisor.checks[0]!.command = [process.execPath, "-e", "process.exit(0)"];
    denied(await finish(f.supervisor, { leaseId, noProcesses: false }), "no recorded review");
    await assert.rejects(f.supervisor.attempts.appendConfirmed(ref, "output_accepted", { commit }, { fact: "output_accepted", scope: { commit } }), /review_missing/);
    for (const verdict of ["failed", "passed"] as const) {
      const created = await createReview(f.supervisor, { taskId: "own" });
      assert.equal(created.reason, "review_created", JSON.stringify(created));
      const worker = new PiWorker(f.runtime, { executable: process.execPath, entrypoint: resolve("tests/fixtures/pi-rpc.ts"), provider: "fixture", model: "fixture", shellTool: "bash", requestMs: 2000, runMs: 5000, stopMs: 600, environment: { ...f.environment, FAKE_PI_SCENARIO: verdict === "passed" ? "review-pass" : "review-fail", FAKE_PI_LOG: join(f.dir, `review-${verdict}-requests.jsonl`) } });
      f.supervisor.launch = (input, signal, onRequest) => worker.execute(input, signal, onRequest ? { onRequest } : {});
      const reviewed = await dispatchOnce(f.supervisor, { taskId: created.task!.id });
      assert.equal(reviewed.reason, "held", "Recording a review verdict does not automatically accept its own unreviewed output");
      const recordedReview = [...f.supervisor.attempts.findForTask("own", 1)!.entries].reverse().find(entry => entry.kind === "review_recorded");
      assert.ok(recordedReview, JSON.stringify(reviewed));
      assert.equal(recordedReview.data.verdict, verdict);
      if (verdict === "failed") {
        denied(await finish(f.supervisor, { leaseId, noProcesses: false, acceptOutput: true }), "latest review failed");
        assert.notEqual(f.run(["rev-parse", "main"]), commit);
      }
    }
    const accepted = await finish(f.supervisor, { leaseId, noProcesses: false, acceptOutput: true });
    assert.equal(accepted.reason, "finished", JSON.stringify(accepted));
    assert.deepEqual(accepted.acceptanceEvidence, { commit, permission: { allowed: true } });
    assert.equal(f.run(["rev-parse", "main"]), commit);
    assert.equal(f.supervisor.attempts.findForTask("own", 1)!.entries.find(entry => entry.kind === "integrated")!.askedBy, "supervisor:goal");
    assert.equal(f.supervisor.attempts.findForTask("own", 1)!.confirmations!.find(c => c.fact === "output_accepted")!.confirmedBy, "supervisor:goal");
    const complete: CompletionStatement[] = [{ position: 1, statement: "Accepted the checked and reviewed output", references: [{ kind: "accepted_commit", contextId: f.deps.contextId, taskId: "own", attempt: 1, commit }] }];
    await new ObjectiveStore(f.tasks.database, supervisor).complete("goal", complete);
    assert.equal(f.objectives.read("goal")!.state, "completed");
    await f.objectives.reopen("goal");
    f.run(["commit", "--allow-empty", "--no-gpg-sign", "-qm", "Later output"], workspace);
    const later = await finish(f.supervisor, { leaseId, noProcesses: false, acceptOutput: true });
    denied(later, "no recorded review");
    assert.notEqual(later.acceptanceEvidence!.commit, commit);
    assert.equal(f.supervisor.attempts.findForTask("own", 1)!.confirmations!.filter(c => c.fact === "output_accepted").length, 1);
    assert.equal((await finish(f.deps, { leaseId, noProcesses: false, acceptOutput: true })).reason, "finished");
  } finally { f.tasks.close(); }
});

test("--as is a recorded label, not a way to impersonate a person or gain a removed permission", async () => {
  const f = await objectiveFixture({ scenario: "await-steer", worker: { requestPollMs: 50 } });
  let dispatching: ReturnType<typeof dispatchOnce> | undefined;
  try {
    dispatching = dispatchOnce(f.supervisor, { taskId: "own" });
    let leaseId: string | undefined;
    for (let i = 0; i < 200; i++) {
      const record = (await f.runtime.discover(f.deps.contextId))[0];
      const log = join(f.dir, "requests.jsonl");
      if (record && existsSync(log) && readFileSync(log, "utf8").includes('"type":"prompt"')) { leaseId = record.binding.input.identity.leaseId; break; }
      await sleep(25);
    }
    assert.ok(leaseId, "The synthetic worker must be running");
    await f.objectives.update("goal", { permissions: { ...defaultPermissions, steerWorkers: false } });
    denied(await requestControl(f.supervisor, { leaseId, kind: "steer", message: "Finish", label: "operator:admin", waitMs: 1000 }), "permission_denied");
    assert.equal(f.tasks.database.all("SELECT * FROM control_requests").length, 0);
    await f.objectives.update("goal", { permissions: defaultPermissions });
    const sent = await requestControl(f.supervisor, { leaseId, kind: "steer", message: "Finish", label: "operator:admin", waitMs: 5000 });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    await dispatching;
    const request = JSON.parse(String(f.tasks.database.get("SELECT request FROM control_requests")!.request));
    assert.equal(request.sender, "supervisor:goal");
    assert.equal(request.label, "operator:admin");
    const entry = f.supervisor.attempts.findForTask("own", 1)!.entries.find(entry => entry.kind === "operator_request")!;
    assert.equal(entry.data.sender, "supervisor:goal");
    assert.equal(entry.data.label, "operator:admin");
  } finally { await dispatching; f.tasks.close(); }
});

test("hosts must supply callers, and supervisor imports cannot change database-wide records", async () => {
  const f = await objectiveFixture();
  try {
    const config = await loadConfig(f.config);
    await assert.rejects(createDependencies(config, undefined as unknown as Caller));
    await assert.rejects(importTasks(config, supervisor, join(f.dir, "missing-backlog")), /person_required/);
    await assert.rejects(importAttempts(config, supervisor), /person_required/);
    await assert.rejects(importRuntime(config, supervisor), /person_required/);
    const before = rows(f);
    await f.objectives.update("goal", { permissions: { ...defaultPermissions, manageTasks: false } });
    denied(await prune(f.supervisor, { olderThan: 1 }), "permission_denied");
    assert.deepEqual(rows(f).slice(0, -1), before.slice(0, -1));
  } finally { f.tasks.close(); }
});

test("a supervisor can reserve a continuation within its objective without returning the source lease", async () => {
  const f = await objectiveFixture();
  try {
    const { ref, leaseId } = await output(f);
    await f.tasks.release("own");
    const continued = await reserveFromAttempt(f.supervisor, { taskId: "own", startingPoint: { taskId: "own", attempt: 1 }, requestId: "continue" });
    assert.equal(continued.reason, "reserved", JSON.stringify(continued));
    assert.deepEqual(f.supervisor.attempts.findForTask("own", 1), ref);
    assert.equal(f.supervisor.attempts.findForTask("own", 2)!.entries[0]!.askedBy, "supervisor:goal");
    assert.ok((await f.deps.workspaces.leases()).some(lease => lease.leaseId === leaseId));
  } finally { f.tasks.close(); }
});

test("supervisor pruning changes only its objective and retains the caller in archive and cleanup records", async () => {
  const f = await objectiveFixture();
  try {
    const { leaseId } = await output(f);
    assert.equal((await discard(f.deps, { leaseId, noProcesses: true, confirm: true })).reason, "discarded");
    const foreign = await dispatchOnce(f.deps, { taskId: "foreign" });
    assert.equal((await discard(f.deps, { leaseId: foreign.attempt!.leaseId!, noProcesses: true, confirm: true })).reason, "discarded");
    const before = f.deps.attempts.findForTask("foreign", 1);
    const pruned = await prune(f.supervisor, { olderThan: 0.000000001 });
    assert.equal(pruned.reason, "pruned", JSON.stringify(pruned));
    assert.equal(f.supervisor.attempts.findForTask("own", 1), undefined);
    assert.deepEqual(f.deps.attempts.findForTask("foreign", 1), before);
    const archive = JSON.parse(String(f.tasks.database.get("SELECT summary FROM archived_attempts WHERE task = 'own'")!.summary));
    assert.equal(archive.archivedBy, "supervisor:goal");
    assert.ok(Object.values(archive.cleanup).flat().every((entry: unknown) => (entry as { askedBy: string }).askedBy === "supervisor:goal"));
    assert.equal((await prune(f.deps, { olderThan: 0.000000001 })).reason, "pruned");
    assert.equal(f.deps.attempts.findForTask("foreign", 1), undefined);
  } finally { f.tasks.close(); }
});

test("revoking dispatch during acquisition is checked again before task start or launch", async () => {
  const f = await objectiveFixture();
  try {
    let launches = 0;
    const workspaces = Object.assign(Object.create(Object.getPrototypeOf(f.deps.workspaces)), f.deps.workspaces, {
      acquire: async (...args: Parameters<typeof f.deps.workspaces.acquire>) => {
        const allocation = await f.deps.workspaces.acquire(...args);
        await f.objectives.update("goal", { permissions: { ...defaultPermissions, dispatch: false } });
        return allocation;
      },
    });
    const result = await dispatchOnce({ ...f.supervisor, workspaces, launch: async () => { launches++; throw new Error("Not permitted"); } }, { taskId: "own" });
    denied(result, "permission_denied.*dispatch");
    assert.equal(launches, 0);
    assert.equal((await f.tasks.read("own"))!.state, "queued");
    assert.equal(f.supervisor.attempts.findForTask("own", 1)!.entries.some(entry => entry.kind === "launched" || entry.kind === "task_started"), false);
    assert.equal((await f.deps.workspaces.leases()).length, 1, "A permission change does not authorise returning the acquired lease");
  } finally { f.tasks.close(); }
});

test("reconciling a lease-return effect cannot substitute for a person's confirmation", async () => {
  const f = await objectiveFixture();
  try {
    const { ref, leaseId } = await output(f);
    const returnId = randomUUID();
    await f.deps.attempts.appendConfirmed(ref, "lease_return_started", { leaseId, by: "finish", returnId }, { fact: "no_processes", scope: { leaseId, returnId } });
    await f.deps.attempts.append(ref, "owner_read_failed", { owner: "Treehouse", classification: "effect_uncertain", operation: "finish", step: "read return", failedAt: new Date().toISOString(), diagnostics: { message: "Read failed" } });
    const failureSequence = f.deps.attempts.findForTask("own", 1)!.entries.at(-1)!.sequence;
    const before = rows(f);
    denied(await resolveReadFailure(f.supervisor, { leaseId, failureSequence, outcome: "not_happened", note: "Inspected the lease" }), "person_required");
    assert.deepEqual(rows(f), before);
    assert.equal((await resolveReadFailure(f.deps, { leaseId, failureSequence, outcome: "not_happened", note: "The lease remains listed" })).reason, "resolved");
  } finally { f.tasks.close(); }
});

test("the CLI identifies the operating-system person even when USER and USERNAME claim someone else", async () => {
  const f = await objectiveFixture();
  try {
    const result = spawnSync(process.execPath, [resolve("src/cli.ts"), "objective", "add", "cli-goal", "A person's request", "--criterion", "Done", "--config", f.config, "--json"], { encoding: "utf8", env: { ...process.env, USER: "forged", USERNAME: "forged" } });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(JSON.parse(result.stdout).objective.createdBy, `operator:${userInfo().username}`);
  } finally { f.tasks.close(); }
});
