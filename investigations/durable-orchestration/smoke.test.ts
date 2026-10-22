import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const temporaryRoot = fileURLToPath(new URL("../../.investigation/durable-orchestration/", import.meta.url));
const program = fileURLToPath(new URL("./smoke.ts", import.meta.url));

test("released Durable recovers a checkpoint in a new Node process using JSONL files", async () => {
  assert.equal(process.version, "v26.7.0", "Qualify the repository's pinned Node version");
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, "smoke-"));
  const run = (mode: string, status: number) => {
    const child = spawnSync(process.execPath, [program, mode, directory], { encoding: "utf8", timeout: 10_000 });
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, status, child.stderr);
    return child.stdout;
  };
  try {
    run("start", 75);
    const resumed = JSON.parse(run("resume", 0));
    assert.equal(resumed.node, "v26.7.0");
    assert.equal(resumed.recovered.checkpoint.phase, "finish");
    const inspected = JSON.parse(run("inspect", 0));
    assert.equal(inspected.taskId, resumed.taskId);
    assert.equal(inspected.state.outcome.result, "checkpoint recovered");
    const phases = (await readFile(join(directory, "phases.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(phases, [{ phase: "prepare", taskId: resumed.taskId }, { phase: "finish", taskId: resumed.taskId }]);
    console.log(JSON.stringify({ node: resumed.node, phases, result: inspected.state.outcome }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
