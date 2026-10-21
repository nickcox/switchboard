import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { status } from "../../src/dispatch/status.ts";
import { RuntimeRecords, writeOnce } from "../../src/runtime/records.ts";
import { fixture, task } from "./fixture.ts";

for (const failure of ["not exclusive", "not writable", "unexpected error"] as const) {
  test(`preflight refuses runtime storage that is ${failure} before selection`, async () => {
    const f = await fixture({ tasks: [task("probe-a1")] });
    const root = join(f.dir, "runtime");
    const before = await f.tasks.list();
    let writes = 0;
    f.deps.runtime = new RuntimeRecords(root, f.tasks.database, async (path, value) => {
      writes += 1;
      if (failure === "not writable") throw new Error("permission denied");
      if (failure === "unexpected error" && writes === 2) throw new Error("storage offline");
      await writeFile(path, JSON.stringify(value));
    });
    f.deps.tasks.read = async () => { throw new Error("must not select a task"); };
    f.deps.launch = async () => { throw new Error("must not launch"); };
    const outcome = await dispatchOnce(f.deps);
    assert.equal(outcome.reason, "refused");
    assert.equal(outcome.stage, "preflight");
    assert.equal(outcome.nextAction.code, "fix_configuration");
    assert.match(outcome.detail ?? "", /Runtime storage exclusive-creation check failed/);
    assert.equal(writes, failure === "not writable" ? 1 : 2);
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(await f.deps.attempts.list(), []);
    assert.deepEqual(await f.deps.workspaces.leases(), []);
    assert.deepEqual(await f.tasks.list(), before);
  });
}

test("dispatch probes with the record writer and removes the probe; status never probes", async () => {
  const f = await fixture({ tasks: [task("probe-a1")] });
  const root = join(f.dir, "runtime");
  const paths: string[] = [];
  f.deps.runtime = new RuntimeRecords(root, f.tasks.database, async (path, value) => {
    paths.push(path);
    await writeOnce(path, value);
  });
  await status(f.deps);
  assert.deepEqual(paths, []);
  await assert.rejects(readdir(root), { code: "ENOENT" });
  const outcome = await dispatchOnce(f.deps, { dryRun: true });
  assert.equal(outcome.reason, "dry_run");
  assert.equal(paths.length, 2);
  assert.equal(paths[0], paths[1]);
  assert.equal(dirname(paths[0]!), root);
  assert.match(basename(paths[0]!), /^exclusive-probe-[a-f0-9-]+\.json$/);
  assert.deepEqual(await readdir(root), []);
  await dispatchOnce(f.deps, { dryRun: true });
  assert.equal(paths.length, 4);
  assert.notEqual(paths[0], paths[2]);
  assert.deepEqual(await readdir(root), []);
});
