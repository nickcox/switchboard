import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createDependencies, loadConfig } from "../../src/config.ts";
import { dispatchOnce, type Dependencies } from "../../src/dispatch/dispatch.ts";
import { status } from "../../src/dispatch/status.ts";
import type { TaskStore } from "../../src/tasks/store.ts";
import { fixture, task } from "./fixture.ts";

// Phase 1 review findings 9–15 (docs/phases/01-basic-dispatch/review-2026-10-20.md).

type Fixture = Awaited<ReturnType<typeof fixture>>;
const tasksWith = (f: Fixture, overrides: Partial<TaskStore>): TaskStore => {
  const real = f.tasks;
  return {
    ready: () => real.ready(), inFlight: () => real.inFlight(), read: id => real.read(id), start: id => real.start(id),
    recordDone: (id, note) => real.recordDone(id, note), recordHold: (id, hold) => real.recordHold(id, hold), ...overrides,
  };
};
const workspacesWith = (f: Fixture, overrides: Partial<Dependencies["workspaces"]>): Dependencies["workspaces"] => ({
  acquire: request => f.deps.workspaces.acquire(request), leases: () => f.deps.workspaces.leases(),
  pool: () => f.deps.workspaces.pool(), recyclableRoots: () => f.deps.workspaces.recyclableRoots(),
  returnLease: (lease, options) => f.deps.workspaces.returnLease(lease, options), ...overrides,
});
const delivery = { baseRef: "main", startingCommit: "a".repeat(40), outputBranch: "o", kind: "code" as const, acceptance: "review_or_integration" as const, requiredEvidence: [], requiredDeliverables: [] };

for (const done of [true, false]) {
  test(`finding 9: an uncertain ${done ? "done" : "hold"} update that left out its evidence is not confirmed`, async () => {
    const f = await fixture({ tasks: [task("note-a1")], scenario: "commit-result", acceptance: done ? "independent_deliverable" : "review_or_integration" });
    // The state change applies, but the note or body carrying the attempt's evidence does not.
    const tasks = tasksWith(f, {
      recordDone: async id => { f.tasksCli(["done", id, "--no-prune"]); throw new Error("note not written"); },
      recordHold: async (id, hold) => { f.tasksCli(["hold", id, "--reason", hold.reason]); f.tasksCli(["reopen", id]); throw new Error("body not written"); },
    });
    const outcome = await dispatchOnce({ ...f.deps, tasks });
    assert.equal(outcome.reason, "stopped");
    assert.equal(outcome.nextAction.code, "complete_task_update");
    assert.ok(!(await f.deps.attempts.forTask("note-a1"))[0]!.entries.some(e => e.kind === "task_recorded"));
  });
}

test("finding 10: a repeated request reports each owner's current state, not the log's history", async () => {
  const f = await fixture({ tasks: [task("repeat-a1")], scenario: "commit-result" });
  assert.equal((await dispatchOnce(f.deps, { requestId: "repeat" })).lease, "preserved");
  assert.equal((await dispatchOnce(f.deps, { requestId: "repeat" })).lease, "preserved");
  const returned = await dispatchOnce({ ...f.deps, workspaces: workspacesWith(f, { leases: async () => [] }) }, { requestId: "repeat" });
  assert.equal(returned.reason, "existing_request");
  assert.equal(returned.lease, "none");
  const unreadable = await dispatchOnce({ ...f.deps, workspaces: workspacesWith(f, { leases: async () => { throw new Error("inventory offline"); } }) }, { requestId: "repeat" });
  assert.equal(unreadable.lease, "unknown");
  const moved = await dispatchOnce({ ...f.deps, workspaces: workspacesWith(f, { pool: async () => "another pool", leases: async () => [] }) }, { requestId: "repeat" });
  assert.equal(moved.lease, "unknown");
});

test("finding 11: an observed child exit is not overridden by a missing worker_finished entry", async () => {
  const f = await fixture({ tasks: [task("exit-a1"), task("next-b1")], scenario: "commit-result" });
  // As left by a dispatcher killed after the runtime recorded the exit and before it logged worker_finished.
  const workspace = join(f.dir, "exit-workspace");
  mkdirSync(workspace);
  const sessionId = randomUUID();
  const ref = await f.deps.attempts.create("exit-a1", {}, 0);
  await f.deps.attempts.append(ref, "leased", { leaseId: "lease-exit", workspace, baseRef: "main", outputBranch: "o", startingCommit: "a".repeat(40) });
  await f.deps.attempts.append(ref, "task_started", {});
  await f.deps.attempts.append(ref, "launched", { sessionId });
  const reserved = await f.runtime.reserve({ identity: { contextId: "fixture-context", taskId: "exit-a1", leaseId: "lease-exit", sessionId }, workspace, instructions: "Earlier", acceptanceCriteria: [], delivery });
  await f.runtime.recordChildExit(reserved, { started: true, code: 0, signal: null });

  const next = await dispatchOnce(f.deps);
  assert.equal(next.attempt?.taskId, "next-b1", JSON.stringify(next));
  assert.equal((await dispatchOnce(f.deps, { taskId: "exit-a1", dryRun: true })).reason, "refused");
});

test("finding 12: status asks for attention when an attempt's task cannot be read", async () => {
  const f = await fixture({ tasks: [task("unread-a1")] });
  const ref = await f.deps.attempts.create("unread-a1", {}, 0);
  await f.deps.attempts.append(ref, "halted", { stage: "acquire", reason: "stopped", detail: "refused" });
  const view = await status({ ...f.deps, tasks: tasksWith(f, { read: async () => { throw new Error("store offline"); } }) });
  assert.equal(view.attempts[0]?.task, "unreadable");
  assert.equal(view.reason, "attention");
  assert.notEqual(view.attempts[0]?.nextAction.code, "none");
});

test("finding 12: status asks for attention when a task is in flight with no attempt, worker or lease", async () => {
  const f = await fixture({ tasks: [task("orphan-a1")] });
  f.tasksCli(["start", "orphan-a1"]);
  const view = await status(f.deps);
  assert.equal(view.reason, "attention");
  assert.deepEqual(view.orphanedInFlight, ["orphan-a1"]);
});

test("finding 13: take-over advice needs the lease to be still held, and quotes its paths", async () => {
  const f = await fixture({ tasks: [task("takeover-a1")], scenario: "commit-result" });
  await dispatchOnce(f.deps);
  const held = (await status(f.deps)).attempts[0]!;
  assert.ok(held.takeover);
  const sessions = (await f.runtime.discover("fixture-context"))[0]!.binding.sessionDirectory;
  assert.ok(held.takeover.includes(process.platform === "win32" ? `"${sessions}"` : `'${sessions}'`), held.takeover);
  const returned = (await status({ ...f.deps, workspaces: workspacesWith(f, { leases: async () => [] }) })).attempts[0]!;
  assert.equal(returned.takeover, undefined);
});

test("finding 14: a missing Pi entrypoint is refused when the configuration is loaded, before any dispatch", async () => {
  const f = await fixture({ tasks: [task("entry-a1")] });
  const config = await loadConfig(f.config);
  config.worker.piEntrypoint = join(f.dir, "missing-pi.js");
  await assert.rejects(createDependencies(config), /Pi entrypoint/);
  assert.deepEqual(await f.deps.attempts.list(), []);
});

test("finding 15: an attempt-log failure after acquiring a lease gives a structured stopped result", async () => {
  const f = await fixture({ tasks: [task("journal-a1")], scenario: "commit-result" });
  const attempts = Object.assign(Object.create(Object.getPrototypeOf(f.deps.attempts)), f.deps.attempts, {
    append: async (...args: Parameters<Dependencies["attempts"]["append"]>) => {
      if (args[1] === "task_started") throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return f.deps.attempts.append(...args);
    },
  });
  const outcome = await dispatchOnce({ ...f.deps, attempts });
  assert.equal(outcome.reason, "stopped");
  assert.equal(outcome.lease, "preserved");
  assert.equal(outcome.stage, "start");
  assert.match(outcome.detail ?? "", /disk full/);
  assert.ok(outcome.attempt?.leaseId);
});
