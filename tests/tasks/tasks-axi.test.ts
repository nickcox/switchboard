import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TaskStoreError } from "../../src/tasks/store.ts";
import { TasksAxiStore } from "../../src/tasks/tasks-axi.ts";

// Runs the real tasks-axi 0.2.6 CLI against disposable stores, with the Node.js binary running these tests.
const node = process.execPath;
const entrypoint = resolve(import.meta.dirname, "../../node_modules/tasks-axi/dist/bin/tasks-axi.js");
const evidence = resolve(import.meta.dirname, "../../.investigation/tasks-unit");
mkdirSync(evidence, { recursive: true });

async function fixture(setup: string[][] = []) {
  const dir = realpathSync(mkdtempSync(join(evidence, "case-")));
  const home = join(dir, "home");
  mkdirSync(home);
  const file = join(dir, "backlog.md");
  // Create the store and its tasks with the CLI directly, as an operator would.
  for (const args of [["add", "seed-z9", "Seed", "--repo", "other"], ...setup]) {
    const out = spawnSync(node, [entrypoint, ...args, "--json", "--backend", "markdown", "--file", file], { env: { PATH: process.env.PATH ?? "", HOME: home }, encoding: "utf8" });
    if (out.status !== 0) throw new Error(out.stdout + out.stderr);
  }
  const store = await TasksAxiStore.open({ node, entrypoint, file, repo: "fixture", home });
  return { dir, home, file, store };
}

test("ready keeps backlog order and excludes blocked, held, in-flight and other repositories", async () => {
  const { store } = await fixture([
    ["add", "first-a1", "First", "--repo", "fixture", "--priority", "4"],
    ["add", "second-b1", "Second", "--repo", "fixture", "--priority", "0"],
    ["add", "blocked-c1", "Blocked", "--repo", "fixture", "--blocked-by", "first-a1"],
    ["add", "held-d1", "Held", "--repo", "fixture"],
    ["hold", "held-d1", "--reason", "Operator"],
    ["add", "flight-e1", "In flight", "--repo", "fixture"],
    ["start", "flight-e1"],
  ]);
  assert.deepEqual(await store.ready(), ["first-a1", "second-b1"]);
  assert.deepEqual(await store.inFlight(), ["flight-e1"]);
});

test("empty lists are empty, not errors", async () => {
  const { store } = await fixture();
  assert.deepEqual(await store.ready(), []);
  assert.deepEqual(await store.inFlight(), []);
});

test("read returns typed fields and preserves the body exactly; a missing task is undefined", async () => {
  const body = 'Instructions, commas and "quotes"\n\n## Acceptance\n- keep Unicode: α';
  const { store } = await fixture([["add", "read-a1", "123", "--repo", "fixture", "--body", body]]);
  assert.deepEqual(await store.read("read-a1"), {
    id: "read-a1", title: "123", state: "queued", repo: "fixture", kind: null, blocked: false, held: false, holdReason: null, body,
  });
  assert.equal(await store.read("missing-z9"), undefined);
});

test("a task's kind is read; no kind and an explicit 'task' are both null", async () => {
  const { store } = await fixture([
    ["add", "scout-a1", "Scout", "--repo", "fixture", "--kind", "scout"],
    ["add", "plain-b1", "Plain", "--repo", "fixture"],
    ["add", "named-c1", "Named", "--repo", "fixture", "--kind", "task"],
  ]);
  assert.equal((await store.read("scout-a1"))?.kind, "scout");
  assert.equal((await store.read("plain-b1"))?.kind, null);
  assert.equal((await store.read("named-c1"))?.kind, null);
});

test("start, done and hold read back what the store holds", async () => {
  const { store } = await fixture([
    ["add", "done-a1", "Done task", "--repo", "fixture", "--body", "Original"],
    ["add", "hold-b1", "Hold task", "--repo", "fixture", "--body", "Original"],
    ["add", "dependent-c1", "Dependent", "--repo", "fixture", "--blocked-by", "hold-b1"],
  ]);
  assert.equal((await store.start("done-a1")).state, "in_flight");
  const note = JSON.stringify({ leaseId: "lease-1", resultCommit: "b".repeat(40) });
  assert.equal((await store.recordDone("done-a1", note)).state, "done");
  // Repeating done is accepted by tasks-axi and leaves the same record.
  assert.ok((await store.recordDone("done-a1", note)).body.includes(note));

  await store.start("hold-b1");
  const body = `Original\n\nSwitchboard outcome: ${note}`;
  const held = await store.recordHold("hold-b1", { reason: "Review required", body });
  assert.partialDeepStrictEqual(held, { state: "queued", held: true, holdReason: "Review required", body });
  assert.equal((await store.read("dependent-c1"))?.blocked, true);
  assert.deepEqual(await store.ready(), []);
});

test("a partly applied hold is completed by running it again", async () => {
  const { store } = await fixture([
    ["add", "part-a1", "Partial", "--repo", "fixture", "--body", "Original"],
    ["start", "part-a1"],
    ["hold", "part-a1", "--reason", "Review required"],
  ]);
  const held = await store.recordHold("part-a1", { reason: "Review required", body: "Original\n\nOutcome" });
  assert.partialDeepStrictEqual(held, { state: "queued", held: true, body: "Original\n\nOutcome" });
});

test("an invalid hold reason is refused before any write", async () => {
  const { store, file } = await fixture([["add", "bad-a1", "Bad", "--repo", "fixture"], ["start", "bad-a1"]]);
  const before = readFileSync(file, "utf8");
  await assert.rejects(store.recordHold("bad-a1", { reason: "Failed (exit 1)", body: "x" }), /parentheses/);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("a refused change is reported as rejected", async () => {
  const { store } = await fixture();
  await assert.rejects(store.start("missing-z9"), (error: unknown) => error instanceof TaskStoreError && error.reason === "rejected");
});

test("environment variables and configuration files cannot redirect the store", async () => {
  const { dir, file, store } = await fixture([["add", "addr-a1", "Addressed", "--repo", "fixture"]]);
  const copy = join(dir, "copy.md");
  writeFileSync(copy, readFileSync(file));
  writeFileSync(join(dir, ".tasks.toml"), 'backend = "sqlite"\n[markdown]\npath = "copy.md"\n');
  const saved = { file: process.env.TASKS_AXI_FILE, backend: process.env.TASKS_AXI_BACKEND };
  process.env.TASKS_AXI_FILE = copy;
  process.env.TASKS_AXI_BACKEND = "sqlite";
  try {
    await store.start("addr-a1");
  } finally {
    process.env.TASKS_AXI_FILE = saved.file;
    process.env.TASKS_AXI_BACKEND = saved.backend;
    if (saved.file === undefined) delete process.env.TASKS_AXI_FILE;
    if (saved.backend === undefined) delete process.env.TASKS_AXI_BACKEND;
  }
  assert.equal((await store.read("addr-a1"))?.state, "in_flight");
  assert.ok(!readFileSync(copy, "utf8").includes("in_flight"));
});

test("open refuses relative, linked and non-canonical store paths", async () => {
  const { dir, home, file } = await fixture();
  const base = { node, entrypoint, repo: "fixture", home };
  await assert.rejects(TasksAxiStore.open({ ...base, file: "backlog.md" }));
  const link = join(dir, "link.md");
  symlinkSync(file, link);
  await assert.rejects(TasksAxiStore.open({ ...base, file: link }), /link/);
  await assert.rejects(TasksAxiStore.open({ ...base, file: `${dir}/home/../backlog.md` }), /canonical/);
});

test("a command that does not finish is classified as an unknown outcome", async () => {
  const { home, file } = await fixture([["add", "slow-a1", "Slow", "--repo", "fixture"]]);
  const store = await TasksAxiStore.open({ node, entrypoint, file, repo: "fixture", home, timeoutMs: 1 });
  await assert.rejects(store.start("slow-a1"), (error: unknown) => error instanceof TaskStoreError && error.reason === "outcome_unknown");
});
