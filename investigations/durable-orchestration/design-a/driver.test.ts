import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertRefused, assertRetained, assertSuccessful, findAttempt } from "../scenario/assertions.ts";
import { acceptReview, defineCommonTests, finishWorker, sampleRequest } from "../scenario/common-tests.ts";
import type { CreateFixture } from "../scenario/common-tests.ts";
import { FakeOwners } from "../scenario/owners.ts";
import { SwitchboardScenario } from "./driver.ts";
import { ApplicationStore } from "./store.ts";

const root = fileURLToPath(new URL("../../../.investigation/durable-orchestration/", import.meta.url));
export const create: CreateFixture = async (options = {}) => {
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
  t.after(() => fixture.close());
  const driver = fixture.driver as SwitchboardScenario;
  const request = sampleRequest();
  await driver.submit(request);
  await finishWorker(fixture, request);
  await driver.advance(request.requestId);
  const directory = driver.store.directory;
  await driver.close();
  const reopened = new SwitchboardScenario(await ApplicationStore.open(directory), fixture.owners, { now: () => fixture.now });
  t.after(() => reopened.close());
  await acceptReview({ ...fixture, driver: reopened }, request);
  await assertSuccessful(reopened, fixture.owners, request, await reopened.advance(request.requestId));
  assert.deepEqual(await reopened.submit(request), await reopened.advance(request.requestId));
});

test("A: reopening with an unobserved worker refuses adoption, relaunch and new dispatch", async t => {
  const fixture = await create();
  t.after(() => fixture.close());
  const driver = fixture.driver as SwitchboardScenario;
  const request = sampleRequest();
  await driver.submit(request);
  const directory = driver.store.directory;
  await driver.close();
  const reopened = new SwitchboardScenario(await ApplicationStore.open(directory), fixture.owners, { maxAttempts: 2 });
  t.after(() => reopened.close());
  assertRefused(await reopened.advance(request.requestId), "possibly_running");
  assertRefused(await reopened.submit(sampleRequest("two")), "possibly_running");
  await assertRetained(reopened, fixture.owners, request.requestId);
  const counters = await fixture.owners.counters((await findAttempt(reopened, request.requestId)).id);
  assert.equal(counters.launch, 1);
  assert.equal(counters.prompt, 1);
});
