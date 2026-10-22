import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { defineCommonTests } from "./common-tests.ts";
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
