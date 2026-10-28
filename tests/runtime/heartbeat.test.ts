import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { dispatcherRunning, startHeartbeat } from "../../src/runtime/heartbeat.ts";
import { fixture, withRuntimeDatabase } from "../helpers.ts";

test("heartbeat freshness is diagnostic and uses the timestamp, not the process ID", async () => {
  const f = fixture();
  const record = await f.records.reserve(f.input);
  const claim = (await record.storage.heartbeat(record.claimId))!;
  const now = Date.parse(String(claim.heartbeat_at));
  await withRuntimeDatabase(f.records, database => database.transaction(() => database.run("UPDATE worker_claims SET owner_pid = ? WHERE id = ?", 2147483647, record.claimId)));
  assert.equal(await dispatcherRunning(record, now), true);
  assert.equal(await dispatcherRunning(record, now + 29_999), true);
  assert.equal(await dispatcherRunning(record, now + 30_000), false);
  assert.equal(await dispatcherRunning(record, now - 1), false);
  await assert.rejects(record.storage.refreshClaim(record.claimId), /no longer owns/);
  await assert.rejects(f.records.reserve(f.input), /launch row/);
});

test("the dispatcher refreshes its claim and releases it without removing the launch row", async () => {
  const f = fixture();
  const record = await f.records.reserve(f.input);
  const stop = await startHeartbeat(record, 10);
  try {
    const first = (await record.storage.heartbeat(record.claimId))!;
    assert.equal(first.owner_pid, process.pid);
    assert.equal(await dispatcherRunning(record), true);
    let refreshed = false;
    for (let i = 0; i < 50; i += 1) {
      await sleep(10);
      if ((await record.storage.heartbeat(record.claimId))!.heartbeat_at !== first.heartbeat_at) { refreshed = true; break; }
    }
    assert.equal(refreshed, true);
  } finally { await stop(); }
  assert.equal(await dispatcherRunning(record), false);
  assert.ok((await record.storage.heartbeat(record.claimId))!.released_at);
  await assert.rejects(f.records.reserve(f.input), /launch row/);
  await f.records.recordOperatorStop(record, { kind: "person", id: "operator:test" });
  await assert.rejects(f.records.reserve(f.input), /launch row/);
});
