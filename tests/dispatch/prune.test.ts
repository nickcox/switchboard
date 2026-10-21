import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { prune } from "../../src/dispatch/prune.ts";
import { fixture, task } from "./fixture.ts";

async function settled() {
  const f = await fixture({ tasks: [task("prune-a1")] });
  const ref = (await f.deps.attempts.reserveAttempt({ taskId: "prune-a1", requested: { requestId: "request" }, maximum: 1 })).ref;
  await f.deps.attempts.append(ref, "halted", { stage: "acquire", reason: "rejected" });
  return { ...f, ref };
}

test("prune archives finished attempts in the database, releases their reservation and never reuses numbers", async () => {
  const f = await settled();
  const result = await prune(f.deps, { olderThan: 0.000000001 });
  assert.equal(result.reason, "pruned", JSON.stringify(result));
  assert.equal((result.observed.removed as unknown[]).length, 1);
  assert.deepEqual(f.deps.attempts.list(), []);
  assert.equal(await f.deps.attempts.findByRequest("request"), undefined);
  assert.equal(Number(f.tasks.database.get("SELECT count(*) AS n FROM archived_attempts")!.n), 1);
  const next = await f.deps.attempts.reserveAttempt({ taskId: "prune-a1", requested: { requestId: "request" }, maximum: 1 });
  assert.equal(next.ref.attempt, 2);
});

test("dry-run makes no database changes and age excludes newer attempts", async () => {
  const f = await settled();
  const before = f.deps.attempts.list();
  const dry = await prune(f.deps, { olderThan: 0.000000001, dryRun: true });
  assert.equal(dry.reason, "planned");
  assert.equal((dry.observed.removed as unknown[]).length, 1);
  assert.deepEqual(f.deps.attempts.list(), before);
  assert.equal((await prune(f.deps, { olderThan: 1 })).reason, "pruned");
  assert.deepEqual(f.deps.attempts.list(), before);
});

test("unfinished and leased attempts are preserved", async () => {
  for (const leased of [false, true]) {
    const f = await fixture({ tasks: [task("prune-a1")] });
    const ref = await f.deps.attempts.create("prune-a1", {}, 0);
    if (leased) {
      const allocation = await f.deps.workspaces.acquire({ holder: "prune-a1", baseRef: "main", branch: "output" });
      await f.deps.attempts.append(ref, "leased", { leaseId: allocation.leaseId, workspace: allocation.path, baseRef: "main", outputBranch: "output", startingCommit: allocation.startingCommit });
      await f.deps.attempts.append(ref, "halted", { stage: "start", reason: "stopped" });
    }
    const before = f.deps.attempts.list();
    const result = await prune(f.deps, { olderThan: 0.000000001 });
    assert.equal(result.reason, "pruned");
    assert.equal((result.observed.removed as unknown[]).length, 0);
    assert.deepEqual(f.deps.attempts.list(), before);
  }
});

test("a later prune completes directory deletion left after the archive transaction", async () => {
  const f = await settled();
  const directory = join(f.dir, "retained-runtime");
  await mkdir(directory);
  await f.deps.attempts.archiveAttempt(f.deps.attempts.read(f.ref), {}, [directory]);
  assert.equal(f.deps.attempts.pendingDeletions().length, 1);
  assert.equal((await prune(f.deps, { olderThan: 1 })).reason, "pruned");
  await assert.rejects(stat(directory), { code: "ENOENT" });
  assert.deepEqual(f.deps.attempts.pendingDeletions(), []);
});

test("invalid age refuses without changing records", async () => {
  const f = await settled();
  const before = f.deps.attempts.list();
  for (const olderThan of [0, -1, NaN, Infinity]) assert.equal((await prune(f.deps, { olderThan })).reason, "refused");
  assert.deepEqual(f.deps.attempts.list(), before);
});
