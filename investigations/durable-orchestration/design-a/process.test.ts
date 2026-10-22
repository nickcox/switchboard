import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertSuccessful, findAttempt } from "../scenario/assertions.ts";
import { acceptReview, sampleRequest } from "../scenario/common-tests.ts";
import { SwitchboardScenario } from "./driver.ts";
import { ProcessOwners } from "./process-owners.ts";
import { ApplicationStore } from "./store.ts";

const root = fileURLToPath(new URL("../../../.investigation/durable-orchestration/", import.meta.url));

test("A: a real child writes its result before exit, which remains separate from acceptance and return", async t => {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "design-a-child-"));
  const host = join(directory, "host");
  const request = sampleRequest();
  const owners = new ProcessOwners(join(directory, "owners"), host, request);
  await owners.initialise();
  const store = await ApplicationStore.open(host);
  await store.seed([request.taskId]);
  const now = 1_000_000;
  const driver = new SwitchboardScenario(store, owners, { now: () => now });
  t.after(async () => {
    await owners.close();
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  });
  const fixture = { driver, owners, now, close: async () => {} };
  const waiting = await driver.submit(request);
  assert.equal(waiting.status, "waiting");
  const attempt = await findAttempt(driver, request.requestId);
  const workerDirectory = join(owners.directory, "workers", attempt.id);
  const childReport = JSON.parse(await readFile(join(workerDirectory, "result.json"), "utf8"));
  assert.deepEqual(childReport.identity, attempt.identity);
  const prompts = (await readFile(join(workerDirectory, "prompts.jsonl"), "utf8")).trim().split("\n");
  assert.equal(prompts.length, 1, "The child independently records one initial prompt");
  assert.deepEqual(await driver.advance(request.requestId), waiting);
  assert.equal((await owners.counters(attempt.id)).worker_exit, 0, "A result file does not prove child exit");
  assert.equal((await driver.inspect()).attempts[0]!.result, null);
  await owners.observeExit();
  assert.equal((await owners.counters(attempt.id)).worker_exit, 1);
  const review = await driver.advance(request.requestId);
  assert.equal(review.status, "waiting");
  if (review.status === "waiting") assert.equal(review.waitingFor, "review");
  assert.equal((await owners.counters(attempt.id)).return, 0, "Direct-child exit does not authorise lease return");
  await owners.setControls({ ...await owners.controls(), retainedCommit: childReport.commit, approvals: [{
    id: "operator-approval", by: "operator", attemptId: attempt.id, leaseId: attempt.identity!.leaseId,
    commit: childReport.commit, expiresAt: now + 10_000, accept: true, noProcesses: true,
  }] });
  await acceptReview(fixture, request);
  await assertSuccessful(driver, owners, request, await driver.advance(request.requestId));
});
