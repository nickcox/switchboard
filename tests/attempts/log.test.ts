import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { mkdtempSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AttemptConflict, AttemptLog } from "../../src/attempts/log.ts";
import { key, RuntimeRecords } from "../../src/runtime/records.ts";

const evidence = resolve(import.meta.dirname, "../../.investigation/attempts-unit");
mkdirSync(evidence, { recursive: true });
const freshRoot = () => mkdtempSync(join(evidence, "case-"));

test("creates numbered attempts and appends entries in order", async () => {
  const log = new AttemptLog(freshRoot(), "context-a");
  const first = await log.create("task-1", { requestId: "req-1" }, 0);
  await log.append(first, "halted", { stage: "select", reason: "fixture" });
  const second = await log.create("task-1", {}, 1);
  assert.deepEqual([first.attempt, second.attempt], [1, 2]);
  const record = await log.read(first);
  assert.deepEqual(record.entries.map(entry => [entry.sequence, entry.kind]), [[0, "requested"], [1, "halted"]]);
  assert.deepEqual((await log.forTask("task-1")).map(r => r.attempt), [1, 2]);
  assert.equal((await log.findByRequest("req-1"))?.attempt, 1);
  assert.equal(await log.findByRequest("req-unknown"), undefined);
});

test("different-kind concurrent appends claim one sequence only", async () => {
  const root = freshRoot();
  const first = new AttemptLog(root, "c");
  const second = new AttemptLog(root, "c");
  const ref = await first.create("task-1", {}, 0);
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  for (const log of [first, second]) {
    const read = log.read.bind(log);
    log.read = async reference => {
      const record = await read(reference);
      if (++arrived === 2) release();
      await barrier;
      return record;
    };
  }
  const results = await Promise.allSettled([
    first.append(ref, "operator_resolved", { action: "worker_stopped" }),
    second.append(ref, "worker_finished", { status: "exited", runtimeDirectory: root }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected");
  assert.equal(rejected?.reason.code, "EEXIST");
  const reader = new AttemptLog(root, "c");
  assert.equal((await reader.read(ref)).entries.length, 2);
  await reader.append(ref, "halted", { stage: "test", reason: "after conflict" });
  assert.equal((await reader.list())[0]?.entries.length, 3);
});

test("legacy entries can be read and extended without accepting duplicate sequences or wrong kinds", async () => {
  const root = freshRoot();
  const log = new AttemptLog(root, "c");
  const ref = await log.create("task-1", {}, 0);
  const directory = join(root, "attempts", key("c"), key("task-1"), "1");
  renameSync(join(directory, "0000.json"), join(directory, "0000-requested.json"));
  await log.append(ref, "halted", { stage: "test", reason: "fixture" });
  assert.deepEqual((await log.list())[0]?.entries.map(entry => entry.kind), ["requested", "halted"]);
  renameSync(join(directory, "0001.json"), join(directory, "0001-worker_finished.json"));
  await assert.rejects(log.read(ref), /storage location/);
  renameSync(join(directory, "0001-worker_finished.json"), join(directory, "0001-halted.json"));
  const entry = (await log.read(ref)).entries[1];
  writeFileSync(join(directory, "0001.json"), JSON.stringify(entry));
  await assert.rejects(log.read(ref), /sequence/);
});

// Creating ten thousand files is slow on Windows runners, so this test has a longer limit than the default.
test("sequence 10000 remains readable and sorts after 9999", { timeout: 120_000 }, async () => {
  const root = freshRoot();
  const log = new AttemptLog(root, "c");
  const ref = await log.create("task-1", {}, 0);
  const directory = join(root, "attempts", key("c"), key("task-1"), "1");
  // Seed the preceding observations without thousands of append readbacks.
  for (let first = 1; first < 10000; first += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 10000 - first) }, (_, offset) => first + offset).map(sequence =>
      writeFile(join(directory, `${String(sequence).padStart(4, "0")}-halted.json`), JSON.stringify({
        version: 1, ...ref, sequence, kind: "halted", recordedAt: new Date().toISOString(),
        data: { stage: "test", reason: "fixture" },
      }))));
  }
  await log.append(ref, "operator_resolved", { action: "worker_stopped" });
  const record = await log.read(ref);
  assert.equal(record.entries.length, 10001);
  assert.equal(record.entries.at(-1)?.sequence, 10000);
  assert.equal(record.entries.at(-1)?.kind, "operator_resolved");
});

test("creation is conditional on the latest attempt the caller inspected", async () => {
  const log = new AttemptLog(freshRoot(), "c");
  await log.create("task-1", {}, 0);
  // A caller that inspected no attempts, or a stale latest attempt, must not create another.
  await assert.rejects(log.create("task-1", {}, 0), AttemptConflict);
  await assert.rejects(log.create("task-1", {}, 2), AttemptConflict);
  assert.deepEqual((await log.forTask("task-1")).map(r => r.attempt), [1]);
});

test("an empty or missing log lists nothing", async () => {
  const log = new AttemptLog(join(freshRoot(), "not-created"), "context-a");
  assert.deepEqual(await log.list(), []);
  assert.deepEqual(await log.forTask("task-1"), []);
});

test("contexts are separate", async () => {
  const root = freshRoot();
  await new AttemptLog(root, "context-a").create("task-1", {}, 0);
  assert.deepEqual(await new AttemptLog(root, "context-b").list(), []);
});

test("concurrent creation in one process has exactly one winner", async () => {
  const root = freshRoot();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => new AttemptLog(root, "c").create("task-1", {}, 0)));
  const won = results.filter(r => r.status === "fulfilled");
  const conflicts = results.filter(r => r.status === "rejected" && r.reason instanceof AttemptConflict);
  assert.equal(won.length, 1);
  assert.equal(conflicts.length, 7);
});

test("concurrent creation across processes has exactly one winner", async () => {
  const script = join(import.meta.dirname, "../fixtures/create-attempt.ts");
  for (let round = 0; round < 5; round += 1) {
    const root = freshRoot();
    const go = join(root, "go");
    const outputs = Array.from({ length: 4 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [script, root, "c", "task-1", go], { stdio: ["ignore", "pipe", "inherit"] });
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (text: string) => { output += text; });
      child.once("error", reject);
      child.once("close", () => resolve(output.trim()));
    }));
    await sleep(300);
    writeFileSync(go, "");
    const results = await Promise.all(outputs);
    assert.equal(results.filter(o => o === "created").length, 1);
    assert.equal(results.filter(o => o === "conflict").length, 3);
  }
});

test("unreadable or inconsistent entries cause refusal, not an empty result", async () => {
  const root = freshRoot();
  const log = new AttemptLog(root, "c");
  const ref = await log.create("task-1", {}, 0);
  const context = join(root, "attempts", readdirSync(join(root, "attempts"))[0]!);
  const attemptDir = join(context, readdirSync(context)[0]!, "1");
  writeFileSync(join(attemptDir, "0002-halted.json"), "{}");
  await assert.rejects(log.read(ref), /sequence/);
  await assert.rejects(log.list());
});

test("entry data is validated before it is written", async () => {
  const log = new AttemptLog(freshRoot(), "c");
  const ref = await log.create("task-1", {}, 0);
  await assert.rejects(log.append(ref, "leased", { leaseId: "l", workspace: "/w", baseRef: "main", outputBranch: "b", startingCommit: "abc" }));
  assert.equal((await log.read(ref)).entries.length, 1);
});

test("attempt log and runtime records share a root without breaking runtime discovery", async () => {
  const root = freshRoot();
  await new AttemptLog(root, "c").create("task-1", {}, 0);
  assert.deepEqual(await new RuntimeRecords(root).discover("c"), []);
});

test("a full attempt record can be passed as the reference when appending", async () => {
  const log = new AttemptLog(freshRoot(), "c");
  const ref = await log.create("task-1", {}, 0);
  const record = await log.read(ref);
  await log.append(record, "halted", { stage: "test", reason: "fixture" });
  assert.equal((await log.read(ref)).entries.length, 2);
});

test("temporary files from writes in progress are ignored by readers", async () => {
  const root = freshRoot();
  const log = new AttemptLog(root, "c");
  const ref = await log.create("task-1", {}, 0);
  const context = join(root, "attempts", readdirSync(join(root, "attempts"))[0]!);
  const taskDir = join(context, readdirSync(context)[0]!);
  writeFileSync(join(taskDir, ".2.abc.tmp"), "");
  writeFileSync(join(taskDir, "1", ".0001-halted.json.abc.tmp"), "{partial");
  assert.equal((await log.read(ref)).entries.length, 1);
  assert.deepEqual((await log.list()).map(r => r.attempt), [1]);
});
