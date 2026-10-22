import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { assertRefused, assertSuccessful, findAttempt } from "../scenario/assertions.ts";
import { acceptReview, defineCommonTests, finishWorker, sampleRequest, type CreateFixture } from "../scenario/common-tests.ts";
import { FakeOwners } from "../scenario/owners.ts";
import type { Point } from "../scenario/contract.ts";
import { HostClient } from "./client.ts";
import { ExecutionHost } from "./host.ts";

const root = fileURLToPath(new URL("../../../.investigation/durable-orchestration/", import.meta.url));
export async function create(options: Parameters<CreateFixture>[0] = {}) {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "design-b-"));
  const owners = new FakeOwners(join(directory, "owners"), join(directory, "host"), options.interrupt);
  await owners.initialise();
  const now = 1_000_000;
  const host = await ExecutionHost.open(directory, owners, { ...options, now: () => now, manualClock: true,
    seedTaskIds: ["happy", "request-1", "one", "two", "three"].map(id => sampleRequest(id).taskId) });
  const driver = new HostClient(directory);
  return { driver, owners, now, host, directory, close: async () => {
    await host.close();
    await rm(directory, { recursive: true, force: true });
  } };
}

defineCommonTests("B over HTTP", create);

test("B: public diagnostics expose a persisted sleep, separate from domain capacity and acceptance", async t => {
  const fixture = await create();
  t.after(() => fixture.close());
  const request = sampleRequest();
  await fixture.driver.submit(request);
  const diagnostic = await fixture.host.engine.harness.inspect(BACKGROUND_CONTEXT);
  assert.equal(diagnostic.tasks.length, 1);
  assert.equal(diagnostic.tasks[0]!.state.kind, "sleeping");
  assert.equal(diagnostic.tasks[0]!.record.state.status, "sleeping");
  assert.equal((await fixture.driver.inspect()).active, 1);
  await finishWorker(fixture, request);
  await fixture.driver.advance(request.requestId);
  assert.equal((await fixture.driver.inspect()).active, 0);
  assert.equal((await findAttempt(fixture.driver, request.requestId)).accepted, false);
  const store = fixture.host.engine.operations.store;
  assert.equal(Number(store.tasks.database.get("SELECT count(*) AS n FROM prototype_responses")!.n), 0,
    "B does not maintain A's application response cache as well as engine execution responses");
  await acceptReview(fixture, request);
  await assertSuccessful(fixture.driver, fixture.owners, request, await fixture.driver.advance(request.requestId));
});

test("B: a disconnected submit client does not cancel execution or create a replacement attempt", async t => {
  let reached!: () => void;
  let release!: () => void;
  const marker = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fixture = await create({ interrupt: async point => {
    if (point === "prompted:ack:after") { reached(); await gate; }
  } });
  t.after(async () => { release(); await fixture.close(); });
  const request = sampleRequest();
  const abort = new AbortController();
  const response = fetch(`http://127.0.0.1:${fixture.host.endpoint.port}/`, {
    method: "POST", headers: { Authorization: `Bearer ${fixture.host.endpoint.token}` },
    body: JSON.stringify({ method: "submit", request }), signal: abort.signal,
  }).then(value => value.json(), () => "disconnected");
  await marker;
  abort.abort();
  release();
  assert.equal(await response, "disconnected");
  assert.equal((await fixture.driver.submit(request)).status, "waiting");
  const snapshot = await fixture.driver.inspect();
  assert.equal(snapshot.attempts.length, 1);
  const counts = await fixture.owners.counters(snapshot.attempts[0]!.id);
  assert.equal(counts.acquire, 1);
  assert.equal(counts.launch, 1);
  assert.equal(counts.prompt, 1);
});

test("B: a review checkpoint does not authorise finalisation after the owner rejects it", async t => {
  let owners: FakeOwners;
  const fixture = await create({ interrupt: async point => {
    if (point === "review:ack:after") {
      const attempt = fixture.host.engine.operations.store.list()[0]!;
      await owners.review(attempt.id, attempt.result!.commit, "rejected");
    }
  } });
  owners = fixture.owners;
  t.after(() => fixture.close());
  const request = sampleRequest();
  await fixture.driver.submit(request);
  await finishWorker(fixture, request);
  await acceptReview(fixture, request);
  assertRefused(await fixture.driver.advance(request.requestId), "review_rejected");
  const attempt = await findAttempt(fixture.driver, request.requestId);
  assert.equal(attempt.accepted, false);
  assert.equal((await owners.counters(attempt.id)).return, 0);
});

test("B: exclusive host ownership refuses even a second open in the same process", async t => {
  const fixture = await create();
  t.after(() => fixture.close());
  await assert.rejects(ExecutionHost.open(fixture.directory, fixture.owners), /Host ownership unavailable/);
  assert.equal((await fixture.driver.inspect()).attempts.length, 0);
});

test("B: reopening during review preserves the task ID and deadline and rechecks current approval", async t => {
  const fixture = await create();
  let reopened: ExecutionHost | undefined;
  t.after(async () => { await reopened?.close(); await fixture.close(); });
  const request = sampleRequest();
  await fixture.driver.submit(request);
  await finishWorker(fixture, request);
  await fixture.driver.advance(request.requestId);
  const saved = (await fixture.host.engine.harness.inspect(BACKGROUND_CONTEXT)).tasks[0]!.record;
  await fixture.host.close();
  reopened = await ExecutionHost.open(fixture.directory, fixture.owners, { manualClock: true, now: () => fixture.now });
  const recovered = (await reopened.engine.harness.inspect(BACKGROUND_CONTEXT)).tasks[0]!.record;
  assert.equal(recovered.id, saved.id);
  assert.deepEqual(recovered.state, saved.state);
  await acceptReview(fixture, request);
  await fixture.owners.setControls({ ...await fixture.owners.controls(), approvals: [] });
  assertRefused(await fixture.driver.advance(request.requestId), "approval_required");
  const counters = await fixture.owners.counters((await findAttempt(fixture.driver, request.requestId)).id);
  assert.equal(counters.launch, 1);
  assert.equal(counters.prompt, 1);
  assert.equal(counters.return, 0);
});

for (const boundary of ["acquire:effect:after", "launch:effect:after", "prompt:effect:after", "return:effect:after"] as const) {
  test(`B: an adapter error at ${boundary} reports uncertainty without repeating its effect`, async t => {
    let armed = true;
    const fixture = await create({ interrupt: async (point: Point) => {
      if (armed && point === boundary) { armed = false; throw new Error(`lost acknowledgement at ${point}`); }
    } });
    let reopened: ExecutionHost | undefined;
    t.after(async () => { await reopened?.close(); await fixture.close(); });
    const request = sampleRequest();
    const submitted = await fixture.driver.submit(request);
    if (boundary === "return:effect:after") {
      await finishWorker(fixture, request);
      await acceptReview(fixture, request);
      assertRefused(await fixture.driver.advance(request.requestId), "host_unavailable");
    } else assertRefused(submitted, "host_unavailable");
    const attempt = await findAttempt(fixture.driver, request.requestId);
    const before = await fixture.owners.counters(attempt.id);
    assert.equal(before[boundary.split(":")[0] as "acquire" | "launch" | "prompt" | "return"], 1);
    const reports = fixture.host.engine.reports;
    assert.ok(reports.some(report => report.message.includes("lost acknowledgement")));
    await fixture.host.close();
    reopened = await ExecutionHost.open(fixture.directory, fixture.owners, { manualClock: true, now: () => fixture.now });
    assertRefused(await fixture.driver.submit(request), "host_unavailable");
    assertRefused(await fixture.driver.advance(request.requestId), "host_unavailable");
    assert.deepEqual(await fixture.owners.counters(attempt.id), before);
  });
}

test("B: reopen with no positive exit refuses adoption and new dispatch", async t => {
  const fixture = await create({ maxAttempts: 2 });
  let reopened: ExecutionHost | undefined;
  t.after(async () => { await reopened?.close(); await fixture.close(); });
  const request = sampleRequest();
  await fixture.driver.submit(request);
  await fixture.host.close();
  reopened = await ExecutionHost.open(fixture.directory, fixture.owners, { manualClock: true, maxAttempts: 2 });
  assertRefused(await fixture.driver.advance(request.requestId), "possibly_running");
  assertRefused(await fixture.driver.submit(sampleRequest("two")), "possibly_running");
  const counters = await fixture.owners.counters((await findAttempt(fixture.driver, request.requestId)).id);
  assert.equal(counters.launch, 1);
  assert.equal(counters.prompt, 1);
});
