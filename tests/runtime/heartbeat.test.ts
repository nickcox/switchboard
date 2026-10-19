import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { dispatcherRunning, startHeartbeat } from "../../src/runtime/heartbeat.ts";

test("heartbeat freshness is diagnostic and uses the timestamp, not the process ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "switchboard-heartbeat-"));
  const path = join(directory, "heartbeat.json");
  try {
    assert.equal(await dispatcherRunning(directory), false);
    const now = Date.now();
    await writeFile(path, JSON.stringify({ version: 1, at: new Date(now).toISOString(), pid: 2147483647 }));
    assert.equal(await dispatcherRunning(directory, now), true);
    assert.equal(await dispatcherRunning(directory, now + 29_999), true);
    assert.equal(await dispatcherRunning(directory, now + 30_000), false);
    assert.equal(await dispatcherRunning(directory, now - 1), false);
    await writeFile(path, "partial JSON");
    assert.equal(await dispatcherRunning(directory), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the dispatcher refreshes its heartbeat and removes it when ownership ends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "switchboard-heartbeat-"));
  const stop = await startHeartbeat(directory, 10);
  try {
    const path = join(directory, "heartbeat.json");
    const first = JSON.parse(await readFile(path, "utf8"));
    assert.equal(first.pid, process.pid);
    assert.equal(await dispatcherRunning(directory), true);
    let refreshed = false;
    for (let i = 0; i < 50; i += 1) {
      await sleep(10);
      if (JSON.parse(await readFile(path, "utf8")).at !== first.at) { refreshed = true; break; }
    }
    assert.equal(refreshed, true);
  } finally {
    await stop();
    assert.equal(await dispatcherRunning(directory), false);
    await rm(directory, { recursive: true, force: true });
  }
});
