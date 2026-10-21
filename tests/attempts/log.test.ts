import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AttemptLog } from "../../src/attempts/log.ts";
import { key } from "../../src/runtime/records.ts";
import { LegacyAttempts } from "../fixtures/legacy-attempts.ts";

const evidence = resolve(import.meta.dirname, "../../.investigation/attempts-unit");
mkdirSync(evidence, { recursive: true });
const freshRoot = () => mkdtempSync(join(evidence, "case-"));

test("reads numbered legacy attempts and entries in order", async () => {
  const root = freshRoot();
  const seed = new LegacyAttempts(root, "context-a");
  const first = await seed.create("task-1", { requestId: "req-1" }, 0);
  await seed.append(first, "halted", { stage: "select", reason: "fixture" });
  await seed.create("task-1", {}, 1);
  const log = new AttemptLog(root, "context-a");
  assert.deepEqual((await log.list()).map(r => r.attempt), [1, 2]);
  assert.deepEqual((await log.read(first)).entries.map(entry => [entry.sequence, entry.kind]), [[0, "requested"], [1, "halted"]]);
});

test("legacy entry names are read without accepting duplicate sequences or wrong kinds", async () => {
  const seed = new LegacyAttempts(freshRoot(), "c");
  const ref = await seed.create("task-1", {}, 0);
  await seed.append(ref, "halted", { stage: "test", reason: "fixture" });
  const directory = seed.directory(ref);
  renameSync(join(directory, "0000.json"), join(directory, "0000-requested.json"));
  const log = new AttemptLog(seed.root, "c");
  assert.deepEqual((await log.list())[0]?.entries.map(entry => entry.kind), ["requested", "halted"]);
  renameSync(join(directory, "0001.json"), join(directory, "0001-worker_finished.json"));
  await assert.rejects(log.read(ref), /storage location/);
  renameSync(join(directory, "0001-worker_finished.json"), join(directory, "0001-halted.json"));
  const entry = (await log.read(ref)).entries[1];
  writeFileSync(join(directory, "0001.json"), JSON.stringify(entry));
  await assert.rejects(log.read(ref), /sequence/);
});

// Creating ten thousand files is slow on Windows runners.
test("sequence 10000 remains readable and sorts after 9999", { timeout: 120_000 }, async () => {
  const seed = new LegacyAttempts(freshRoot(), "c");
  const ref = await seed.create("task-1", {}, 0);
  for (let first = 1; first <= 10000; first += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 10001 - first) }, (_, offset) => first + offset).map(sequence =>
      writeFile(join(seed.directory(ref), `${String(sequence).padStart(4, "0")}-halted.json`), JSON.stringify({
        version: 1, ...ref, sequence, kind: "halted", recordedAt: new Date().toISOString(),
        data: { stage: "test", reason: "fixture" },
      }))));
  }
  const record = await new AttemptLog(seed.root, "c").read(ref);
  assert.equal(record.entries.length, 10001);
  assert.equal(record.entries.at(-1)?.sequence, 10000);
});

test("an empty or missing log lists nothing without creating it", async () => {
  const log = new AttemptLog(join(freshRoot(), "not-created"), "context-a");
  assert.deepEqual(await log.list(), []);
});

test("contexts are separate", async () => {
  const root = freshRoot();
  await new LegacyAttempts(root, "context-a").create("task-1", {}, 0);
  assert.deepEqual(await new AttemptLog(root, "context-b").list(), []);
});

test("unreadable or inconsistent entries cause refusal, not an empty result", async () => {
  const seed = new LegacyAttempts(freshRoot(), "c");
  const ref = await seed.create("task-1", {}, 0);
  writeFileSync(join(seed.directory(ref), "0002-halted.json"), "{}");
  const log = new AttemptLog(seed.root, "c");
  await assert.rejects(log.read(ref), /sequence/);
  await assert.rejects(log.list());
});

test("invalid legacy entry data causes refusal", async () => {
  const seed = new LegacyAttempts(freshRoot(), "c");
  const ref = await seed.create("task-1", {}, 0);
  await seed.append(ref, "leased", { leaseId: "l", workspace: "/w", baseRef: "main", outputBranch: "b", startingCommit: "abc" });
  await assert.rejects(new AttemptLog(seed.root, "c").read(ref));
});

test("temporary files from interrupted writes are ignored by readers", async () => {
  const seed = new LegacyAttempts(freshRoot(), "c");
  const ref = await seed.create("task-1", {}, 0);
  const taskDir = join(seed.root, "attempts", key("c"), key("task-1"));
  writeFileSync(join(taskDir, ".2.abc.tmp"), "");
  writeFileSync(join(seed.directory(ref), ".0001-halted.json.abc.tmp"), "{partial");
  const log = new AttemptLog(seed.root, "c");
  assert.equal((await log.read(ref)).entries.length, 1);
  assert.deepEqual((await log.list()).map(r => r.attempt), [1]);
});
