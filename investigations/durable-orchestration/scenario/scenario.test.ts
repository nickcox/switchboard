import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { defineCommonTests, finishWorker, acceptReview, sampleRequest } from "./common-tests.ts";
import { assertRefused, assertRetained } from "./assertions.ts";
import type { CreateFixture } from "./common-tests.ts";
import { FakeOwners } from "./owners.ts";
import { InProcessScenario } from "./reference.ts";

const root = fileURLToPath(new URL("../../../.investigation/durable-orchestration/", import.meta.url));
const create: CreateFixture = async (options = {}) => {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "scenario-"));
  const owners = new FakeOwners(join(directory, "owners"), join(directory, "host"), options.interrupt);
  await owners.initialise();
  const now = 1_000_000;
  const driver = new InProcessScenario(owners, { ...options, now: () => now });
  return { driver, owners, now, close: () => rm(directory, { recursive: true, force: true }) };
};

defineCommonTests("in-process contract exerciser", create);

test("readiness is rechecked after acquisition and before starting work", async t => {
  let owners: FakeOwners;
  const fixture = await create({ interrupt: async point => {
    if (point === "workspace:ack:after") await owners.setControls({ ...await owners.controls(), ready: false });
  } });
  owners = fixture.owners;
  t.after(() => fixture.close());
  const request = sampleRequest();
  assertRefused(await fixture.driver.submit(request), "not_ready");
  const snapshot = await fixture.driver.inspect();
  assert.equal(snapshot.attempts[0]?.started, false);
  assert.equal((await owners.counters(snapshot.attempts[0]!.id)).launch, 0);
  await assertRetained(fixture.driver, owners, request.requestId);
});

for (const boundary of ["accepted:ack:after", "done:ack:after"] as const) {
  test(`approval is rechecked after ${boundary}`, async t => {
    let owners: FakeOwners;
    const fixture = await create({ interrupt: async point => {
      if (point === boundary) await owners.setControls({ ...await owners.controls(), approvals: [] });
    } });
    owners = fixture.owners;
    t.after(() => fixture.close());
    const request = sampleRequest();
    await fixture.driver.submit(request);
    await finishWorker(fixture, request);
    await acceptReview(fixture, request);
    assertRefused(await fixture.driver.advance(request.requestId), "approval_required");
    await assertRetained(fixture.driver, owners, request.requestId);
  });
}

test("adapters do not hide duplicate calls from independent counters", async t => {
  const fixture = await create();
  t.after(() => fixture.close());
  const identity = await fixture.owners.acquire("context", "task", "attempt");
  await fixture.owners.launch(identity);
  await fixture.owners.launch(identity);
  await fixture.owners.prompt(identity);
  await fixture.owners.prompt(identity);
  const freshReader = new FakeOwners(fixture.owners.directory, join(root, "other-host"));
  const counters = await freshReader.counters("attempt");
  assert.equal(counters.acquire, 1);
  assert.equal(counters.launch, 2);
  assert.equal(counters.prompt, 2);
});

test("owner evidence cannot be placed inside execution-host storage", () => {
  assert.throws(() => new FakeOwners(join(root, "host", "owners"), join(root, "host")), /disjoint/);
  assert.throws(() => new FakeOwners(join(root, "owners"), join(root, "owners", "host")), /disjoint/);
});
