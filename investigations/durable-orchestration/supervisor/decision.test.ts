import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { SwitchboardScenario } from "../design-a/driver.ts";
import { ApplicationStore } from "../design-a/store.ts";
import { fullSettings } from "../failures/configured-storage.ts";
import { completedResult, assertRefused } from "../scenario/assertions.ts";
import { sampleRequest } from "../scenario/common-tests.ts";
import { FakeOwners, type Approval } from "../scenario/owners.ts";
import type { Outcome } from "../scenario/contract.ts";
import { decisionCases, decisionInput, retryInput, type DecisionConfig, type DecisionView, type DecisionEvidence, type DecisionCall } from "./decision.ts";
import { json, lines, start, stop, type Host } from "./process-fixture.ts";

const root = fileURLToPath(new URL("../../../.investigation/durable-orchestration/", import.meta.url));
const hostFile = fileURLToPath(new URL("./decision-child.ts", import.meta.url));
const now = 1_000_000;
function results(view: DecisionView): ToolResultMessage[] {
  return view.transcript.entries.flatMap(entry => entry.model ?? []).filter(message => message.role === "toolResult");
}
function outcome(result: ToolResultMessage): Outcome {
  const text = result.content.find(item => item.type === "text");
  assert.ok(text && text.type === "text");
  return JSON.parse(text.text);
}

for (const scenario of decisionCases) for (let repeat = 1; repeat <= 3; repeat++) {
  test(`supervisor pending decision ${scenario}, repeat ${repeat}`, { timeout: 25_000 }, async t => {
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "supervisor-decision-"));
    const hosts: Host[] = [];
    t.after(async () => { for (const host of hosts) await stop(host); await rm(directory, { recursive: true, force: true }); });
    const owners = new FakeOwners(join(directory, "owners"), join(directory, "host"));
    await owners.initialise();
    const store = await ApplicationStore.open(join(directory, "host"));
    const driver = new SwitchboardScenario(store, owners, { now: () => now });
    const request = sampleRequest("decision");
    let original;
    try {
      await store.seed([request.taskId]);
      assert.equal((await driver.submit(request)).status, "waiting");
      const attempt = (await driver.inspect()).attempts[0]!;
      await owners.exit(completedResult(attempt));
      assert.deepEqual(await driver.advance(request.requestId), { status: "waiting", attemptId: attempt.id, waitingFor: "review" });
      original = (await driver.inspect()).attempts[0]!;
    } finally { await driver.close(); }
    const commit = original.result!.commit;
    const approval: Approval = { id: "original-approval", by: "operator", attemptId: original.id,
      leaseId: original.identity!.leaseId, commit, expiresAt: now + 100_000, accept: true, noProcesses: true };
    const controls = { ...await owners.controls(), retainedCommit: commit, approvals: [approval] };
    await owners.setControls(controls);
    if (scenario !== "review_wait") await owners.review(original.id, commit, "accepted");
    const config: DecisionConfig = { scenario, requestId: request.requestId };
    await writeFile(join(directory, "config.json"), JSON.stringify(config), { flag: "wx", flush: true });
    await writeFile(join(directory, "clock.json"), JSON.stringify(now), { flag: "wx", flush: true });
    const launch = (mode: string) => { const host = start(hostFile, directory, mode); hosts.push(host); return host; };
    const first = launch("pause");
    await first.boundary;
    const boundary = await json<DecisionView>(join(directory, "boundary.json"));
    const scope = { requestId: request.requestId, attemptId: original.id, commit };
    assert.deepEqual(boundary.decision, { pending: scope }, "Only references, not approvals or a copied attempt, belong in the decision document");
    assert.equal(boundary.engine.submissions[0]!.status, "placed");
    const inputId = boundary.engine.submissions[0]!.id;
    const historical = results(boundary);
    assert.deepEqual(historical.map(result => result.toolName), ["inspect_decision"]);
    const text = historical[0]!.content.find(item => item.type === "text");
    assert.ok(text && text.type === "text");
    assert.deepEqual(JSON.parse(text.text).controls.approvals, [approval], "Valid observed approval is committed in history before the kill");
    assert.equal(boundary.snapshot.attempts[0]!.accepted, false);
    const generation = boundary.engine.tasks.find(item => item.record.kind === "pi.generation")!;
    assert.equal(generation.record.state.status, "running");
    await stop(first);
    assert.equal(first.child.signalCode, "SIGKILL");
    const stale = launch("resume");
    assert.equal((await stale.exited).code, 2, stale.output());
    assert.match(stale.output(), /owner_claim_exists/);

    // Test-owned controls and clock change while no execution host owns the stores.
    const resumedNow = scenario === "expired" ? now + 200_000 : now + 10;
    await writeFile(join(directory, "clock.json"), JSON.stringify(resumedNow), { flush: true });
    if (scenario === "revoked" || scenario === "model_authority") await owners.setControls({ ...controls, approvals: [] });
    if (scenario === "no_processes") await owners.setControls({ ...controls, approvals: [{ ...approval, noProcesses: false }] });
    if (scenario === "retention_changed") await owners.setControls({ ...controls, retainedCommit: "b".repeat(40) });
    if (scenario === "approval_commit_changed") await owners.setControls({ ...controls, approvals: [{ ...approval, commit: "b".repeat(40) }] });
    if (scenario === "review_wait") await owners.review(original.id, "b".repeat(40), "accepted");
    await rm(join(directory, "host", "owner"), { recursive: true }); // Fixture only, after joining the killed host.
    const resumed = launch("resume");
    assert.equal((await resumed.exited).code, 0, resumed.output());
    const refusal = await json<DecisionEvidence>(join(directory, "resume.json"));
    assert.equal(refusal.submissionId, inputId);
    assert.equal(refusal.settled, "done", "Conversation answer is not approval or task completion");
    assert.equal(refusal.before.engine.scheduling, "paused");
    assert.deepEqual(refusal.before.decision, boundary.decision);
    const pending = refusal.before.engine.tasks.find(item => item.record.id === generation.record.id)!;
    assert.equal(pending.record.state.status, "pending");
    assert.deepEqual(results(refusal.before), historical);
    assert.deepEqual(refusal.after.decision, boundary.decision, "Refusal must keep the pending decision visible");
    const refusedAttempt = refusal.after.snapshot.attempts[0]!;
    assert.deepEqual(refusedAttempt.identity, original.identity);
    assert.equal(refusedAttempt.result!.commit, commit);
    assert.equal(refusedAttempt.accepted, false);
    assert.equal(refusedAttempt.done, false);
    assert.equal(refusedAttempt.returned, false);
    assert.equal(refusal.after.engine.tasks.length, 0);
    const rejectedResult = results(refusal.after).at(-1)!;
    assert.equal(rejectedResult.toolName, "finalise");
    if (scenario === "model_authority") {
      assert.equal(rejectedResult.isError, true);
      assert.match(JSON.stringify(refusal.after.transcript.entries.findLast(entry => entry.kind === "pi.tool-result")!.data), /invalid_arguments/);
    } else if (scenario === "review_wait") {
      assert.deepEqual(outcome(rejectedResult), { status: "waiting", attemptId: original.id, waitingFor: "review" });
    } else {
      assertRefused(outcome(rejectedResult), scenario === "no_processes" ? "process_confirmation_required"
        : scenario === "retention_changed" ? "not_retained" : scenario === "model_commit_changed" ? "request_conflict" : "approval_required");
    }
    const beforeReturn = await owners.counters(original.id);
    assert.deepEqual(beforeReturn, { acquire: 1, launch: 1, prompt: 1, worker_exit: 1, review: 1, merge: 0, return: 0, cancel: 0 });
    const checkStore = await ApplicationStore.open(join(directory, "host"));
    try {
      assert.ok(!checkStore.record(refusedAttempt).entries.some(entry => entry.kind === "output_accepted" || entry.kind === "lease_return_started"));
    } finally { checkStore.close(); }

    // Fresh exact-scope authority comes only from the fixture/operator, never from a model tool.
    await owners.setControls({ ...controls, approvals: [{ ...approval, id: "fresh-approval", expiresAt: resumedNow + 100_000 }] });
    if (scenario === "review_wait") await owners.review(original.id, commit, "accepted");
    const complete = launch("complete");
    assert.equal((await complete.exited).code, 0, complete.output());
    const finished = await json<DecisionEvidence>(join(directory, "complete.json"));
    assert.deepEqual(finished.before.decision, boundary.decision);
    assert.equal(finished.before.conversationId, boundary.conversationId);
    assert.notEqual(finished.submissionId, inputId);
    assert.equal(finished.settled, "done");
    assert.deepEqual(finished.after.decision, {}, "Clear the pending reference only after application completion");
    assert.deepEqual(outcome(results(finished.after).at(-1)!), { status: "completed", attemptId: original.id, waitingFor: null });
    const finalAttempt = finished.after.snapshot.attempts[0]!;
    assert.ok(finalAttempt.accepted && finalAttempt.done && finalAttempt.returned);
    assert.equal(finished.after.snapshot.attempts.length, 1);
    assert.deepEqual(finalAttempt.identity, original.identity);
    assert.deepEqual(await owners.counters(original.id), { ...beforeReturn, return: 1, review: scenario === "review_wait" ? 2 : 1 });
    assert.ok((await owners.records()).every(record => record.attemptId === original.id), "No foreign/orphan effects can hide behind the original attempt's counters");
    const inspected = await ApplicationStore.open(join(directory, "host"));
    try {
      const entries = inspected.record(finalAttempt).entries;
      for (const kind of ["output_accepted", "lease_return_started", "lease_returned"]) assert.equal(entries.filter(entry => entry.kind === kind).length, 1);
      assert.equal(entries.filter(entry => entry.kind === "task_recorded" && entry.data.category === "done").length, 1);
      assert.equal(entries.find(entry => entry.kind === "output_accepted")!.data.commit, commit);
    } finally { inspected.close(); }
    const calls = await lines<DecisionCall>(join(directory, "decision-calls.jsonl"));
    assert.equal(calls.filter(call => call.tool === "inspect_decision").length, 2, "Restart first uses committed history; explicit retry performs fresh inspection");
    const finalisations = calls.filter(call => call.tool === "finalise");
    assert.equal(finalisations.length, scenario === "model_authority" ? 1 : 2, "Model authority arguments must be rejected before invoking the application adapter");
    assert.equal(finalisations.at(-1)!.pid, complete.child.pid);
    const users = finished.after.transcript.entries.flatMap(entry => entry.model ?? []).filter(message => message.role === "user");
    assert.deepEqual(users.map(message => message.content), [decisionInput.content, retryInput.content]);
    const settings = await lines<{ pid: number; settings: unknown }>(join(directory, "storage.jsonl"));
    assert.deepEqual(new Set(settings.map(row => row.pid)), new Set([first.child.pid, resumed.child.pid, complete.child.pid]));
    for (const row of settings) assert.deepEqual(row.settings, fullSettings);
    const summary = { experiment: "supervisor-pending-decision", scenario, repeat, attemptId: original.id,
      originalInputId: inputId, retryInputId: finished.submissionId, finalisations: finalisations.length,
      counts: await owners.counters(original.id), fixtureClaimRecoveries: 1, explicitRetryInputs: 1 };
    await appendFile(join(root, "supervisor-decision-results.jsonl"), `${JSON.stringify(summary)}\n`, { flush: true });
    console.log(JSON.stringify(summary));
  });
}
