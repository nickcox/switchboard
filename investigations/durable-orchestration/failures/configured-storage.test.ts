import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fullSettings } from "./configured-storage.ts";

const root = fileURLToPath(new URL("../../../.investigation/durable-orchestration/", import.meta.url));
const program = fileURLToPath(new URL("../smoke.ts", import.meta.url));
for (let repeat = 1; repeat <= 3; repeat++) {
  test(`caller-configured Durable SQLite restart probe – repeat ${repeat}`, async t => {
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "full-sqlite-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const pids: number[] = [];
    const run = (mode: string, status: number) => {
      const child = spawnSync(process.execPath, [program, mode, directory, "full-sqlite"], { encoding: "utf8", timeout: 10_000 });
      assert.ifError(child.error);
      assert.equal(child.signal, null, child.stderr);
      assert.equal(child.status, status, child.stderr);
      pids.push(child.pid);
      return child.stdout;
    };
    run("start", 75);
    const resumed = JSON.parse(run("resume", 0));
    assert.deepEqual(resumed.recovered, { status: "pending", checkpoint: { phase: "finish", requestId: "baseline-1" } });
    const inspected = JSON.parse(run("inspect", 0));
    assert.equal(inspected.taskId, resumed.taskId);
    assert.equal(inspected.state.outcome.result, "checkpoint recovered");
    const phases = (await readFile(join(directory, "phases.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(phases, [{ phase: "prepare", taskId: resumed.taskId }, { phase: "finish", taskId: resumed.taskId }]);
    const measurements = (await readFile(join(directory, "settings.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual([...new Set(measurements.map(row => row.pid))], pids);
    for (const row of measurements) assert.deepEqual(row.settings, fullSettings);
    console.log(JSON.stringify({ experiment: "configured-sqlite", repeat, phases, measurements }));
  });
}
