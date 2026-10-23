import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SwitchboardScenario } from "../design-a/driver.ts";
import { ApplicationStore } from "../design-a/store.ts";
import { DurableScenario } from "../design-b/engine.ts";
import { Operations } from "../design-b/operations.ts";
import { assertRefused } from "./assertions.ts";
import { acceptReview, finishWorker, sampleRequest } from "./common-tests.ts";
import { FakeOwners } from "./owners.ts";

const root = fileURLToPath(new URL("../../../.investigation/durable-orchestration/", import.meta.url));
for (const design of ["A", "B"]) test(`${design}: approval loss after intent waits, but restored approval cannot erase uncertainty`, async t => {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "approval-intent-"));
  const owners = new FakeOwners(join(directory, "owners"), join(directory, "host"));
  await owners.initialise();
  const store = await ApplicationStore.open(join(directory, "host"));
  const request = sampleRequest();
  await store.seed([request.taskId]);
  const options = { now: () => 1_000_000, manualClock: true };
  const driver = design === "A" ? new SwitchboardScenario(store, owners, options)
    : await DurableScenario.open(new Operations(store, owners, options), options);
  t.after(async () => { await driver.close(); await rm(directory, { recursive: true, force: true }); });
  const fixture = { driver, owners, now: 1_000_000, close: () => driver.close() };
  await driver.submit(request);
  await finishWorker(fixture, request);
  await acceptReview(fixture, request);
  const controls = owners.controls.bind(owners);
  owners.controls = async () => {
    const value = await controls();
    return store.record(store.byRequest(request.requestId)!).entries.some(entry => entry.kind === "lease_return_started")
      ? { ...value, approvals: [] } : value;
  };
  for (let i = 0; i < 2; i++) {
    assertRefused(await driver.advance(request.requestId), "approval_required");
    if (driver instanceof DurableScenario) {
      assert.equal((await driver.harness.inspect(BACKGROUND_CONTEXT)).tasks[0]!.record.state.status, "sleeping");
    }
  }
  owners.controls = controls;
  assertRefused(await driver.advance(request.requestId), "finalisation_uncertain");
  assert.equal((await owners.counters(store.byRequest(request.requestId)!.id)).return, 0);
});
