import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { finish } from "../../src/dispatch/finish.ts";
import { prune } from "../../src/dispatch/prune.ts";
import { status } from "../../src/dispatch/status.ts";
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
  const directory = join(f.dir, "runtime", "retained-runtime");
  await mkdir(directory, { recursive: true });
  await f.deps.attempts.archiveAttempt(f.deps.attempts.read(f.ref), {}, [directory]);
  assert.equal(f.deps.attempts.pendingDeletions().length, 1);
  assert.equal((await prune(f.deps, { olderThan: 1 })).reason, "pruned");
  await assert.rejects(stat(directory), { code: "ENOENT" });
  assert.deepEqual(f.deps.attempts.pendingDeletions(), []);
});

test("prune refuses to delete a recorded directory outside the runtime root, or a link, and keeps its record", { skip: process.platform === "win32" }, async () => {
  for (const kind of ["outside", "link"] as const) {
    const f = await settled();
    const target = join(f.dir, "precious");
    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "keep");
    let directory = target;
    if (kind === "link") {
      directory = join(f.dir, "runtime", "linked");
      await mkdir(join(f.dir, "runtime"), { recursive: true });
      await symlink(target, directory);
    }
    await f.deps.attempts.archiveAttempt(f.deps.attempts.read(f.ref), {}, [directory]);
    const result = await prune(f.deps, { olderThan: 1 });
    assert.notEqual(result.reason, "pruned", kind);
    assert.match(result.detail ?? "", /not a directory inside the runtime root/);
    assert.equal((await stat(join(target, "keep.txt"))).isFile(), true, kind);
    assert.equal(f.deps.attempts.pendingDeletions().length, 1, kind);
  }
});

test("finding 10: an attempt whose lease finish returned stays finished after the origin remote changes, and can be pruned", async () => {
  const f = await fixture({ tasks: [task("prune-a1")], scenario: "commit-result" });
  const leaseId = (await dispatchOnce(f.deps)).attempt!.leaseId!;
  assert.equal((await finish(f.deps, { leaseId, noProcesses: true })).reason, "finished");
  f.run(["remote", "add", "origin", "https://example.invalid/fixture.git"]);
  assert.equal((await status(f.deps)).attempts[0]?.state, "finished");
  await sleep(5); // the cutoff below is the moment prune starts; entry times have millisecond precision
  const outcome = await prune(f.deps, { olderThan: 0.000000001 });
  assert.equal(outcome.reason, "pruned", outcome.detail ?? "");
  assert.deepEqual(f.deps.attempts.list(), []);
});

test("invalid age refuses without changing records", async () => {
  const f = await settled();
  const before = f.deps.attempts.list();
  for (const olderThan of [0, -1, NaN, Infinity]) assert.equal((await prune(f.deps, { olderThan })).reason, "refused");
  assert.deepEqual(f.deps.attempts.list(), before);
});
