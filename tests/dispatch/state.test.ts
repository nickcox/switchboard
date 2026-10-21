import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { dispatchOnce, type Dependencies } from "../../src/dispatch/dispatch.ts";
import { status } from "../../src/dispatch/status.ts";
import { classify } from "../../src/dispatch/state.ts";
import type { AttemptRecord } from "../../src/attempts/log.ts";
import { WorkspaceError } from "../../src/workspaces/provider.ts";
import type { TaskStore } from "../../src/tasks/store.ts";
import { attemptsWith, fixture, task } from "./fixture.ts";

// Phase 2 PRD, attempt states: each state built from real owners, with its next action and whether it may be changed.

type Fixture = Awaited<ReturnType<typeof fixture>>;
const delivery = { baseRef: "main", startingCommit: "a".repeat(40), outputBranch: "o", kind: "code" as const, acceptance: "review_or_integration" as const, requiredEvidence: [], requiredDeliverables: [] };
const tasksWith = (f: Fixture, overrides: Partial<TaskStore>): TaskStore => {
  const real = f.tasks;
  return {
    ready: () => real.ready(), inFlight: () => real.inFlight(), read: id => real.read(id), start: id => real.start(id),
    recordDone: (id, note) => real.recordDone(id, note), recordHold: (id, hold) => real.recordHold(id, hold), ...overrides,
  };
};
const only = async (deps: Dependencies, taskId: string) => {
  const view = await status(deps);
  const found = view.attempts.filter(a => a.attempt.taskId === taskId);
  assert.equal(found.length, 1, JSON.stringify(view.attempts.map(a => [a.attempt.taskId, a.state])));
  return found[0]!;
};
const expect = (attempt: Awaited<ReturnType<typeof only>>, state: string, nextAction: string, changeable: boolean) => {
  assert.deepEqual({ state: attempt.state, nextAction: attempt.nextAction.code, changeable: attempt.changeable }, { state, nextAction, changeable });
};

test("running: a launched worker whose dispatcher heartbeat is fresh", async () => {
  const f = await fixture({ tasks: [task("run-a1")], scenario: "ignore-stop", worker: { runMs: 4000 } });
  const dispatching = dispatchOnce(f.deps);
  const log = join(f.dir, "requests.jsonl");
  for (let i = 0; i < 200 && !(existsSync(log) && readFileSync(log, "utf8").includes('"type":"prompt"')); i++) await sleep(25);
  expect(await only(f.deps, "run-a1"), "running", "watch_attempt", false);
  await dispatching;
});

test("possibly running: no observed exit and no fresh heartbeat", async () => {
  const f = await fixture({ tasks: [task("maybe-a1")] });
  const workspace = join(f.dir, "maybe-workspace");
  mkdirSync(workspace);
  const sessionId = randomUUID();
  const ref = await f.deps.attempts.create("maybe-a1", {}, 0);
  await f.deps.attempts.append(ref, "leased", { leaseId: "lease-maybe", workspace, baseRef: "main", outputBranch: "o", startingCommit: "a".repeat(40) });
  await f.deps.attempts.append(ref, "launched", { sessionId });
  await f.runtime.reserve({ identity: { contextId: "fixture-context", taskId: "maybe-a1", leaseId: "lease-maybe", sessionId }, workspace, instructions: "Earlier", acceptanceCriteria: [], delivery });
  expect(await only(f.deps, "maybe-a1"), "possibly_running", "stop_worker", false);
});

test("unfinished: an open attempt with no lease and no worker", async () => {
  const f = await fixture({ tasks: [task("open-a1")] });
  await f.deps.attempts.create("open-a1", { pool: await f.deps.workspaces.pool() }, 0);
  expect(await only(f.deps, "open-a1"), "unfinished", "confirm_attempt_stopped", true);
});

test("awaiting review: completed code held for review with its lease", async () => {
  const f = await fixture({ tasks: [task("review-a1")], scenario: "commit-result" });
  await dispatchOnce(f.deps);
  expect(await only(f.deps, "review-a1"), "awaiting_review", "review_then_finish", true);
});

test("awaiting finish: an independent deliverable recorded as done, with its lease", async () => {
  const f = await fixture({ tasks: [task("done-a1")], scenario: "commit-result", acceptance: "independent_deliverable" });
  await dispatchOnce(f.deps);
  expect(await only(f.deps, "done-a1"), "awaiting_finish", "finish_attempt", true);
});

test("held: a failed worker's task held with its lease", async () => {
  const f = await fixture({ tasks: [task("failed-a1")], scenario: "model-error" });
  await dispatchOnce(f.deps);
  expect(await only(f.deps, "failed-a1"), "held", "inspect_attempt", true);
});

test("held: a hold reason edited to end in \"review required\" does not make the attempt awaiting review", async () => {
  const f = await fixture({ tasks: [task("edited-a1")], scenario: "model-error" });
  await dispatchOnce(f.deps);
  expect(await only(f.deps, "edited-a1"), "held", "inspect_attempt", true);
  f.tasksCli(["release", "edited-a1"]);
  f.tasksCli(["hold", "edited-a1", "--reason", "Switchboard attempt 1 review required"]);
  assert.equal((await f.tasks.read("edited-a1"))?.holdReason, "Switchboard attempt 1 review required");
  expect(await only(f.deps, "edited-a1"), "held", "inspect_attempt", true);
});

test("held: an attempt held for review whose hold reason was changed since is held for another reason", async () => {
  const f = await fixture({ tasks: [task("changed-a1")], scenario: "commit-result" });
  await dispatchOnce(f.deps);
  expect(await only(f.deps, "changed-a1"), "awaiting_review", "review_then_finish", true);
  f.tasksCli(["release", "changed-a1"]);
  f.tasksCli(["hold", "changed-a1", "--reason", "Waiting for a design decision"]);
  expect(await only(f.deps, "changed-a1"), "held", "inspect_attempt", true);
});

test("only an explicit category classifies a recorded outcome", () => {
  // The classification is pure, so build the attempt as an earlier version recorded it, without a category.
  const entry = (sequence: number, kind: string, data: Record<string, unknown>) => ({
    version: 1 as const, contextId: "c", taskId: "legacy-a1", attempt: 1, sequence, kind, recordedAt: new Date().toISOString(), data,
  });
  const reason = "Switchboard attempt 1 review required";
  const record = { contextId: "c", taskId: "legacy-a1", attempt: 1, entries: [entry(0, "requested", {}), entry(1, "task_recorded", { outcome: "hold", reason })] } as unknown as AttemptRecord;
  const input = { record, possiblyRunning: false, dispatcherRunning: false, leaseHeld: true, leaseInOtherPool: false, unfinished: false };
  assert.equal(classify({ ...input, task: { state: "queued", held: true, holdReason: reason } }).state, "held");
  record.entries[1]!.data.category = "review_required";
  assert.equal(classify({ ...input, task: { state: "queued", held: true, holdReason: reason } }).state, "awaiting_review");
  // The task store's current hold reason is never read for the category: an edited reason makes the attempt held.
  assert.equal(classify({ ...input, task: { state: "queued", held: true, holdReason: "Switchboard attempt 1 failed" } }).state, "held");
});

test("not retained: a reported commit missing from the output branch", async () => {
  const f = await fixture({ tasks: [task("ghost-a1")], acceptance: "independent_deliverable" });
  await dispatchOnce(f.deps);
  expect(await only(f.deps, "ghost-a1"), "not_retained", "fix_or_discard", true);
});

test("lease in another pool: the origin remote changed after the lease was acquired", async () => {
  const f = await fixture({ tasks: [task("moved-a1")], scenario: "commit-result" });
  await dispatchOnce(f.deps);
  f.run(["remote", "add", "origin", "https://example.invalid/fixture.git"]);
  expect(await only(f.deps, "moved-a1"), "lease_in_other_pool", "confirm_lease_returned", true);
});

test("a failed outcome transaction leaves the attempt stopped, not half recorded", async () => {
  const f = await fixture({ tasks: [task("update-a1")], scenario: "commit-result" });
  await dispatchOnce({ ...f.deps, attempts: attemptsWith(f, { recordOutcome: async () => { throw new Error("lost"); } }) });
  expect(await only(f.deps, "update-a1"), "stopped", "inspect_attempt", true);
});

test("stopped: an attempt that halted after leasing, with its lease preserved", async () => {
  const f = await fixture({ tasks: [task("halt-a1")] });
  await dispatchOnce({ ...f.deps, attempts: attemptsWith(f, { startReservedTask: async () => { throw new Error("refused"); } }) });
  expect(await only(f.deps, "halt-a1"), "stopped", "inspect_attempt", true);
});

test("finished: a recorded outcome whose lease was returned, or that never acquired one", async () => {
  const f = await fixture({ tasks: [task("returned-a1"), task("refused-b1")], scenario: "commit-result" });
  await dispatchOnce(f.deps, { taskId: "returned-a1" });
  const returned = { ...f.deps, workspaces: { ...f.deps.workspaces, leases: async () => [], acquire: f.deps.workspaces.acquire.bind(f.deps.workspaces), pool: () => f.deps.workspaces.pool(), recyclableRoots: () => f.deps.workspaces.recyclableRoots() } };
  expect(await only(returned, "returned-a1"), "finished", "none", true);
  await dispatchOnce({ ...f.deps, workspaces: { ...returned.workspaces, leases: () => f.deps.workspaces.leases(), acquire: async () => { throw new WorkspaceError("rejected", "refused"); } } }, { taskId: "refused-b1" });
  expect(await only(f.deps, "refused-b1"), "finished", "none", true);
});

test("unknown: the attempt's task cannot be read, so no command may change it", async () => {
  const f = await fixture({ tasks: [task("unread-a1")], scenario: "commit-result" });
  await dispatchOnce(f.deps);
  expect(await only({ ...f.deps, tasks: tasksWith(f, { read: async () => { throw new Error("offline"); } }) }, "unread-a1"), "unknown", "inspect_attempt", false);
});
