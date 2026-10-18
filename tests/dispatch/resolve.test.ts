import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { resolveStopped } from "../../src/dispatch/resolve.ts";
import { status } from "../../src/dispatch/status.ts";
import { fixture, task } from "./fixture.ts";

const delivery = { baseRef: "main", startingCommit: "a".repeat(40), outputBranch: "o", kind: "code" as const, acceptance: "review_or_integration" as const, requiredEvidence: [], requiredDeliverables: [] };

test("a runtime record with no observed exit blocks dispatch until the operator confirms the worker stopped", async () => {
  const { deps, runtime, dir } = await fixture({ tasks: [task("next-a1")], scenario: "commit-result" });
  const workspace = join(dir, "orphan-workspace");
  mkdirSync(workspace);
  // As left by a dispatcher that died after launching a worker.
  await runtime.reserve({ identity: { contextId: "fixture-context", taskId: "earlier-a1", leaseId: "lease-orphan", sessionId: randomUUID() }, workspace, instructions: "Earlier", acceptanceCriteria: [], delivery });

  const view = await status(deps);
  assert.equal(view.nextAction.code, "stop_worker");
  assert.equal(view.attempts.find(a => a.attempt.leaseId === "lease-orphan")?.possiblyRunning, true);

  const unconfirmed = await resolveStopped(deps, { leaseId: "lease-orphan", confirmed: false });
  assert.equal(unconfirmed.reason, "confirmation_required");
  assert.equal((await dispatchOnce(deps)).reason, "attempt_may_be_running");

  const resolved = await resolveStopped(deps, { leaseId: "lease-orphan", confirmed: true, note: "Checked with lsof" });
  assert.equal(resolved.reason, "resolved_worker_stopped");
  assert.equal(resolved.nextAction.code, "apply_task_outcome");
  const record = (await runtime.discover("fixture-context")).find(r => r.binding.input.identity.leaseId === "lease-orphan");
  assert.equal(record?.child.status, "operator_confirmed_stopped");

  assert.equal((await dispatchOnce(deps)).reason, "held_review_required");
  assert.equal((await resolveStopped(deps, { leaseId: "lease-orphan", confirmed: true })).reason, "nothing_to_resolve");
});

test("an attempt logged as launched but never finished is resolved through the attempt log", async () => {
  const { deps } = await fixture({ tasks: [task("logged-a1"), task("other-b1")], scenario: "commit-result" });
  // As left by a dispatcher that died after logging the launch but before the runtime wrote its binding.
  const ref = await deps.attempts.create("logged-a1", {}, 0);
  await deps.attempts.append(ref, "leased", { leaseId: "lease-logged", workspace: "/nowhere", baseRef: "main", outputBranch: "o", startingCommit: "a".repeat(40) });
  await deps.tasks.start("logged-a1");
  await deps.attempts.append(ref, "task_started", {});
  await deps.attempts.append(ref, "launched", { sessionId: randomUUID() });
  assert.equal((await dispatchOnce(deps)).reason, "attempt_may_be_running");

  assert.equal((await resolveStopped(deps, { leaseId: "lease-logged", confirmed: true })).reason, "resolved_worker_stopped");
  assert.equal((await deps.attempts.read(ref)).entries.at(-1)?.kind, "operator_resolved");
  // The task store still shows logged-a1 in flight, so dispatch moves on to the next ready task.
  const next = await dispatchOnce(deps);
  assert.equal(next.reason, "held_review_required");
  assert.equal(next.attempt?.taskId, "other-b1");
});

test("unknown and already finished leases are reported, not changed", async () => {
  const { deps } = await fixture({ tasks: [task("done-a1")], scenario: "commit-result" });
  assert.equal((await resolveStopped(deps, { leaseId: "no-such-lease", confirmed: true })).reason, "unknown_lease");
  const finished = await dispatchOnce(deps);
  const before = (await deps.attempts.forTask("done-a1"))[0]!.entries.length;
  assert.equal((await resolveStopped(deps, { leaseId: finished.attempt!.leaseId!, confirmed: true })).reason, "nothing_to_resolve");
  assert.equal((await deps.attempts.forTask("done-a1"))[0]!.entries.length, before);
});
