import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dispatchOnce, type Dependencies } from "../../src/dispatch/dispatch.ts";
import { prune } from "../../src/dispatch/prune.ts";
import { resolveLeaseReturned, resolveStopped } from "../../src/dispatch/resolve.ts";
import { describeCommand } from "../../src/infra/command.ts";
import { WorkspaceError } from "../../src/workspaces/provider.ts";
import { specificationFor } from "../helpers.ts";
import { attemptsWith, fixture, task } from "./fixture.ts";

const diagnostic = { exitCode: 23, stdout: "owner output", stderr: "owner error", timedOut: false, truncated: false };
const failure = () => new WorkspaceError("unreadable", "Injected owner read", describeCommand(diagnostic));
const clone = <T extends object>(value: T): T => Object.assign(Object.create(Object.getPrototypeOf(value)), value);
type Owner = "records" | "runtime" | "leases" | "pool" | "task" | "heartbeat";

function inject(deps: Dependencies, owner: Owner, fail: () => void): Dependencies {
  const workspaces = clone(deps.workspaces), runtime = clone(deps.runtime), tasks = clone(deps.tasks);
  const attempts = attemptsWith({ deps }, {});
  if (owner === "records") {
    attempts.list = () => { fail(); return deps.attempts.list(); };
    attempts.findByLease = async id => { fail(); return deps.attempts.findByLease(id); };
    attempts.findForTask = (...args) => { fail(); return deps.attempts.findForTask(...args); };
  }
  if (owner === "runtime") runtime.discover = async (...args) => { fail(); return deps.runtime.discover(...args); };
  if (owner === "leases") workspaces.leases = async () => { fail(); return deps.workspaces.leases(); };
  if (owner === "pool") workspaces.pool = async () => { fail(); return deps.workspaces.pool(); };
  if (owner === "task") tasks.read = async id => { fail(); return deps.tasks.read(id); };
  if (owner === "heartbeat") {
    runtime.discover = async (...args) => (await deps.runtime.discover(...args)).map(record => {
      const storage = clone(record.storage);
      storage.heartbeat = async id => { fail(); return record.storage.heartbeat(id); };
      return { ...record, storage };
    });
  }
  return { ...deps, attempts, runtime, workspaces, tasks };
}

function checkDiagnostic(value: Record<string, unknown>, classification: string, operation: string) {
  assert.equal(value.classification, classification);
  assert.equal(value.operation, operation);
  assert.deepEqual((value.diagnostics as { command: unknown }).command, diagnostic);
}

for (const owner of ["records", "runtime", "leases", "pool", "task"] as const) {
  test(`dispatch: ${owner} preflight failure keeps diagnostics without reserving or acquiring`, async () => {
    const f = await fixture({ tasks: [task("reads-a1")], scenario: "commit-result" });
    let pending = true, acquisitions = 0;
    const deps = inject(f.deps, owner, () => { if (pending) { pending = false; throw failure(); } });
    deps.workspaces.acquire = async request => { acquisitions++; return f.deps.workspaces.acquire(request); };
    const first = await dispatchOnce(deps);
    assert.equal(first.reason, "owner_read_retryable", first.detail ?? "");
    assert.equal(first.lease, "none");
    checkDiagnostic(first.observed.readFailure as Record<string, unknown>, "owner_read", "dispatch");
    assert.equal(acquisitions, 0);
    assert.deepEqual(f.deps.attempts.list(), []);
    assert.equal((await dispatchOnce(deps)).reason, "held");
    assert.equal(acquisitions, 1);
  });
}

test("dispatch keeps every failed preflight command when no attempt exists to record them", async () => {
  const f = await fixture({ tasks: [task("reads-a1")] });
  const workspaces = clone(f.deps.workspaces);
  workspaces.leases = async () => { throw failure(); };
  workspaces.pool = async () => { throw failure(); };
  const first = await dispatchOnce({ ...f.deps, workspaces });
  assert.equal(first.reason, "owner_read_retryable");
  const failures = first.observed.readFailures as Record<string, unknown>[];
  assert.equal(failures.length, 2);
  for (const failed of failures) checkDiagnostic(failed, "owner_read", "dispatch");
  assert.deepEqual(f.deps.attempts.list(), []);
});

for (const method of ["ready", "inFlight"] as const) {
  test(`dispatch: task ${method} failure is retryable before reservation`, async () => {
    const f = await fixture({ tasks: [task("reads-a1")] });
    const tasks = clone(f.deps.tasks);
    tasks[method] = async () => { throw failure(); };
    const first = await dispatchOnce({ ...f.deps, tasks });
    assert.equal(first.reason, "owner_read_retryable", first.detail ?? "");
    checkDiagnostic(first.observed.readFailure as Record<string, unknown>, "owner_read", "dispatch");
    assert.deepEqual(f.deps.attempts.list(), []);
  });
}

for (const point of ["intent", "acquired"] as const) {
  for (const owner of ["Treehouse leases", "Git workspace pool", "Git workspace"] as const) {
    test(`dispatch: ${owner} failure after acquisition ${point} never acquires again`, async () => {
      const f = await fixture({ tasks: [task("reads-a1")] });
      const workspaces = clone(f.deps.workspaces);
      let acquisitions = 0, launches = 0;
      workspaces.acquire = async request => {
        acquisitions++;
        if (point === "acquired") await f.deps.workspaces.acquire(request);
        throw new WorkspaceError("outcome_unknown", "Acquisition read-back failed", undefined, { owner, error: failure() });
      };
      const deps = { ...f.deps, workspaces, launch: async (...args: Parameters<Dependencies["launch"]>) => { launches++; return f.deps.launch(...args); } };
      const first = await dispatchOnce(deps, { requestId: "read-request" });
      assert.equal(first.reason, "reconciliation_required", first.detail ?? "");
      assert.equal(acquisitions, 1);
      assert.equal(launches, 0);
      const record = f.deps.attempts.list()[0]!;
      assert.equal(record.entries.filter(e => e.kind === "requested").length, 1);
      const failed = record.entries.find(e => e.kind === "owner_read_failed")!;
      checkDiagnostic(failed.data, "effect_uncertain", "dispatch");
      assert.equal(failed.data.owner, owner);
      await dispatchOnce(deps, { requestId: "read-request" });
      await dispatchOnce(deps);
      assert.equal(acquisitions, 1);
      assert.equal((await f.deps.workspaces.leases()).length, point === "acquired" ? 1 : 0);
    });
  }
}

test("dispatch: an attempt read after acquisition intent is uncertain and never reaches the provider", async () => {
  const f = await fixture({ tasks: [task("reads-a1")] });
  let pending = true;
  const attempts = attemptsWith(f, { read: ref => {
    const record = f.deps.attempts.read(ref);
    if (pending && record.entries.some(e => e.kind === "requested")) { pending = false; throw failure(); }
    return record;
  } });
  const workspaces = clone(f.deps.workspaces);
  workspaces.acquire = async () => assert.fail("No acquisition after an uncertain read");
  const first = await dispatchOnce({ ...f.deps, attempts, workspaces });
  assert.equal(first.reason, "reconciliation_required", first.detail ?? "");
  checkDiagnostic(f.deps.attempts.list()[0]!.entries.at(-1)!.data, "effect_uncertain", "dispatch");
});

for (const owner of ["runtime", "retention", "roots", "launch inputs"] as const) {
  test(`dispatch: ${owner} read after acquisition preserves the lease and refuses reconciliation`, async () => {
    const f = await fixture({ tasks: [task("reads-a1")], scenario: "commit-result" });
    let acquired = false;
    const workspaces = clone(f.deps.workspaces), runtime = clone(f.deps.runtime);
    workspaces.acquire = async request => { const allocation = await f.deps.workspaces.acquire(request); acquired = true; return allocation; };
    if (owner === "roots") workspaces.recyclableRoots = async () => { if (acquired) throw failure(); return f.deps.workspaces.recyclableRoots(); };
    if (owner === "runtime") runtime.discover = async (...args) => { if (acquired) throw failure(); return f.deps.runtime.discover(...args); };
    const attempts = attemptsWith(f, { read: ref => {
      const record = f.deps.attempts.read(ref);
      if (owner === "launch inputs" && record.entries.some(e => e.kind === "task_started")) throw failure();
      return record;
    } });
    const deps = { ...f.deps, attempts, workspaces, runtime, retention: owner === "retention" ? async () => { throw failure(); } : f.deps.retention };
    const first = await dispatchOnce(deps);
    assert.equal(first.reason, "reconciliation_required", first.detail ?? "");
    assert.equal(first.lease, "preserved");
    checkDiagnostic(first.observed.readFailure as Record<string, unknown>, "effect_uncertain", "dispatch");
    assert.equal((await f.deps.workspaces.leases()).length, 1);
  });
}

async function orphan() {
  const f = await fixture({ tasks: [task("reads-a1")] });
  const ref = await f.deps.attempts.create("reads-a1", {}, 0);
  const leaseId = "orphan-lease", sessionId = randomUUID();
  const startingCommit = f.run(["rev-parse", "main"]);
  const workspace = join(f.dir, "orphan-workspace");
  await mkdir(workspace);
  await f.deps.attempts.append(ref, "leased", { leaseId, workspace, outputBranch: "output", baseRef: "main", startingCommit, pool: "old-pool" });
  await f.deps.attempts.append(ref, "launched", { sessionId });
  const reserved = await f.deps.runtime.reserve({ identity: { contextId: f.deps.contextId, taskId: ref.taskId, leaseId, sessionId }, workspace,
    instructions: "No process is launched", acceptanceCriteria: [], delivery: { ...f.deps.delivery.default, baseRef: "main", outputBranch: "output", startingCommit } });
  await reserved.storage.releaseClaim(reserved.claimId);
  return { ...f, ref, leaseId };
}

for (const action of ["stopped", "returned"] as const) {
  for (const point of ["before", "intent", "effect"] as const) {
    for (const owner of ["records", "runtime", "leases", "pool", "task", "heartbeat"] as const) {
      test(`resolve ${action}: ${owner} read ${point} keeps its classification and diagnostics`, async () => {
        const f = await orphan();
        if (action === "returned") {
          await f.deps.attempts.appendConfirmed(f.ref, "operator_resolved", { action: "worker_stopped" },
            { fact: "worker_stopped", scope: { leaseId: f.leaseId } }, "operator:fixture");
        }
        if (point === "intent") {
          const returnId = randomUUID();
          await f.deps.attempts.appendConfirmed(f.ref, "lease_return_started", { leaseId: f.leaseId, by: "finish", returnId },
            { fact: "no_processes", scope: { leaseId: f.leaseId, returnId } }, "operator:fixture");
        }
        let pending = true;
        const deps = inject(f.deps, owner, () => {
          const record = f.deps.attempts.read(f.ref);
          const applied = record.entries.some(e => e.kind === "operator_resolved" && e.data.action === (action === "stopped" ? "worker_stopped" : "lease_returned"));
          if (pending && (point !== "effect" || applied)) { pending = false; throw failure(); }
        });
        const run = () => action === "stopped" ? resolveStopped(deps, { leaseId: f.leaseId, confirmed: true }) : resolveLeaseReturned(deps, { leaseId: f.leaseId });
        const first = await run();
        assert.equal(first.reason, point === "before" ? "owner_read_retryable" : "reconciliation_required", first.detail ?? "");
        const record = f.deps.attempts.read(f.ref);
        checkDiagnostic(record.entries.find(e => e.kind === "owner_read_failed")!.data, point === "before" ? "owner_read" : "effect_uncertain", "resolve");
        if (point === "effect") {
          await run();
          assert.equal(f.deps.attempts.read(f.ref).entries.filter(e => e.kind === "operator_resolved" && e.data.action === (action === "stopped" ? "worker_stopped" : "lease_returned")).length, 1);
        }
      });
    }
  }
}

async function settled() {
  const f = await fixture({ tasks: [task("reads-a1")] });
  const ref = (await f.deps.attempts.reserveAttempt({ taskId: "reads-a1", requested: { requestId: "cleanup" }, maximum: 1, specification: specificationFor })).ref;
  await f.deps.attempts.append(ref, "halted", { stage: "acquire", reason: "rejected" });
  return { ...f, ref };
}

for (const owner of ["records", "runtime", "leases", "pool", "task"] as const) {
  for (const recheck of [false, true]) {
    test(`prune: ${owner} failure ${recheck ? "at archive recheck" : "before effects"} preserves the attempt`, async () => {
      const f = await settled();
      let reads = 0;
      const deps = inject(f.deps, owner, () => { if (++reads === (recheck ? 2 : 1)) throw failure(); });
      const first = await prune(deps, { olderThan: 0.000000001 });
      assert.equal(first.reason, "owner_read_retryable", first.detail ?? "");
      assert.equal(f.deps.attempts.list().length, 1);
      checkDiagnostic(first.observed.readFailure as Record<string, unknown>, "owner_read", "prune");
      if (owner !== "records" || recheck) checkDiagnostic(f.deps.attempts.read(f.ref).entries.at(-1)!.data, "owner_read", "prune");
      assert.equal(f.deps.attempts.pendingDeletions().length, 0);
    });
  }
}

for (const point of ["before", "intent", "effect"] as const) {
  test(`prune: directory read ${point} deletion is recorded durably and never repeats an uncertain removal`, async () => {
    const f = await settled();
    const directory = join(f.dir, "runtime", "cleanup-directory");
    await mkdir(directory, { recursive: true });
    await f.deps.attempts.archiveAttempt(f.deps.attempts.read(f.ref), {}, [directory]);
    const deletion = f.deps.attempts.pendingDeletions()[0]!;
    let pending = true, removals = 0;
    const runtime = clone(f.deps.runtime);
    runtime.owns = async path => {
      const started = f.deps.attempts.cleanupEntries(deletion).some(e => e.kind === "deletion_started");
      if (pending && (point === "before" || point === "intent" && started)) { pending = false; throw failure(); }
      return f.deps.runtime.owns(path);
    };
    const files = { rm: async (...args: Parameters<typeof rm>) => { removals++; return rm(...args); }, lstat: (async (...args: Parameters<typeof lstat>) => {
      if (pending && point === "effect" && removals) { pending = false; throw failure(); }
      return lstat(...args);
    }) as typeof lstat };
    const first = await prune({ ...f.deps, runtime }, { olderThan: 1 }, files);
    assert.equal(first.reason, point === "before" ? "owner_read_retryable" : "reconciliation_required", first.detail ?? "");
    assert.equal(f.deps.attempts.pendingDeletions().length, 1);
    const failed = f.deps.attempts.cleanupEntries(deletion).find(e => e.kind === "owner_read_failed")!;
    checkDiagnostic(failed.data, point === "before" ? "owner_read" : "effect_uncertain", "prune");
    const second = await prune(f.deps, { olderThan: 1 }, files);
    if (point === "intent") {
      assert.equal(second.reason, "reconciliation_required", second.detail ?? "");
      assert.equal(removals, 0);
      // The operator settles an uncertain deletion by inspecting and removing its directory, not by repeating prune's effect.
      await rm(directory, { recursive: true });
      assert.equal((await prune(f.deps, { olderThan: 1 }, files)).reason, "pruned");
    } else assert.equal(second.reason, "pruned", second.detail ?? "");
    assert.equal(removals, point === "intent" ? 0 : 1);
    await assert.rejects(stat(directory), { code: "ENOENT" });
    assert.deepEqual(f.deps.attempts.pendingDeletions(), []);
    const archive = await f.deps.attempts.findByRequest("cleanup");
    assert.ok(archive && "archived" in archive && archive.summary.cleanup);
    const confirmed = f.deps.attempts.cleanupEntries(deletion).find(e => e.kind === "deletion_confirmed")!;
    assert.ok(confirmed);
    if (point !== "before") assert.ok((confirmed.data.failureSequences as number[]).includes(failed.sequence));
  });
}

for (const owner of ["records", "runtime", "leases", "pool", "task"] as const) {
  test(`prune: ${owner} read after an archive requires reconciliation and keeps remaining records`, async () => {
    const f = await settled();
    await f.tasks.add({ id: "reads-b1", title: "Second", repo: "fixture" });
    const second = (await f.deps.attempts.reserveAttempt({ taskId: "reads-b1", requested: {}, maximum: 1, specification: specificationFor })).ref;
    await f.deps.attempts.append(second, "halted", { stage: "acquire", reason: "rejected" });
    let archived = false, pending = true;
    const deps = inject(f.deps, owner, () => {
      if (archived && pending) { pending = false; throw failure(); }
    });
    deps.attempts.archiveAttempt = async (...args) => { await f.deps.attempts.archiveAttempt(...args); archived = true; };
    const first = await prune(deps, { olderThan: 0.000000001 });
    assert.equal(first.reason, "reconciliation_required", first.detail ?? "");
    assert.equal((first.observed.removed as unknown[]).length, 1);
    assert.equal(f.deps.attempts.list().length, 1);
    checkDiagnostic(f.deps.attempts.read(second).entries.at(-1)!.data, "effect_uncertain", "prune");
    assert.equal((await prune(f.deps, { olderThan: 0.000000001 })).reason, "reconciliation_required");
    assert.equal((await prune(f.deps, { olderThan: 0.000000001, dryRun: true })).reason, "reconciliation_required");
    assert.equal(f.deps.attempts.list().length, 1);
  });
}
