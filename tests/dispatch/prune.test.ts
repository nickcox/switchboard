import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AttemptPruner } from "../../src/attempts/prune.ts";
import { prune } from "../../src/dispatch/prune.ts";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { finish } from "../../src/dispatch/finish.ts";
import { status } from "../../src/dispatch/status.ts";
import { key, readJsonFile } from "../../src/runtime/records.ts";
import { fixture, task } from "./fixture.ts";

const old = { olderThan: 1e-12 };
async function setup(options: { open?: boolean; launched?: boolean; settled?: boolean; pool?: string } = {}) {
  const f = await fixture({ tasks: [task("prune-a1")] });
  const log = f.deps.attempts;
  await log.reserveRequest("request", "prune-a1");
  const ref = await log.create("prune-a1", { requestId: "request", ...(options.pool ? { pool: options.pool } : {}) }, 0);
  let runtime;
  if (options.launched || options.pool) {
    await log.append(ref, "leased", { leaseId: "lease", workspace: f.dir, baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40), ...(options.pool ? { pool: options.pool } : {}) });
  }
  if (options.launched) {
    const sessionId = randomUUID();
    await log.append(ref, "launched", { sessionId });
    runtime = await f.runtime.reserve({
      identity: { contextId: f.deps.contextId, taskId: ref.taskId, leaseId: "lease", sessionId }, workspace: f.deps.repository,
      instructions: "Fixture", acceptanceCriteria: [], delivery: { baseRef: "main", startingCommit: "a".repeat(40), outputBranch: "output", kind: "code", acceptance: "review_or_integration", requiredEvidence: [], requiredDeliverables: [] },
    });
    if (options.settled) {
      await f.runtime.recordChildExit(runtime, { started: true, code: 0, signal: null });
      await log.append(ref, "worker_finished", { status: "completed", runtimeDirectory: runtime.directory });
    }
  }
  if (!options.open) await log.append(ref, "task_recorded", { outcome: "hold", reason: "fixture finished" });
  // `old` puts the cutoff at the moment prune starts, and entry times have millisecond precision, so make sure the
  // last entry is strictly older than that moment.
  await sleep(5);
  return { ...f, ref, reserved: runtime, pruner: new AttemptPruner(log) };
}
async function snapshot(root: string): Promise<unknown> {
  const values: unknown[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    values.push([name, (await lstat(path)).isDirectory() ? await snapshot(path) : await readFile(path, "utf8")]);
  }
  return values;
}

test("prune archives old finished attempts, removes runtime and reservation, and preserves numbering", async () => {
  const f = await setup({ launched: true, settled: true });
  const archive = f.pruner.archivePath(f.ref);
  const outcome = await prune(f.deps, old);
  assert.equal(outcome.reason, "pruned", outcome.detail ?? "");
  assert.equal((await readJsonFile(archive) as { taskId: string }).taskId, "prune-a1");
  assert.deepEqual(await f.deps.attempts.list(), []);
  assert.deepEqual(await f.runtime.discover(f.deps.contextId), []);
  assert.equal(await f.deps.attempts.reserveRequest("request", "prune-a1"), true);
  assert.equal((await f.deps.attempts.create("prune-a1", { requestId: "request" }, 0)).attempt, 2);
  assert.notEqual((await status(f.deps)).reason, "refused");
});

test("dry-run lists candidates and changes no files; recent attempts are preserved", async () => {
  const f = await setup({ launched: true, settled: true });
  const before = await snapshot(f.deps.attempts.root);
  assert.deepEqual((await prune(f.deps, { olderThan: 1 })).observed.removed, []);
  const outcome = await prune(f.deps, { ...old, dryRun: true });
  assert.equal(outcome.reason, "planned");
  assert.equal((outcome.observed.removed as unknown[]).length, 1);
  assert.deepEqual(await snapshot(f.deps.attempts.root), before);
});

for (const refusal of ["unfinished", "lease", "unlogged_lease", "running", "pool", "unknown", "unreadable", "corrupt"] as const) {
  test(`prune preserves an attempt that is ${refusal}, including its request reservation`, async () => {
    const f = await setup({ open: refusal === "unfinished", launched: refusal === "running", ...(refusal === "pool" ? { pool: "old-pool" } : {}) });
    if (refusal === "lease" || refusal === "unlogged_lease") f.deps.workspaces.leases = async () => [{ leaseId: "lease", holder: "prune-a1", path: f.dir, branch: "output" }];
    if (refusal === "lease") await f.deps.attempts.append(f.ref, "leased", { leaseId: "lease", workspace: f.dir, baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40) });
    if (refusal === "unknown") f.deps.tasks.read = async () => undefined;
    if (refusal === "unreadable") f.deps.workspaces.leases = async () => { throw new Error("unreadable"); };
    if (refusal === "corrupt") await rm(join(f.deps.attempts.root, "attempts", key(f.deps.contextId), key(f.ref.taskId), "1", "0000.json"));
    const before = await snapshot(f.deps.attempts.root);
    const outcome = await prune(f.deps, old);
    assert.deepEqual(outcome.observed.removed, []);
    assert.deepEqual(await snapshot(f.deps.attempts.root), before);
    assert.equal(await f.deps.attempts.reserveRequest("request", "prune-a1"), false);
  });
}

for (const boundary of ["archive", "attempt", "runtime", "partial", "reservation"] as const) {
  test(`prune resumes safely after interruption following ${boundary} removal`, async () => {
    const f = await setup({ launched: true, settled: true });
    const record = await f.deps.attempts.read(f.ref);
    const archived = await f.pruner.archive(record);
    const source = join(f.deps.attempts.root, "attempts", key(f.deps.contextId), key(f.ref.taskId), "1");
    const tombstone = join(source, "..", ".1.pruned");
    if (boundary !== "archive") await rename(source, tombstone);
    if (["runtime", "partial", "reservation"].includes(boundary)) await rename(f.reserved!.directory, join(tombstone, ".runtime"));
    if (boundary === "partial") {
      await rm(join(tombstone, "0000.json"));
      await rm(join(tombstone, ".runtime", "binding.json"));
    }
    if (boundary === "reservation") await f.deps.attempts.releaseRequest("request");
    assert.notEqual((await status(f.deps)).reason, "refused");
    const outcome = await prune(f.deps, old);
    assert.equal(outcome.reason, "pruned", outcome.detail ?? "");
    assert.deepEqual(await f.deps.attempts.list(), []);
    assert.deepEqual(await f.runtime.discover(f.deps.contextId), []);
    assert.deepEqual(await readJsonFile(f.pruner.archivePath(f.ref)), archived);
    const before = await snapshot(f.deps.attempts.root);
    assert.equal((await prune(f.deps, old)).ok, true);
    assert.deepEqual(await snapshot(f.deps.attempts.root), before);
  });
}

test("resuming an old cleanup does not release a newly reused request ID", async () => {
  const f = await setup();
  await f.pruner.archive(await f.deps.attempts.read(f.ref));
  const directory = join(f.deps.attempts.root, "attempts", key(f.deps.contextId), key(f.ref.taskId));
  await rename(join(directory, "1"), join(directory, ".1.pruned"));
  await f.deps.attempts.releaseRequest("request");
  await f.deps.attempts.reserveRequest("request", "new-task");
  assert.equal((await prune(f.deps, old)).ok, true);
  assert.equal(await f.deps.attempts.reserveRequest("request", "prune-a1"), false);
});

test("a mismatched reservation is refused without removing its attempt", async () => {
  const f = await setup();
  await f.deps.attempts.releaseRequest("request");
  await f.deps.attempts.reserveRequest("request", "other-task");
  const before = await snapshot(f.deps.attempts.root);
  assert.equal((await prune(f.deps, { ...old, dryRun: true })).reason, "refused");
  assert.equal((await prune(f.deps, old)).reason, "refused");
  assert.deepEqual(await snapshot(f.deps.attempts.root), before);
});

test("prune CLI supports JSON and dry-run and rejects invalid ages", async () => {
  const f = await setup();
  const cli = resolve("src/cli.ts");
  const before = await snapshot(f.deps.attempts.root);
  const output = execFileSync(process.execPath, [cli, "prune", "--older-than", "0.000000000001", "--dry-run", "--json", "--config", f.config], { encoding: "utf8" });
  assert.equal(JSON.parse(output).reason, "planned");
  assert.deepEqual(await snapshot(f.deps.attempts.root), before);
  for (const age of [undefined, "0", "-1", "NaN", "Infinity"]) {
    assert.throws(() => execFileSync(process.execPath, [cli, "prune", ...(age === undefined ? [] : ["--older-than", age])], { stdio: "pipe" }), (error: unknown) => (error as { status: number }).status === 2);
  }
});

// Phase 2 review findings 4 and 10 (docs/phases/02-reconciliation-and-recovery/review-2026-10-21.md).

test("finding 4: a second prune refuses while one is cleaning up, so a reservation claimed meanwhile survives", async () => {
  const f = await setup();
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let paused = false;
  // Pause the first prune after it has read the old reservation and checked that no attempt refers to it.
  const attempts = Object.assign(Object.create(Object.getPrototypeOf(f.deps.attempts)), f.deps.attempts, {
    findByRequest: async (requestId: string) => {
      const found = await f.deps.attempts.findByRequest(requestId);
      if (!paused) { paused = true; entered(); await barrier; }
      return found;
    },
  });
  const first = prune({ ...f.deps, attempts }, old);
  // Fail with the first prune's result, rather than waiting for the test timeout, if it finishes without pausing.
  const early = await Promise.race([reached.then(() => undefined), first]);
  assert.equal(early, undefined, `The first prune finished without reaching the pause: ${JSON.stringify(early)}`);
  const second = await prune(f.deps, old);
  const claimed = await f.deps.attempts.reserveRequest("request", "new-task");
  release();
  assert.equal((await first).ok, true);
  assert.equal(second.reason, "refused", second.detail ?? "");
  assert.match(second.detail ?? "", /another prune/i);
  // Whoever claimed the request ID during the cleanup still holds it afterwards.
  if (claimed) assert.equal(await f.deps.attempts.reserveRequest("request", "third-task"), false);
});

test("a prune lock left by an interrupted run refuses, naming the lock to remove", async () => {
  const f = await setup();
  await prune(f.deps, { olderThan: 1e9 });
  const lock = join(f.deps.attempts.root, `prune-lock-${key(f.deps.contextId)}`);
  await mkdir(lock);
  const outcome = await prune(f.deps, old);
  assert.equal(outcome.reason, "refused");
  assert.ok((outcome.detail ?? "").includes(lock), outcome.detail ?? "");
  assert.equal((await f.deps.attempts.list()).length, 1);
});

test("finding 10: an attempt whose lease finish returned stays finished after the origin remote changes, and can be pruned", async () => {
  const f = await fixture({ tasks: [task("prune-a1")], scenario: "commit-result" });
  const leaseId = (await dispatchOnce(f.deps)).attempt!.leaseId!;
  assert.equal((await finish(f.deps, { leaseId, noProcesses: true })).reason, "finished");
  f.run(["remote", "add", "origin", "https://example.invalid/fixture.git"]);
  assert.equal((await status(f.deps)).attempts[0]?.state, "finished");
  const outcome = await prune(f.deps, old);
  assert.equal(outcome.reason, "pruned", outcome.detail ?? "");
  assert.deepEqual(await f.deps.attempts.list(), []);
});
