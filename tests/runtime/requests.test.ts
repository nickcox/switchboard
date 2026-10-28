import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { awaitDelivery, claimRequest, recordResult, submitRequest, unclaimedRequests } from "../../src/runtime/requests.ts";
import { fixture, withRuntimeDatabase } from "../helpers.ts";

const peer = resolve("tests/fixtures/runtime-request.ts");
const run = promisify(execFile);

test("a request is forwarded once or withdrawn, never both; claims and results cannot be changed", async () => {
  const f = fixture();
  const record = await f.records.reserve(f.input);
  for (let index = 0; index < 8; index += 1) {
    const request = await submitRequest(record, { kind: "person", id: "operator" }, { kind: "steer", message: "Keep the fix small" });
    const [forwarded, withdrawn] = await Promise.all([
      claimRequest(record, request.id, "dispatcher"), claimRequest(record, request.id, "withdrawn"),
    ]);
    assert.equal(Number(forwarded) + Number(withdrawn), 1);
    assert.equal(await claimRequest(record, request.id, "dispatcher"), false);
    assert.equal(await claimRequest(record, request.id, "withdrawn"), false);
    if (forwarded) {
      await recordResult(record, request.id, { outcome: "queued" });
      assert.equal((await awaitDelivery(record, request.id, 1, 1)).state, "delivered");
      await assert.rejects(recordResult(record, request.id, { outcome: "handled" }));
    } else {
      await assert.rejects(recordResult(record, request.id, { outcome: "queued" }));
      assert.equal((await awaitDelivery(record, request.id, 1, 1)).state, "undelivered");
    }
    await withRuntimeDatabase(f.records, async database => {
      await assert.rejects(database.transaction(() => database.run("UPDATE control_requests SET claimed_by = 'withdrawn' WHERE id = ?", request.id)), /claims cannot be changed/);
    });
  }
  assert.deepEqual(await unclaimedRequests(record), []);
});

test("submitting with an old runtime snapshot refuses an observed exit or a stop confirmation", async () => {
  for (const stopped of [false, true]) {
    const f = fixture();
    const record = await f.records.reserve(f.input);
    if (stopped) await f.records.recordOperatorStop(record);
    else await f.records.recordChildExit(record, { started: true, code: 0, signal: null });
    assert.equal(record.child.status, "unknown", "the caller still has its old snapshot");
    await assert.rejects(submitRequest(record, { kind: "person", id: "operator" }, { kind: "stop" }), /not running/);
    assert.deepEqual(await unclaimedRequests(record), []);
  }
});

test("only the owning dispatcher or the original sender can claim a request", async () => {
  const f = fixture();
  const record = await f.records.reserve(f.input);
  const request = await submitRequest(record, { kind: "person", id: "operator:parent" }, { kind: "stop" });
  const result = await run(process.execPath, [peer, join(f.dir, "runtime"), f.records.databasePath, f.input.identity.contextId, record.claimId, "foreign", request.id]);
  assert.deepEqual(JSON.parse(result.stdout), { dispatcher: false, withdrawn: false });
  assert.equal(await claimRequest({ ...record, claimId: "a-different-claim" }, request.id, "dispatcher"), false);
  assert.equal(await claimRequest(record, request.id, "dispatcher"), true);
  await recordResult(record, request.id, { outcome: "stopping" });
});

test("a sender in another process racing the owning dispatcher has exactly one winner", async () => {
  const f = fixture();
  const record = await f.records.reserve(f.input);
  for (let index = 0; index < 4; index += 1) {
    const child = spawn(process.execPath, [peer, join(f.dir, "runtime"), f.records.databasePath, f.input.identity.contextId, record.claimId, "sender"], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr!.on("data", bytes => { stderr += String(bytes); });
    const exited = once(child, "exit");
    try {
      const [ready] = await once(child, "message") as [{ id: string }];
      const withdrawn = once(child, "message") as Promise<[{ withdrawn: boolean }]>;
      child.send("withdraw");
      const forwarded = await claimRequest(record, ready.id, "dispatcher");
      const [sender] = await withdrawn;
      assert.equal(Number(forwarded) + Number(sender.withdrawn), 1);
      assert.equal(await claimRequest(record, ready.id, "dispatcher"), false);
      if (forwarded) await recordResult(record, ready.id, { outcome: "stopping" });
      assert.equal((await exited)[0], 0, stderr);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
    }
  }
});

test("a claimed request with no result is reported but never forwarded again, even after claim release", async () => {
  const f = fixture();
  const record = await f.records.reserve(f.input);
  const request = await submitRequest(record, { kind: "person", id: "operator" }, { kind: "stop" });
  assert.equal(await claimRequest(record, request.id, "dispatcher"), true);
  await record.storage.releaseClaim(record.claimId);
  assert.deepEqual(await awaitDelivery(record, request.id, 1, 1), { state: "claimed" });
  assert.equal(await claimRequest(record, request.id, "dispatcher"), false);
  assert.equal(await claimRequest(record, request.id, "withdrawn"), false);
  assert.deepEqual(await unclaimedRequests(record), []);
});
