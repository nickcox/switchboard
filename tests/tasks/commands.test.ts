import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";

const cli = resolve("src/cli.ts");
async function fixture() {
  const root = resolve(".investigation/task-commands");
  await mkdir(root, { recursive: true });
  const dir = await realpath(await mkdtemp(join(root, "case-")));
  const config = join(dir, "switchboard.json");
  const path = join(dir, "runtime", "switchboard.db");
  await writeFile(config, JSON.stringify({ contextId: "fixture", runtimeRoot: join(dir, "runtime"), tasks: { repo: "fixture" },
    workspaces: { repository: join(dir, "repository"), poolRoot: join(dir, "pool") }, delivery: { baseRef: "main" },
    worker: { piEntrypoint: cli, provider: "fixture", model: "fixture" } }));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "task", ...args, "--config", config], { encoding: "utf8" });
  const json = (...args: string[]) => {
    const result = run(...args, "--json");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  return { dir, path, config, run, json };
}

test("all operator task commands support JSON without Git, Treehouse or Pi preflight", async () => {
  const f = await fixture();
  assert.equal(f.json("add", "a", "A", "--body", "Original").task.state, "queued");
  f.json("add", "b", "B", "--repo", "fixture", "--kind", "scout");
  const body = "Changed\n\nα\n";
  const file = join(f.dir, "body.md");
  await writeFile(file, body);
  assert.partialDeepStrictEqual(f.json("update", "a", "--title", "New A", "--body-file", file, "--kind", "scout").task, { title: "New A", body, kind: "scout" });
  assert.equal(f.json("show", "a").task.body, body);
  assert.equal(f.json("list").tasks.length, 2);
  assert.deepEqual(f.json("ready").ready, ["a", "b"]);
  assert.equal(f.json("hold", "a", "--reason", "Operator (waiting)").task.held, true);
  assert.deepEqual(f.json("ready").ready, ["b"]);
  f.json("release", "a");
  f.json("block", "b", "--by", "a");
  assert.deepEqual(f.json("ready").ready, ["a"]);
  f.json("unblock", "b", "--by", "a");
  f.json("done", "a", "--note", "Reviewed");
  assert.equal(f.json("list", "--state", "done").tasks.length, 1);
  assert.ok(f.json("show", "a").task.body.includes("Reviewed"));
  f.json("reopen", "a");
  assert.deepEqual(f.json("ready").ready, ["a", "b"]);
  f.json("update", "a", "--repo", "other", "--body", "New body");
  assert.deepEqual(f.json("ready").ready, ["b"]);
  assert.deepEqual(f.json("ready", "--repo", "other").ready, ["a"]);
  const prefixed = spawnSync(process.execPath, [cli, "--config", f.config, "--json", "task", "ready"], { encoding: "utf8" });
  assert.equal(prefixed.status, 0, prefixed.stderr);
  assert.deepEqual(JSON.parse(prefixed.stdout).ready, ["b"]);
  const readable = f.run("show", "a");
  assert.equal(readable.status, 0, readable.stderr);
  assert.match(readable.stdout, /New body/);
  for (const args of [["show", "missing"], ["add", "a", "Duplicate"], ["block", "b", "--by", "missing"], ["hold", "a", "--reason", "two\nlines"]]) {
    const result = f.run(...args, "--json");
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).reason, "rejected");
  }
});

test("task CLI refuses usage errors before opening configuration; operators cannot start tasks", async () => {
  for (const args of [[], ["start", "a"], ["add", "a"], ["show"], ["show", "a", "extra"], ["hold", "a"], ["block", "a"],
    ["update", "a", "--body", "x", "--body-file", "x"], ["done", "a", "--reason", "x"], ["list", "--state", "invalid"], ["ready", "--dry-run"]]) {
    const result = spawnSync(process.execPath, [cli, "task", ...args, "--config", "missing.json"], { encoding: "utf8" });
    assert.equal(result.status, 2, args.join(" ") + result.stderr);
    assert.match(result.stderr, /Usage:/);
  }
});

test("concurrent processes append unique positions and refuse duplicate task IDs atomically", async t => {
  const f = await fixture();
  f.json("add", "seed", "Seed");
  const children = Array.from({ length: 8 }, (_, i) => spawn(process.execPath,
    [cli, "task", "add", i < 2 ? "duplicate" : `task-${i}`, "Concurrent", "--json", "--config", f.config], { stdio: "ignore" }));
  t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const codes = await Promise.all(children.map(child => once(child, "exit").then(([code]) => code)));
  assert.equal(codes.filter(code => code === 0).length, 7);
  assert.equal(codes.filter(code => code === 1).length, 1);
  const store = await SqliteTaskStore.open({ path: f.path });
  try { assert.deepEqual((await store.list()).map(task => task.position), [1, 2, 3, 4, 5, 6, 7, 8]); }
  finally { store.close(); }
});

test("busy retries are asynchronous, refuse unchanged on timeout, and recover after the writer is killed", async t => {
  const f = await fixture();
  f.json("add", "a", "A");
  const store = await SqliteTaskStore.open({ path: f.path, retryMs: 120 });
  const child = spawn(process.execPath, [resolve("tests/fixtures/database.ts"), f.path], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exit; store.close(); });
  await once(child.stdout, "data");
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    await assert.rejects(store.update("a", { title: "Refused" }), error => error instanceof Error && "reason" in error && error.reason === "busy");
    assert.ok(ticks >= 5, `${ticks} timer ticks`);
    assert.equal((await store.read("a"))?.title, "A");
  } finally { clearInterval(timer); }
  const patient = await SqliteTaskStore.open({ path: f.path, retryMs: 1000 });
  try {
    const kill = setTimeout(() => child.kill("SIGKILL"), 50);
    try { assert.equal((await patient.update("a", { title: "Recovered" })).title, "Recovered"); }
    finally { clearTimeout(kill); }
    await exit;
    assert.equal((await store.read("a"))?.title, "Recovered");
  } finally { patient.close(); }
});
