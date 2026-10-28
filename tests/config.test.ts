import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDependencies, loadConfig } from "../src/config.ts";
import { dispatchOnce } from "../src/dispatch/dispatch.ts";
import { observeAttempts } from "../src/dispatch/observe.ts";
import { status } from "../src/dispatch/status.ts";
import { SqliteTaskStore } from "../src/tasks/sqlite.ts";
import { TreehouseProvider } from "../src/workspaces/treehouse.ts";
import { fixture, task } from "./dispatch/fixture.ts";

const cli = resolve(import.meta.dirname, "../src/cli.ts");

for (const broken of [false, true]) {
  test(`${broken ? "broken" : "missing"} Pi does not prevent task commands, status, finish or discard`, async () => {
    const f = await fixture({ tasks: [task("runtime-a1"), task("runtime-b1")], scenario: "commit-result" });
    const first = await dispatchOnce(f.deps, { taskId: "runtime-a1" });
    const second = await dispatchOnce(f.deps, { taskId: "runtime-b1" });
    assert.equal(first.reason, "held");
    assert.equal(second.reason, "held");
    const log = join(f.dir, "requests.jsonl");
    const launched = readFileSync(log, "utf8");
    const config = await loadConfig(f.config);
    config.worker.piEntrypoint = join(f.dir, "unusable-pi.js");
    if (broken) writeFileSync(config.worker.piEntrypoint, "throw new Error('Pi is broken');\n");
    writeFileSync(f.config, JSON.stringify(config));
    const run = (args: string[]) => {
      const result = spawnSync(process.execPath, [cli, ...args, "--config", f.config, "--json"], {
        env: { ...process.env, ...f.environment }, encoding: "utf8",
      });
      assert.notEqual(result.status, 2, result.stderr);
      return { ...result, value: JSON.parse(result.stdout) };
    };
    try {
      const view = run(["status"]);
      assert.equal(view.value.attempts.length, 2);
      assert.equal(view.value.policy.error, undefined);
      for (const args of [
        ["add", "operator-c1", "Operator task"], ["show", "operator-c1"], ["list"], ["ready"],
        ["update", "operator-c1", "--body", "Updated"], ["hold", "operator-c1", "--reason", "Waiting"],
        ["release", "operator-c1"], ["block", "operator-c1", "--by", "runtime-a1"],
        ["unblock", "operator-c1", "--by", "runtime-a1"], ["done", "operator-c1"], ["reopen", "operator-c1"],
      ]) assert.equal(run(["task", ...args]).status, 0, args.join(" "));
      const finished = run(["finish", "--lease", first.attempt!.leaseId!]);
      assert.equal(finished.value.reason, "finished");
      assert.equal(finished.value.lease, "preserved");
      assert.equal((await f.tasks.read("runtime-a1"))!.state, "done");
      const discarded = run(["discard", "--lease", second.attempt!.leaseId!, "--confirm", "--no-processes"]);
      assert.equal(discarded.value.ok, true);
      assert.equal(discarded.value.lease, "none");
      assert.equal(readFileSync(log, "utf8"), launched);
    } finally { f.tasks.close(); }
  });
}

test("dispatch with missing Pi refuses before reserving a request, acquiring or launching", async () => {
  const f = await fixture({ tasks: [task("missing-a1")] });
  const config = await loadConfig(f.config);
  config.worker.piEntrypoint = join(f.dir, "missing-pi.js");
  writeFileSync(f.config, JSON.stringify(config));
  try {
    for (const dry of [[], ["--dry-run"]]) {
      const result = spawnSync(process.execPath, [cli, "dispatch", "--once", "--request-id", "missing", ...dry, "--config", f.config], { encoding: "utf8" });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /Pi entrypoint/);
    }
    assert.deepEqual(await f.deps.attempts.list(), []);
    assert.equal(await f.deps.attempts.findByRequest("missing"), undefined);
    assert.deepEqual(await f.deps.workspaces.leases(), []);
    assert.equal((await f.tasks.read("missing-a1"))!.state, "queued");
    assert.equal(existsSync(join(f.dir, "requests.jsonl")), false);
  } finally { f.tasks.close(); }
});

test("unavailable external owners leave local observations readable", async () => {
  const f = await fixture({ tasks: [task("owners-a1")] });
  const ref = await f.deps.attempts.create("owners-a1", {}, 0);
  await f.deps.attempts.append(ref, "halted", { stage: "acquire", reason: "stopped", detail: "Fixture refusal" });
  const config = await loadConfig(f.config);
  const path = process.env.PATH;
  let deps: Awaited<ReturnType<typeof createDependencies>> | undefined;
  try {
    process.env.PATH = "";
    deps = await createDependencies(config);
    const observation = await observeAttempts(deps);
    assert.equal(observation.records.known, true);
    assert.equal(observation.runtime.known, true);
    assert.equal(observation.attempts[0]!.task.known, true);
    assert.equal(observation.leases.known, false);
    assert.equal(observation.pool.known, false);
    const view = await status(deps);
    assert.ok(view.policy && "error" in view.policy);
    assert.match(view.policy.error, /git/);
    assert.equal(view.attempts[0]!.state, "unknown");
  } finally {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
    deps?.close();
    f.tasks.close();
  }
});

for (const owner of ["git", "treehouse"] as const) {
  test(`missing ${owner} makes only workspace observations needing it unknown`, async t => {
    const f = await fixture({ tasks: [task("partial-a1")] });
    const connect = TreehouseProvider.connect;
    t.mock.method(TreehouseProvider, "connect", (options: Parameters<typeof connect>[0]) => connect({
      ...options, [owner]: () => { throw new Error(`${owner} is unavailable`); },
    }));
    let deps: Awaited<ReturnType<typeof createDependencies>> | undefined;
    try {
      deps = await createDependencies(await loadConfig(f.config));
      const observation = await observeAttempts(deps);
      assert.equal(observation.records.known, true);
      assert.equal(observation.runtime.known, true);
      assert.equal(observation.leases.known, owner !== "treehouse");
      assert.equal(observation.pool.known, owner !== "git");
      assert.deepEqual(await deps.tasks.ready(), await f.tasks.ready());
    } finally { deps?.close(); f.tasks.close(); }
  });
}

test("a later provider construction failure closes the opened database", async t => {
  const f = await fixture();
  const config = await loadConfig(f.config);
  config.workspaces.repository = join(f.dir, "missing-repository");
  const open = SqliteTaskStore.open;
  let opened: SqliteTaskStore | undefined;
  t.mock.method(SqliteTaskStore, "open", async (...args: Parameters<typeof open>) => {
    opened = await open(...args);
    return opened;
  });
  try {
    await assert.rejects(createDependencies(config, { dispatch: true }), /ENOENT/);
    assert.ok(opened);
    assert.throws(() => opened!.database.get("SELECT 1"), /not open/);
  } finally { f.tasks.close(); }
});

test("closing dependencies closes their database", async () => {
  const f = await fixture();
  try {
    const deps = await createDependencies(await loadConfig(f.config));
    const store = deps.tasks as SqliteTaskStore;
    assert.ok(store.database.get("SELECT 1"));
    deps.close();
    assert.throws(() => store.database.get("SELECT 1"), /not open/);
  } finally { f.tasks.close(); }
});
