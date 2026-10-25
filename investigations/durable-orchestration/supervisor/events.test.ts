import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ApplicationStore } from "../design-a/store.ts";
import { sampleRequest } from "../scenario/common-tests.ts";
import { fullSettings } from "../failures/configured-storage.ts";
import { EventDelivery, deliveryPoints, initialInput, wakeInput, type DeliverySnapshot, type DeliveryEvidence, type EventConfig } from "./event-delivery.ts";
import { json, lines, start, stop, type Host } from "./process-fixture.ts";

const root = fileURLToPath(new URL("../../../.investigation/durable-orchestration/", import.meta.url));
const hostFile = fileURLToPath(new URL("./events-child.ts", import.meta.url));
const cases: Pick<EventConfig, "point" | "failure">[] = [
  ...deliveryPoints.map(point => ({ point, failure: "none" as const })),
  { point: "queued", failure: "initial" }, { point: "queued", failure: "event" },
];
const eventStates = (view: DeliverySnapshot) => view.events.map(event => event.submission?.status ?? null);
const userContents = (view: DeliverySnapshot) => view.transcript.entries.flatMap(entry => entry.model ?? [])
  .filter(message => message.role === "user").map(message => message.content);

for (const scenario of cases) for (let repeat = 1; repeat <= 3; repeat++) {
  test(`supervisor input recovery ${scenario.point}/${scenario.failure}, repeat ${repeat}`, { timeout: 25_000 }, async t => {
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "supervisor-events-"));
    const hosts: Host[] = [];
    t.after(async () => { for (const host of hosts) await stop(host); await rm(directory, { recursive: true, force: true }); });
    const store = await ApplicationStore.open(join(directory, "host"));
    let config: EventConfig;
    try {
      const request = sampleRequest("event-source");
      await store.seed([request.taskId]);
      const reserved = await store.reserve(request, 1);
      if ("outcome" in reserved) throw new Error("Fixture source reservation refused");
      const source = store.ref(reserved.attempt);
      await store.attempts.append(source, "halted", { stage: "fixture", reason: "No worker launched; source events only" });
      config = { ...scenario, objectiveId: randomUUID(), source };
    } finally { store.close(); }
    await writeFile(join(directory, "config.json"), JSON.stringify(config), { flag: "wx", flush: true });
    const launch = (mode: string) => { const host = start(hostFile, directory, mode); hosts.push(host); return host; };
    const first = launch("pause");
    await first.boundary;
    const boundary = await json<DeliverySnapshot>(join(directory, "boundary.json"));
    const accepted = scenario.point === "before_submit" ? 0 : scenario.point === "queued" ? 2 : 1;
    const position = scenario.point === "after_cursor" ? 0 : scenario.point === "queued" ? 1 : -1;
    assert.equal(boundary.position, position, "Delivery position reflects acknowledged storage, not observed source entries");
    assert.deepEqual(eventStates(boundary), Array.from({ length: 2 }, (_, i) => i < accepted ? "queued" : null));
    assert.deepEqual(boundary.inbox.map(item => item.id), boundary.events.flatMap(event => event.submission ? [event.submission.id] : []));
    assert.equal(boundary.initial?.status, "placed");
    assert.deepEqual(userContents(boundary), [initialInput.content], "Queued input is not yet a transcript entry");
    const generation = boundary.engine.tasks.find(item => item.record.kind === "pi.generation")!;
    assert.equal(generation.record.state.status, "running");
    await stop(first);
    assert.equal(first.child.signalCode, "SIGKILL");
    const stale = launch("resume");
    assert.equal((await stale.exited).code, 2, stale.output());
    assert.match(stale.output(), /owner_claim_exists/);
    await rm(join(directory, "host", "owner"), { recursive: true }); // Joined test host; no workers exist.
    const resumed = launch("resume");
    assert.equal((await resumed.exited).code, 0, resumed.output());
    const result = await json<DeliveryEvidence>(join(directory, "resume.json"));
    assert.equal(result.before.engine.scheduling, "paused");
    assert.equal(result.before.position, boundary.position);
    assert.deepEqual(result.before.events, boundary.events);
    assert.deepEqual(result.before.inbox, boundary.inbox);
    assert.equal(result.before.conversationId, boundary.conversationId);
    assert.equal(result.before.initial?.id, boundary.initial!.id);
    const recoveredGeneration = result.before.engine.tasks.find(item => item.record.id === generation.record.id)!;
    assert.equal(recoveredGeneration.record.state.status, "pending");
    assert.equal(result.queued.position, 1);
    assert.deepEqual(eventStates(result.queued), ["queued", "queued"]);
    assert.equal(result.queued.inbox.length, 2, "Redelivery finds the existing queued input, not a second one");
    const queuedIds = result.queued.events.map(event => event.submission!.id);
    assert.ok(queuedIds[0]! < queuedIds[1]!, "Ordered event admission survives recovery");
    for (const [i, event] of boundary.events.entries()) {
      if (event.submission) assert.equal(queuedIds[i], event.submission.id);
    }
    const admitted = result.deliveryCalls.filter(call => call.point === "after_submit");
    assert.deepEqual(admitted.map(call => call.eventId), boundary.events.filter(event => event.entry.sequence > position).map(event => event.id));
    if (scenario.point === "after_submit") {
      assert.equal(admitted[0]!.submissionId, boundary.events[0]!.submission!.id, "Lost acknowledgement redelivers the stable event ID");
    }
    assert.equal(result.final.position, 1);
    assert.equal(result.final.engine.tasks.length, 0);
    assert.equal(result.final.engine.submissions.length, 0);
    assert.deepEqual(result.final.inbox, []);
    assert.deepEqual(result.final.events.map(event => event.submission!.id), queuedIds);
    const contents = [initialInput.content, ...boundary.events.map(event => JSON.stringify({ id: event.id, entry: event.entry }))];
    const finalContents = userContents(result.final);
    assert.deepEqual(finalContents, scenario.failure === "none" ? contents : [...contents, wakeInput.content], "Each logical input appears once, in delivery order");
    assert.deepEqual(eventStates(result.final), scenario.failure === "event" ? ["unanswered", "done"] : ["done", "done"]);
    if (scenario.failure === "none") {
      assert.equal(result.afterFailure, null);
      assert.equal(result.wake, null);
      assert.equal(result.final.initial!.status, "done");
    } else {
      const failure = result.afterFailure!;
      assert.equal(failure.position, 1, "Delivery acknowledgement is not answer acknowledgement");
      assert.equal(failure.engine.tasks.length, 0);
      assert.deepEqual(eventStates(failure), scenario.failure === "initial" ? ["queued", "queued"] : ["unanswered", "queued"]);
      const unanswered = scenario.failure === "initial" ? failure.initial! : failure.events[0]!.submission!;
      assert.equal(unanswered.status, "unanswered");
      if (unanswered.status !== "unanswered") throw new Error("Expected visible failed input");
      assert.equal(unanswered.reason, "model_error");
      assert.match(String(unanswered.detail), /injected non-retryable supervisor error/);
      const unfinished = failure.events.filter(event => event.submission!.status === "queued").map(event => event.submission!.id);
      assert.deepEqual(failure.engine.submissions.map(submission => submission.id), unfinished, "Queued inputs remain visible through inspection");
      assert.deepEqual(failure.inbox.map(item => item.id), unfinished);
      assert.equal(result.wake!.status, "done", "An explicit operator input restarts the queue, not the failed event");
      assert.equal(result.final.initial!.status, scenario.failure === "initial" ? "unanswered" : "done");
      assert.deepEqual(scenario.failure === "initial" ? result.final.initial : result.final.events[0]!.submission,
        unanswered, "Continuing the queue must not overwrite or hide the failed input");
    }
    const requests = await lines<{ pid: number; content: string }>(join(directory, "model-inputs.jsonl"));
    assert.deepEqual(requests.map(request => request.content), [initialInput.content, ...finalContents], "Only the interrupted initial generation repeats, not queued event inputs");
    assert.equal(requests[0]!.pid, first.child.pid);
    assert.ok(requests.slice(1).every(request => request.pid === resumed.child.pid));
    const settings = await lines<{ pid: number; settings: unknown }>(join(directory, "storage.jsonl"));
    assert.deepEqual(new Set(settings.map(row => row.pid)), new Set([first.child.pid, resumed.child.pid]));
    for (const row of settings) assert.deepEqual(row.settings, fullSettings);
    const inspected = await ApplicationStore.open(join(directory, "host"));
    try {
      const delivery = new EventDelivery(inspected, config);
      assert.deepEqual(delivery.events(), boundary.events.map(({ id, entry }) => ({ id, entry })), "Source log is retained unchanged");
      assert.equal(delivery.position(), 1);
      assert.equal(inspected.tasks.database.get("SELECT count(*) AS n FROM prototype_supervisor_delivery")!.n, 1);
      assert.equal(inspected.attempts.list().length, 1);
      assert.equal(inspected.tasks.database.get("SELECT count(*) AS n FROM launches")!.n, 0);
      assert.equal(inspected.tasks.database.get("SELECT count(*) AS n FROM worker_claims")!.n, 0);
    } finally { inspected.close(); }
    const summary = { experiment: "supervisor-input-recovery", ...scenario, repeat, positionAtKill: position,
      acceptedAtKill: accepted, finalPosition: result.final.position, submissionIds: queuedIds,
      finalStates: eventStates(result.final), fixtureClaimRecoveries: 1, operatorWakeInputs: result.wake ? 1 : 0 };
    await appendFile(join(root, "supervisor-events-results.jsonl"), `${JSON.stringify(summary)}\n`, { flush: true });
    console.log(JSON.stringify(summary));
  });
}
