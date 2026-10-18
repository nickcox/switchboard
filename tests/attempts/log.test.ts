import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AttemptConflict, AttemptLog } from "../../src/attempts/log.ts";
import { RuntimeRecords } from "../../src/runtime/records.ts";

const evidence = resolve(import.meta.dir, "../../.investigation/attempts-unit");
mkdirSync(evidence, { recursive: true });
const freshRoot = () => mkdtempSync(join(evidence, "case-"));

test("creates numbered attempts and appends entries in order", async () => {
  const log = new AttemptLog(freshRoot(), "context-a");
  const first = await log.create("task-1", { requestId: "req-1" }, 0);
  await log.append(first, "halted", { stage: "select", reason: "fixture" });
  const second = await log.create("task-1", {}, 1);
  expect([first.attempt, second.attempt]).toEqual([1, 2]);
  const record = await log.read(first);
  expect(record.entries.map(entry => [entry.sequence, entry.kind])).toEqual([[0, "requested"], [1, "halted"]]);
  expect((await log.forTask("task-1")).map(r => r.attempt)).toEqual([1, 2]);
  expect((await log.findByRequest("req-1"))?.attempt).toBe(1);
  expect(await log.findByRequest("req-unknown")).toBeUndefined();
});

test("creation is conditional on the latest attempt the caller inspected", async () => {
  const log = new AttemptLog(freshRoot(), "c");
  await log.create("task-1", {}, 0);
  // A caller that inspected no attempts, or a stale latest attempt, must not create another.
  await expect(log.create("task-1", {}, 0)).rejects.toBeInstanceOf(AttemptConflict);
  await expect(log.create("task-1", {}, 2)).rejects.toBeInstanceOf(AttemptConflict);
  expect((await log.forTask("task-1")).map(r => r.attempt)).toEqual([1]);
});

test("an empty or missing log lists nothing", async () => {
  const log = new AttemptLog(join(freshRoot(), "not-created"), "context-a");
  expect(await log.list()).toEqual([]);
  expect(await log.forTask("task-1")).toEqual([]);
});

test("contexts are separate", async () => {
  const root = freshRoot();
  await new AttemptLog(root, "context-a").create("task-1", {}, 0);
  expect(await new AttemptLog(root, "context-b").list()).toEqual([]);
});

test("concurrent creation in one process has exactly one winner", async () => {
  const root = freshRoot();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => new AttemptLog(root, "c").create("task-1", {}, 0)));
  const won = results.filter(r => r.status === "fulfilled");
  const conflicts = results.filter(r => r.status === "rejected" && r.reason instanceof AttemptConflict);
  expect(won).toHaveLength(1);
  expect(conflicts).toHaveLength(7);
});

test("concurrent creation across processes has exactly one winner", async () => {
  const script = join(import.meta.dir, "../fixtures/create-attempt.ts");
  for (let round = 0; round < 5; round += 1) {
    const root = freshRoot();
    const go = join(root, "go");
    const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, script, root, "c", "task-1", go], { stdout: "pipe", stderr: "pipe" }));
    await Bun.sleep(300);
    writeFileSync(go, "");
    const outputs = await Promise.all(children.map(async child => {
      await child.exited;
      return (await new Response(child.stdout).text()).trim();
    }));
    expect(outputs.filter(o => o === "created")).toHaveLength(1);
    expect(outputs.filter(o => o === "conflict")).toHaveLength(3);
  }
});

test("unreadable or inconsistent entries cause refusal, not an empty result", async () => {
  const root = freshRoot();
  const log = new AttemptLog(root, "c");
  const ref = await log.create("task-1", {}, 0);
  const context = join(root, "attempts", readdirSync(join(root, "attempts"))[0]!);
  const attemptDir = join(context, readdirSync(context)[0]!, "1");
  writeFileSync(join(attemptDir, "0002-halted.json"), "{}");
  await expect(log.read(ref)).rejects.toThrow("sequence");
  await expect(log.list()).rejects.toThrow();
});

test("entry data is validated before it is written", async () => {
  const log = new AttemptLog(freshRoot(), "c");
  const ref = await log.create("task-1", {}, 0);
  await expect(log.append(ref, "leased", { leaseId: "l", workspace: "/w", baseRef: "main", outputBranch: "b", startingCommit: "abc" })).rejects.toThrow();
  expect((await log.read(ref)).entries).toHaveLength(1);
});

test("attempt log and runtime records share a root without breaking runtime discovery", async () => {
  const root = freshRoot();
  await new AttemptLog(root, "c").create("task-1", {}, 0);
  expect(await new RuntimeRecords(root).discover("c")).toEqual([]);
});
