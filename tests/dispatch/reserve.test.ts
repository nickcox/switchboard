import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { reserveFromAttempt } from "../../src/dispatch/reserve.ts";
import { fixture, task } from "./fixture.ts";

const taskId = "continue-a1";
const options = { taskId, startingPoint: { taskId, attempt: 1 }, requestId: "continuation" };

async function completed() {
  const f = await fixture({ tasks: [task(taskId)], scenario: "commit-result" });
  const first = await dispatchOnce(f.deps, { taskId, requestId: "original" });
  assert.equal(first.retention?.retained, true);
  await f.tasks.release(taskId);
  return { ...f, first };
}

function records(f: Awaited<ReturnType<typeof fixture>>) {
  return ["attempts", "attempt_entries", "attempt_numbers", "request_records", "attempt_specifications", "launches", "confirmations"].map(t => f.tasks.database.all(`SELECT * FROM ${t}`));
}

test("continuation reserves the recorded validated commit despite the source's retained lease, without acquiring or launching", async () => {
  const f = await completed();
  try {
    const original = f.deps.attempts.findForTask(taskId, 1)!;
    const leases = await f.deps.workspaces.leases();
    const launches = f.tasks.database.all("SELECT * FROM launches");
    const ordinary = await dispatchOnce(f.deps, { taskId });
    assert.equal(ordinary.reason, "refused");
    f.deps.workspaces.acquire = async () => { throw new Error("Must not acquire"); };
    f.deps.launch = async () => { throw new Error("Must not launch"); };
    const reserved = await reserveFromAttempt(f.deps, options);
    assert.equal(reserved.reason, "reserved", JSON.stringify(reserved));
    assert.equal(reserved.attempt?.attempt, 2);
    const next = f.deps.attempts.findForTask(taskId, 2)!;
    assert.deepEqual(next.specification?.startingPoint, { ...options.startingPoint, commit: f.first.attempt!.resultCommit });
    assert.notEqual(next.entries[0]!.data.requestId, original.entries[0]!.data.requestId);
    assert.notEqual(next.specification?.outputBranch, original.specification?.outputBranch);
    assert.equal(next.allocation, undefined);
    assert.deepEqual(next.entries.map(e => e.kind), ["requested"]);
    assert.deepEqual(f.deps.attempts.read(original), original);
    assert.deepEqual(await f.deps.workspaces.leases(), leases);
    assert.deepEqual(f.tasks.database.all("SELECT * FROM launches"), launches);
    assert.equal((await f.tasks.read(taskId))?.state, "queued");
    const before = records(f);
    f.deps.workspaces.leases = async () => { throw new Error("Replay must not read external owners"); };
    assert.equal((await reserveFromAttempt(f.deps, options)).reason, "existing_request");
    assert.deepEqual(records(f), before);
    assert.equal((await reserveFromAttempt(f.deps, { ...options, startingPoint: { taskId, attempt: 2 } })).reason, "request_input_mismatch");
  } finally { f.tasks.close(); }
});

for (const kind of ["not retained", "unknown", "unknown pool", "wrong task", "missing attempt", "no recorded commit", "worker running"] as const) test(`continuation refuses ${kind} without recording or reserving anything`, async () => {
  const f = await completed();
  try {
    let request = options;
    const expected = { "not retained": "not_retained", unknown: "starting_point_unknown", "unknown pool": "starting_point_unknown", "wrong task": "starting_point_wrong_task", "missing attempt": "starting_point_unknown", "no recorded commit": "output_not_recorded", "worker running": "possibly_running" }[kind];
    if (kind === "not retained") f.run(["update-ref", "-d", `refs/heads/${f.first.attempt!.outputBranch}`]);
    if (kind === "unknown") f.deps.workspaces.leases = async () => { throw new Error("Treehouse unavailable"); };
    if (kind === "unknown pool") f.deps.workspaces.pool = async () => "another-pool";
    if (kind === "wrong task") request = { ...options, startingPoint: { taskId: "other", attempt: 1 } };
    if (kind === "missing attempt") request = { ...options, startingPoint: { taskId, attempt: 99 } };
    if (kind === "no recorded commit") await f.tasks.database.transaction(() => f.tasks.database.run("DELETE FROM worker_observations WHERE kind = 'validated_result'"));
    if (kind === "worker running") await f.tasks.database.transaction(() => f.tasks.database.run("DELETE FROM worker_observations WHERE kind = 'exit'"));
    const before = records(f);
    const outcome = await reserveFromAttempt(f.deps, request);
    assert.equal(outcome.ok, false, JSON.stringify(outcome));
    assert.equal(outcome.observed.reason, expected, JSON.stringify(outcome));
    assert.notEqual(outcome.nextAction.code, "none");
    assert.deepEqual(records(f), before);
    assert.equal(await f.deps.attempts.findByRequest(options.requestId), undefined);
  } finally { f.tasks.close(); }
});

test("a returned source workspace is not needed when its exact output commit is retained", async () => {
  const f = await completed();
  try {
    const allocation = f.deps.attempts.findForTask(taskId, 1)!.allocation!;
    await f.deps.workspaces.returnLease({ leaseId: allocation.leaseId, holder: taskId, path: allocation.workspace }, { discardChanges: false });
    assert.equal((await f.deps.workspaces.leases()).length, 0);
    const outcome = await reserveFromAttempt(f.deps, options);
    assert.equal(outcome.reason, "reserved", JSON.stringify(outcome));
    assert.equal(f.deps.attempts.findForTask(taskId, 2)!.specification!.startingPoint!.commit, f.first.attempt!.resultCommit);
  } finally { f.tasks.close(); }
});

test("an accepted commit takes precedence over a recorded worker result and later branch commits", async () => {
  const f = await completed();
  try {
    const ref = f.deps.attempts.findForTask(taskId, 1)!;
    const workspace = ref.allocation!.workspace;
    f.run(["commit", "--allow-empty", "--no-gpg-sign", "-m", "Accepted later work"], workspace);
    const accepted = f.run(["rev-parse", "HEAD"], workspace);
    await f.deps.attempts.appendConfirmed(ref, "output_accepted", { commit: accepted }, { fact: "output_accepted", scope: { commit: accepted } }, "operator");
    f.run(["commit", "--allow-empty", "--no-gpg-sign", "-m", "Unaccepted branch head"], workspace);
    const outcome = await reserveFromAttempt(f.deps, options);
    assert.equal(outcome.reason, "reserved", JSON.stringify(outcome));
    assert.equal(f.deps.attempts.findForTask(taskId, 2)!.specification!.startingPoint!.commit, accepted);
  } finally { f.tasks.close(); }
});

test("a confirmed stop permits a source whose runtime has no observed exit", async () => {
  const f = await completed();
  try {
    const ref = f.deps.attempts.findForTask(taskId, 1)!;
    await f.tasks.database.transaction(() => f.tasks.database.run("DELETE FROM worker_observations WHERE kind = 'exit'"));
    await f.deps.attempts.recordConfirmation(ref, { fact: "worker_stopped", scope: { leaseId: ref.allocation!.leaseId, sessionId: f.first.attempt!.sessionId! } }, "operator");
    assert.equal((await reserveFromAttempt(f.deps, options)).reason, "reserved");
  } finally { f.tasks.close(); }
});

test("a held source task still needs the operator to release it", async () => {
  const f = await completed();
  try {
    await f.tasks.hold(taskId, "review first");
    const before = records(f);
    const outcome = await reserveFromAttempt(f.deps, options);
    assert.equal(outcome.observed.reason, "not_ready");
    assert.deepEqual(records(f), before);
  } finally { f.tasks.close(); }
});

test("a done task must be reopened before continuation, even when its output was accepted", async () => {
  const f = await completed();
  try {
    const ref = f.deps.attempts.findForTask(taskId, 1)!;
    const commit = f.first.attempt!.resultCommit!;
    await f.deps.attempts.appendConfirmed(ref, "output_accepted", { commit }, { fact: "output_accepted", scope: { commit } }, "operator");
    await f.tasks.done(taskId);
    assert.equal((await reserveFromAttempt(f.deps, options)).observed.reason, "not_ready");
    await f.tasks.reopen(taskId);
    assert.equal((await reserveFromAttempt(f.deps, options)).reason, "reserved");
  } finally { f.tasks.close(); }
});
