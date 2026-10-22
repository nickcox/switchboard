import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertRefused, assertSuccessful, findAttempt } from "../scenario/assertions.ts";
import { acceptReview, sampleRequest } from "../scenario/common-tests.ts";
import { ProcessOwners } from "../design-a/process-owners.ts";
import { ExecutionHost } from "./host.ts";
import { HostClient } from "./client.ts";

const root = fileURLToPath(new URL("../../../.investigation/durable-orchestration/", import.meta.url));

test("B: the host owns a real child; its result, positive exit and operator acceptance are separate", async t => {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "design-b-child-"));
  const request = sampleRequest();
  const owners = new ProcessOwners(join(directory, "owners"), join(directory, "host"), request);
  await owners.initialise();
  const now = 1_000_000;
  const host = await ExecutionHost.open(directory, owners, { now: () => now, manualClock: true,
    seedTaskIds: [request.taskId], closeWorkers: () => owners.close() });
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });
  const driver = new HostClient(directory);
  const fixture = { driver, owners, now, close: async () => {} };
  const waiting = await driver.submit(request);
  const attempt = await findAttempt(driver, request.requestId);
  const workerDirectory = join(owners.directory, "workers", attempt.id);
  const report = JSON.parse(await readFile(join(workerDirectory, "result.json"), "utf8"));
  assert.deepEqual(report.identity, attempt.identity);
  assert.equal((await readFile(join(workerDirectory, "prompts.jsonl"), "utf8")).trim().split("\n").length, 1);
  assert.deepEqual(await driver.advance(request.requestId), waiting);
  assert.equal((await owners.counters(attempt.id)).worker_exit, 0);
  assert.equal((await findAttempt(driver, request.requestId)).result, null);
  await owners.observeExit();
  const review = await driver.advance(request.requestId);
  assert.equal(review.status, "waiting");
  if (review.status === "waiting") assert.equal(review.waitingFor, "review");
  assert.equal((await owners.counters(attempt.id)).return, 0);
  await owners.setControls({ ...await owners.controls(), retainedCommit: report.commit, approvals: [{
    id: "operator", by: "operator", attemptId: attempt.id, leaseId: attempt.identity!.leaseId,
    commit: report.commit, expiresAt: now + 10_000, accept: true, noProcesses: true,
  }] });
  await acceptReview(fixture, request);
  await assertSuccessful(driver, owners, request, await driver.advance(request.requestId));
});

test("B: shutdown joins the host's synthetic child without treating orchestration close as termination evidence", async t => {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "design-b-shutdown-"));
  const request = sampleRequest();
  const owners = new ProcessOwners(join(directory, "owners"), join(directory, "host"), request);
  await owners.initialise();
  const host = await ExecutionHost.open(directory, owners, { manualClock: true,
    seedTaskIds: [request.taskId], closeWorkers: () => owners.close() });
  let reopened: ExecutionHost | undefined;
  t.after(async () => { await reopened?.close(); await host.close(); await rm(directory, { recursive: true, force: true }); });
  const driver = new HostClient(directory);
  await driver.submit(request);
  const attempt = await findAttempt(driver, request.requestId);
  await host.close();
  const counts = await owners.counters(attempt.id);
  assert.equal(counts.worker_exit, 0, "The fixture did not observe a successful worker exit");
  assert.equal(counts.cancel, 0, "Closing orchestration is distinct from requesting worker cancellation");
  assert.equal(counts.return, 0);
  reopened = await ExecutionHost.open(directory, owners, { manualClock: true });
  assertRefused(await driver.submit(request), "possibly_running");
  assert.equal((await owners.counters(attempt.id)).launch, 1);
});
