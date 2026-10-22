import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertRefused, assertRetained, assertSuccessful, findAttempt } from "../scenario/assertions.ts";
import { acceptReview, defineCommonTests, finishWorker, sampleRequest } from "../scenario/common-tests.ts";
import type { CreateFixture } from "../scenario/common-tests.ts";
import type { Point } from "../scenario/contract.ts";
import { FakeOwners } from "../scenario/owners.ts";
import { SwitchboardScenario } from "./driver.ts";
import { ApplicationStore } from "./store.ts";

const root = fileURLToPath(new URL("../../../.investigation/durable-orchestration/", import.meta.url));
const create: CreateFixture = async (options = {}) => {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "design-a-"));
  const host = join(directory, "host");
  const owners = new FakeOwners(join(directory, "owners"), host, options.interrupt);
  await owners.initialise();
  const store = await ApplicationStore.open(host);
  await store.seed(["happy", "request-1", "one", "two", "three"].map(id => sampleRequest(id).taskId));
  const now = 1_000_000;
  const driver = new SwitchboardScenario(store, owners, { ...options, now: () => now });
  return { driver, owners, now, close: async () => {
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  } };
};

defineCommonTests("A", create);

test("A: production task and attempt operations own start, review hold, acceptance and return confirmation", async t => {
  const fixture = await create();
  t.after(() => fixture.close());
  const driver = fixture.driver as SwitchboardScenario;
  const request = sampleRequest();
  await driver.submit(request);
  let attempt = await findAttempt(driver, request.requestId);
  assert.equal((await driver.store.tasks.read(request.taskId))!.state, "in_flight");
  assert.equal(await driver.store.runtime.launchKind("scenario", attempt.identity!.leaseId), "launch");
  assert.equal(driver.store.attempts.activeCount(), 1);
  await finishWorker(fixture, request);
  await driver.advance(request.requestId);
  const held = (await driver.store.tasks.read(request.taskId))!;
  assert.equal(held.held, true);
  assert.equal(held.holdReason, "review required");
  assert.equal(driver.store.attempts.activeCount(), 0);
  await acceptReview(fixture, request);
  await assertSuccessful(driver, fixture.owners, request, await driver.advance(request.requestId));
  attempt = await findAttempt(driver, request.requestId);
  const record = driver.store.record(attempt);
  assert.equal(record.entries.filter(entry => entry.kind === "task_recorded").length, 2);
  assert.equal(record.confirmations!.filter(confirmation => confirmation.fact === "output_accepted").length, 1);
  assert.equal(record.confirmations!.filter(confirmation => confirmation.fact === "no_processes").length, 1);
  assert.equal((await driver.store.tasks.read(request.taskId))!.state, "done");
  assert.equal(Number(driver.store.tasks.database.get("PRAGMA synchronous")!.synchronous), 2);
});

test("A: reopening during review derives the remaining steps from application and owner facts", async t => {
  const fixture = await create();
  let reopened: SwitchboardScenario | undefined;
  t.after(async () => { await reopened?.close(); await fixture.close(); });
  const driver = fixture.driver as SwitchboardScenario;
  const request = sampleRequest();
  await driver.submit(request);
  await finishWorker(fixture, request);
  await driver.advance(request.requestId);
  const directory = driver.store.directory;
  await driver.close();
  reopened = new SwitchboardScenario(await ApplicationStore.open(directory), fixture.owners, { now: () => fixture.now });
  await acceptReview({ ...fixture, driver: reopened }, request);
  await assertSuccessful(reopened, fixture.owners, request, await reopened.advance(request.requestId));
  assert.deepEqual(await reopened.submit(request), await reopened.advance(request.requestId));
});

test("A: reopening with an unobserved worker refuses adoption, relaunch and new dispatch", async t => {
  const fixture = await create();
  let reopened: SwitchboardScenario | undefined;
  t.after(async () => { await reopened?.close(); await fixture.close(); });
  const driver = fixture.driver as SwitchboardScenario;
  const request = sampleRequest();
  await driver.submit(request);
  const directory = driver.store.directory;
  await driver.close();
  reopened = new SwitchboardScenario(await ApplicationStore.open(directory), fixture.owners, { maxAttempts: 2 });
  assertRefused(await reopened.advance(request.requestId), "possibly_running");
  assertRefused(await reopened.submit(sampleRequest("two")), "possibly_running");
  await assertRetained(reopened, fixture.owners, request.requestId);
  const counters = await fixture.owners.counters((await findAttempt(reopened, request.requestId)).id);
  assert.equal(counters.launch, 1);
  assert.equal(counters.prompt, 1);
});

for (const [point, code] of [
  ["acquire:effect:after", "acquisition_uncertain"],
  ["launch:effect:after", "possibly_running"],
  ["prompt:effect:after", "possibly_running"],
  ["return:effect:after", "finalisation_uncertain"],
] as const) {
  test(`A: an adapter interruption at ${point} is not permission to repeat the effect`, async t => {
    let armed = true;
    const fixture = await create({ interrupt: async (boundary: Point) => {
      if (armed && boundary === point) { armed = false; throw new Error("Injected lost acknowledgement"); }
    } });
    let reopened: SwitchboardScenario | undefined;
    t.after(async () => { await reopened?.close(); await fixture.close(); });
    const driver = fixture.driver as SwitchboardScenario;
    const request = sampleRequest();
    await driver.submit(request);
    if (point === "return:effect:after") {
      await finishWorker(fixture, request);
      await acceptReview(fixture, request);
      assertRefused(await driver.advance(request.requestId), "host_unavailable");
    }
    const before = await fixture.owners.counters((await findAttempt(driver, request.requestId)).id);
    await driver.close();
    reopened = new SwitchboardScenario(await ApplicationStore.open(driver.store.directory), fixture.owners, { now: () => fixture.now });
    assertRefused(await reopened.submit(request), code);
    assertRefused(await reopened.advance(request.requestId), code);
    const after = await fixture.owners.counters((await findAttempt(reopened, request.requestId)).id);
    assert.deepEqual(after, before);
    assert.equal((await reopened.inspect()).attempts.length, 1);
  });
}

test("A: production dependency readiness is enforced independently of the fake owner controls", async t => {
  const fixture = await create();
  t.after(() => fixture.close());
  const driver = fixture.driver as SwitchboardScenario;
  const request = sampleRequest();
  await driver.store.tasks.block(request.taskId, sampleRequest("two").taskId);
  assertRefused(await driver.submit(request), "not_ready");
  assert.equal((await driver.inspect()).attempts.length, 0);
  assert.deepEqual(await fixture.owners.records(), []);
});

test("A: an operator task edit after accepting output is not overwritten by finalisation", async t => {
  let driver: SwitchboardScenario;
  const request = sampleRequest();
  const fixture = await create({ interrupt: async point => {
    if (point === "accepted:ack:after") await driver.store.tasks.hold(request.taskId, "operator decision");
  } });
  driver = fixture.driver as SwitchboardScenario;
  t.after(() => fixture.close());
  await driver.submit(request);
  await finishWorker(fixture, request);
  await acceptReview(fixture, request);
  assertRefused(await driver.advance(request.requestId), "not_ready");
  assert.equal((await driver.store.tasks.read(request.taskId))!.holdReason, "operator decision");
  await assertRetained(driver, fixture.owners, request.requestId);
});
