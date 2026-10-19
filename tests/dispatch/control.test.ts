import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { requestControl } from "../../src/dispatch/control.ts";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { resolveStopped } from "../../src/dispatch/resolve.ts";
import { describeStatus, status } from "../../src/dispatch/status.ts";
import { dispatcherRunning } from "../../src/runtime/heartbeat.ts";
import { claimRequest } from "../../src/runtime/requests.ts";
import { fixture, task } from "./fixture.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Waits until the worker has received its prompt, so the owning dispatcher is checking for requests. */
async function running(f: Fixture, taskId: string) {
  for (let i = 0; i < 200; i += 1) {
    const record = (await f.runtime.discover("fixture-context")).find(r => r.binding.input.identity.taskId === taskId);
    const log = join(f.dir, "requests.jsonl");
    if (record && existsSync(log) && readFileSync(log, "utf8").includes('"type":"prompt"')) return record;
    await sleep(25);
  }
  throw new Error("The worker never started");
}
const prompts = (f: Fixture, type: string) =>
  readFileSync(join(f.dir, "requests.jsonl"), "utf8").trim().split("\n").filter(line => JSON.parse(line).type === type).length;

test("a steering message reaches the running worker once and is recorded with its sender", async () => {
  const f = await fixture({ tasks: [task("steer-a1")], scenario: "await-steer", worker: { requestPollMs: 50 } });
  const dispatching = dispatchOnce(f.deps);
  const record = await running(f, "steer-a1");
  const sent = await requestControl(f.deps, { leaseId: record.binding.input.identity.leaseId, kind: "steer", message: "Use the smaller fix", sender: "operator:test", waitMs: 5000 });
  assert.equal(sent.reason, "delivered", JSON.stringify(sent, null, 2));
  assert.equal(sent.ok, true);
  assert.match(sent.detail!, /queued/);
  const outcome = await dispatching;
  assert.equal(outcome.reason, "held");
  assert.equal(prompts(f, "steer"), 1);
  const entry = (await f.deps.attempts.forTask("steer-a1"))[0]!.entries.find(e => e.kind === "operator_request")!;
  assert.deepEqual({ kind: entry.data.kind, sender: entry.data.sender, outcome: entry.data.outcome, message: entry.data.message },
    { kind: "steer", sender: "operator:test", outcome: "queued", message: "Use the smaller fix" });
  assert.match(readFileSync(join(record.directory, "activity.jsonl"), "utf8"), /Steering message from operator:test/);
});

test("a follow-up is forwarded as Pi's follow_up", async () => {
  const f = await fixture({ tasks: [task("follow-a1")], scenario: "await-steer", worker: { requestPollMs: 50 } });
  const dispatching = dispatchOnce(f.deps);
  const record = await running(f, "follow-a1");
  const sent = await requestControl(f.deps, { leaseId: record.binding.input.identity.leaseId, kind: "follow_up", message: "Then update the notes", sender: "operator:test", waitMs: 5000 });
  assert.equal(sent.reason, "delivered");
  await dispatching;
  assert.equal(prompts(f, "follow_up"), 1);
});

test("a stop request stops the running worker and the task is held as interrupted", async () => {
  const f = await fixture({ tasks: [task("stop-a1")], scenario: "ignore-stop", worker: { requestPollMs: 50 } });
  const dispatching = dispatchOnce(f.deps);
  const record = await running(f, "stop-a1");
  const leaseId = record.binding.input.identity.leaseId;
  const view = await status(f.deps);
  assert.equal(view.reason, "clear");
  assert.equal(view.ok, true);
  assert.equal(view.nextAction.code, "watch_attempt");
  assert.equal(view.attempts[0]?.nextAction.code, "watch_attempt");
  assert.equal(view.attempts[0]?.possiblyRunning, true);
  assert.match(describeStatus(view), /WORKER RUNNING/);
  assert.doesNotMatch(describeStatus(view), /Needs attention|WORKER MAY BE RUNNING/);
  const before = (await f.deps.attempts.forTask("stop-a1"))[0]!.entries;
  const refused = await resolveStopped(f.deps, { leaseId, confirmed: true });
  assert.equal(refused.reason, "refused");
  assert.match(refused.detail!, /owning dispatcher appears to be running/);
  assert.deepEqual((await f.deps.attempts.forTask("stop-a1"))[0]!.entries, before);
  assert.equal((await f.runtime.discover("fixture-context"))[0]?.child.status, "unknown");
  assert.equal((await dispatchOnce(f.deps)).nextAction.code, "stop_worker");
  const sent = await requestControl(f.deps, { leaseId: record.binding.input.identity.leaseId, kind: "stop", sender: "operator:test", waitMs: 5000 });
  assert.equal(sent.reason, "delivered");
  const outcome = await dispatching;
  assert.equal(outcome.reason, "held");
  assert.equal(await dispatcherRunning(record.directory), false);
  assert.equal((await f.tasks.read("stop-a1"))?.holdReason, "Switchboard attempt 1 interrupted");
  assert.match(outcome.worker?.reason ?? "", /operator:test/);
  assert.ok((await f.deps.attempts.forTask("stop-a1"))[0]!.entries.some(e => e.kind === "operator_request" && e.data.kind === "stop"));
});

test("a request with no running dispatcher is withdrawn and can never be forwarded later", async () => {
  const f = await fixture();
  const workspace = join(f.dir, "orphan-workspace");
  mkdirSync(workspace);
  const reserved = await f.runtime.reserve({
    identity: { contextId: "fixture-context", taskId: "orphan-a1", leaseId: "lease-orphan", sessionId: randomUUID() }, workspace,
    instructions: "Orphan", acceptanceCriteria: [],
    delivery: { baseRef: "main", startingCommit: "a".repeat(40), outputBranch: "o", kind: "code", acceptance: "review_or_integration", requiredEvidence: [], requiredDeliverables: [] },
  });
  const sent = await requestControl(f.deps, { leaseId: "lease-orphan", kind: "steer", message: "Hello", sender: "operator:test", waitMs: 300 });
  assert.equal(sent.reason, "undelivered");
  assert.equal(sent.nextAction.code, "no_dispatcher");
  assert.equal(await claimRequest(reserved, String(sent.observed.requestId), "dispatcher"), false);
});

test("requests for a finished worker or an unknown lease are refused", async () => {
  const f = await fixture({ tasks: [task("done-a1")], scenario: "commit-result" });
  const finished = await dispatchOnce(f.deps);
  const late = await requestControl(f.deps, { leaseId: finished.attempt!.leaseId!, kind: "stop", sender: "operator:test", waitMs: 300 });
  assert.equal(late.reason, "refused");
  assert.match(late.detail!, /not running/);
  assert.equal((await requestControl(f.deps, { leaseId: "no-such-lease", kind: "stop", sender: "operator:test", waitMs: 300 })).reason, "refused");
});
