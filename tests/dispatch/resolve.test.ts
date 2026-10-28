import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dispatchOnce, inspect } from "../../src/dispatch/dispatch.ts";
import { resolveStopped } from "../../src/dispatch/resolve.ts";
import { status } from "../../src/dispatch/status.ts";
import { fixture, task } from "./fixture.ts";
import { startHeartbeat } from "../../src/runtime/heartbeat.ts";

const delivery = { baseRef: "main", startingCommit: "a".repeat(40), outputBranch: "o", kind: "code" as const, acceptance: "review_or_integration" as const, requiredEvidence: [], requiredDeliverables: [] };

for (const heartbeat of ["missing", "stale"]) test(`a runtime record with a ${heartbeat} heartbeat blocks dispatch until the operator confirms the worker stopped`, async () => {
  const { deps, runtime, dir, tasks } = await fixture({ tasks: [task("next-a1"), ["add", "earlier-a1", "Earlier", "--repo", "other"]], scenario: "commit-result" });
  const workspace = join(dir, "orphan-workspace");
  mkdirSync(workspace);
  // As left by a dispatcher that died after launching a worker.
  const sessionId = randomUUID();
  const ref = await deps.attempts.create("earlier-a1", {}, 0);
  await deps.attempts.append(ref, "leased", { leaseId: "lease-orphan", workspace, baseRef: "main", outputBranch: "o", startingCommit: "a".repeat(40) });
  await deps.attempts.append(ref, "launched", { sessionId });
  const reserved = await runtime.reserve({ identity: { contextId: "fixture-context", taskId: "earlier-a1", leaseId: "lease-orphan", sessionId }, workspace, instructions: "Earlier", acceptanceCriteria: [], delivery });
  if (heartbeat === "stale") await tasks.database.transaction(() => tasks.database.run("UPDATE worker_claims SET heartbeat_at = ? WHERE id = ?", new Date(Date.now() - 60_000).toISOString(), reserved.claimId));
  else await reserved.storage.releaseClaim(reserved.claimId);

  const view = await status(deps);
  assert.equal(view.nextAction.code, "stop_worker");
  assert.equal(view.reason, "attention");
  assert.equal(view.attempts.find(a => a.attempt.leaseId === "lease-orphan")?.possiblyRunning, true);

  const unconfirmed = await resolveStopped(deps, { leaseId: "lease-orphan", confirmed: false });
  assert.equal(unconfirmed.nextAction.code, "confirm_worker_stopped");
  assert.equal((await dispatchOnce(deps)).nextAction.code, "stop_worker");

  const resolved = await resolveStopped(deps, { leaseId: "lease-orphan", confirmed: true, note: "Checked with lsof" });
  assert.equal(resolved.reason, "resolved");
  assert.equal(resolved.nextAction.code, "apply_task_outcome");
  const observed = await inspect(deps);
  assert.ok(!("failed" in observed));
  assert.equal(observed.runtime.find(r => r.binding.input.identity.leaseId === "lease-orphan")?.child.status, "operator_confirmed_stopped");
  assert.equal(deps.attempts.confirmations(ref)[0]!.fact, "worker_stopped");

  assert.equal((await dispatchOnce(deps)).nextAction.code, "review_then_finish");
  assert.equal((await resolveStopped(deps, { leaseId: "lease-orphan", confirmed: true })).nextAction.code, "none");
});

test("a fresh claim protects a runtime record before the attempt logs its launch", async () => {
  const { deps, runtime, dir } = await fixture({ tasks: [task("earlier-a1")] });
  const workspace = join(dir, "orphan-workspace");
  mkdirSync(workspace);
  const ref = await deps.attempts.create("earlier-a1", {}, 0);
  await deps.attempts.append(ref, "leased", { leaseId: "lease-orphan", workspace, baseRef: "main", outputBranch: "o", startingCommit: "a".repeat(40) });
  const reserved = await runtime.reserve({ identity: { contextId: "fixture-context", taskId: "earlier-a1", leaseId: "lease-orphan", sessionId: randomUUID() }, workspace, instructions: "Earlier", acceptanceCriteria: [], delivery });
  const stop = await startHeartbeat(reserved);
  try {
    const view = await status(deps);
    assert.equal(view.reason, "clear");
    assert.equal(view.attempts[0]?.nextAction.code, "watch_attempt");
    const refused = await resolveStopped(deps, { leaseId: "lease-orphan", confirmed: true });
    assert.equal(refused.reason, "refused");
    assert.match(refused.detail!, /owning dispatcher appears to be running/);
    assert.equal((await runtime.discover("fixture-context"))[0]?.child.status, "unknown");
    assert.equal((await deps.attempts.list()).length, 1);
  } finally { await stop(); }
});

test("an attempt logged as launched but never finished is resolved through the attempt log", async () => {
  const { deps } = await fixture({ tasks: [task("logged-a1"), task("other-b1")], scenario: "commit-result" });
  // As left by a dispatcher that died after logging the launch but before the runtime wrote its binding.
  const ref = await deps.attempts.create("logged-a1", {}, 0);
  await deps.attempts.append(ref, "leased", { leaseId: "lease-logged", workspace: "/nowhere", baseRef: "main", outputBranch: "o", startingCommit: "a".repeat(40) });
  await deps.attempts.startReservedTask(ref);
  await deps.attempts.append(ref, "launched", { sessionId: randomUUID() });
  assert.equal((await dispatchOnce(deps)).observed.reason, "capacity");

  assert.equal((await resolveStopped(deps, { leaseId: "lease-logged", confirmed: true })).reason, "resolved");
  assert.equal((await deps.attempts.read(ref)).entries.at(-1)?.kind, "operator_resolved");
  // The task store still shows logged-a1 in flight, so dispatch moves on to the next ready task.
  const next = await dispatchOnce(deps);
  assert.equal(next.nextAction.code, "review_then_finish");
  assert.equal(next.attempt?.taskId, "other-b1");
});

test("unknown and already finished leases are reported, not changed", async () => {
  const { deps } = await fixture({ tasks: [task("done-a1")], scenario: "commit-result" });
  assert.equal((await resolveStopped(deps, { leaseId: "no-such-lease", confirmed: true })).nextAction.code, "inspect_attempt");
  const finished = await dispatchOnce(deps);
  const before = (await deps.attempts.forTask("done-a1"))[0]!.entries.length;
  assert.equal((await resolveStopped(deps, { leaseId: finished.attempt!.leaseId!, confirmed: true })).nextAction.code, "none");
  assert.equal((await deps.attempts.forTask("done-a1"))[0]!.entries.length, before);
});
