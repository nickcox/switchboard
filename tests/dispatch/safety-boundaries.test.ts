import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { dispatchOnce, type Dependencies } from "../../src/dispatch/dispatch.ts";
import { discard, finish } from "../../src/dispatch/finish.ts";
import { prune } from "../../src/dispatch/prune.ts";
import { onPath } from "../../src/infra/executables.ts";
import type { WorkspaceProvider } from "../../src/workspaces/provider.ts";
import { attemptsWith, fixture, task } from "./fixture.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const workspacesWith = (f: Fixture, overrides: Partial<WorkspaceProvider>): WorkspaceProvider => ({
  acquire: request => f.deps.workspaces.acquire(request), leases: () => f.deps.workspaces.leases(), pool: () => f.deps.workspaces.pool(),
  recyclableRoots: () => f.deps.workspaces.recyclableRoots(), returnLease: (lease, options) => f.deps.workspaces.returnLease(lease, options), ...overrides,
});

test("finish rechecks the recorded task outcome immediately before returning the lease", async () => {
  const f = await fixture({ tasks: [task("boundary-a1")], scenario: "commit-result" });
  const leaseId = (await dispatchOnce(f.deps)).attempt!.leaseId!;
  let returns = 0;
  const attempts = attemptsWith(f, { appendConfirmed: async (...args) => {
    await f.deps.attempts.appendConfirmed(...args);
    if (args[1] === "lease_return_started") await f.tasks.reopen("boundary-a1");
  } });
  const outcome = await finish({ ...f.deps, attempts, workspaces: workspacesWith(f, { returnLease: async () => { returns += 1; } }) }, { leaseId, noProcesses: true });
  assert.equal(outcome.reason, "stopped");
  assert.match(outcome.detail ?? "", /recorded as done/);
  assert.equal(returns, 0);
  assert.ok((await f.deps.workspaces.leases()).some(l => l.leaseId === leaseId));
});

test("discard rechecks worker evidence after recording its return intent", async () => {
  const f = await fixture({ tasks: [task("boundary-a1")], scenario: "commit-result" });
  const leaseId = (await dispatchOnce(f.deps)).attempt!.leaseId!;
  let uncertain = false, returns = 0;
  const discover = f.runtime.discover.bind(f.runtime);
  f.runtime.discover = async (...args) => (await discover(...args)).map(record => uncertain ? { ...record, child: { status: "unknown" } } : record);
  const attempts = attemptsWith(f, { appendConfirmed: async (...args) => {
    await f.deps.attempts.appendConfirmed(...args);
    if (args[1] === "lease_return_started") uncertain = true;
  } });
  const outcome = await discard({ ...f.deps, attempts, workspaces: workspacesWith(f, { returnLease: async () => { returns += 1; } }) }, { leaseId, noProcesses: true, confirm: true });
  assert.equal(outcome.reason, "stopped");
  assert.match(outcome.detail ?? "", /may still be running/);
  assert.equal(returns, 0);
});

test("integration refuses owner uncertainty that appeared after planning", async () => {
  const f = await fixture({ tasks: [task("boundary-a1")], scenario: "commit-result" });
  const leaseId = (await dispatchOnce(f.deps)).attempt!.leaseId!;
  const before = f.run(["rev-parse", "main"]);
  let retentionChecks = 0, unavailable = false;
  const deps: Dependencies = { ...f.deps,
    policy: { git: onPath("git"), environment: f.environment, repository: f.deps.repository, baseRef: "main", globalFile: join(f.dir, "no-policy.json"), context: { kind: "local-merge" } },
    retention: async request => { if (++retentionChecks === 2) unavailable = true; return f.deps.retention(request); },
    workspaces: workspacesWith(f, { leases: async () => { if (unavailable) throw new Error("inventory offline"); return f.deps.workspaces.leases(); } }),
  };
  const outcome = await finish(deps, { leaseId, noProcesses: true });
  assert.equal(outcome.reason, "refused");
  assert.match(outcome.detail ?? "", /inventory offline/);
  assert.equal(f.run(["rev-parse", "main"]), before);
  assert.notEqual((await f.tasks.read("boundary-a1"))?.state, "done");
});

test("prune rechecks shared lease evidence rather than trusting its plan", async () => {
  const f = await fixture({ tasks: [task("boundary-a1")] });
  const ref = await f.deps.attempts.create("boundary-a1", {}, 0);
  await f.deps.attempts.append(ref, "halted", { stage: "acquire", reason: "rejected" });
  let listings = 0;
  const outcome = await prune({ ...f.deps, workspaces: workspacesWith(f, { leases: async () => ++listings === 1 ? [] : [{ leaseId: "new-lease", holder: "boundary-a1", path: f.dir, branch: "other-output" }] }) }, { olderThan: 0.000000001 });
  assert.equal(outcome.reason, "pruned");
  assert.deepEqual(outcome.observed.removed, []);
  assert.deepEqual(outcome.observed.skipped, [{ taskId: "boundary-a1", attempt: 1, reason: "lease_held" }]);
  assert.equal(f.deps.attempts.list().length, 1);
});

test("database operations reject an attempt that changed while the command was waiting", async () => {
  const f = await fixture({ tasks: [task("boundary-a1")] });
  const ref = await f.deps.attempts.create("boundary-a1", {}, 0);
  await f.deps.attempts.append(ref, "halted", { stage: "acquire", reason: "rejected" });
  const snapshot = f.deps.attempts.read(ref);
  const expectedTask = (await f.tasks.read("boundary-a1"))!;
  await f.deps.attempts.append(ref, "integrated", { policy: "local-merge", targetBranch: "main", commit: "a".repeat(40) });
  await assert.rejects(f.deps.attempts.finishAttempt(ref, expectedTask, snapshot), { reason: "attempt_changed" });
  await assert.rejects(f.deps.attempts.discardAttempt(ref, expectedTask, "operator", "lease", undefined, snapshot), { reason: "attempt_changed" });
  await assert.rejects(f.deps.attempts.appendConfirmed(ref, "output_accepted", { commit: "a".repeat(40) }, { fact: "output_accepted", scope: { commit: "a".repeat(40) } }, "operator", snapshot), { reason: "attempt_changed" });
  assert.equal((await f.tasks.read("boundary-a1"))?.state, "queued");
  assert.deepEqual(f.deps.attempts.confirmations(ref), []);
});

test("archiving rechecks the task inside the transaction as well as the attempt snapshot", async () => {
  const f = await fixture({ tasks: [task("boundary-a1")] });
  const ref = await f.deps.attempts.create("boundary-a1", {}, 0);
  await f.deps.attempts.append(ref, "halted", { stage: "acquire", reason: "rejected" });
  const expectedTask = (await f.tasks.read("boundary-a1"))!;
  await f.tasks.hold("boundary-a1", "operator decision");
  await assert.rejects(f.deps.attempts.archiveAttempt(f.deps.attempts.read(ref), {}, [], expectedTask), { reason: "task_changed" });
  assert.equal(f.deps.attempts.list().length, 1);
});
