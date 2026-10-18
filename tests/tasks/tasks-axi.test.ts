import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TaskStoreError } from "../../src/tasks/store.ts";
import { TasksAxiStore } from "../../src/tasks/tasks-axi.ts";

// Runs the real tasks-axi 0.2.6 CLI against disposable stores. Requires Node.js on PATH.
const node = Bun.which("node");
if (!node) throw new Error("tasks-axi tests require Node.js on PATH");
const entrypoint = resolve(import.meta.dir, "../../node_modules/tasks-axi/dist/bin/tasks-axi.js");
const evidence = resolve(import.meta.dir, "../../.investigation/tasks-unit");
mkdirSync(evidence, { recursive: true });

async function fixture(setup: string[][] = []) {
  const dir = realpathSync(mkdtempSync(join(evidence, "case-")));
  const home = join(dir, "home");
  mkdirSync(home);
  const file = join(dir, "backlog.md");
  // Create the store and its tasks with the CLI directly, as an operator would.
  for (const args of [["add", "seed-z9", "Seed", "--repo", "other"], ...setup]) {
    const out = Bun.spawnSync([node!, entrypoint, ...args, "--json", "--backend", "markdown", "--file", file], { env: { PATH: process.env.PATH ?? "", HOME: home } });
    if (out.exitCode !== 0) throw new Error(out.stdout.toString() + out.stderr.toString());
  }
  const store = await TasksAxiStore.open({ node: node!, entrypoint, file, repo: "fixture", home });
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
  expect(await store.ready()).toEqual(["first-a1", "second-b1"]);
  expect(await store.inFlight()).toEqual(["flight-e1"]);
});

test("empty lists are empty, not errors", async () => {
  const { store } = await fixture();
  expect(await store.ready()).toEqual([]);
  expect(await store.inFlight()).toEqual([]);
});

test("read returns typed fields and preserves the body exactly; a missing task is undefined", async () => {
  const body = 'Instructions, commas and "quotes"\n\n## Acceptance\n- keep Unicode: α';
  const { store } = await fixture([["add", "read-a1", "123", "--repo", "fixture", "--body", body]]);
  expect(await store.read("read-a1")).toEqual({
    id: "read-a1", title: "123", state: "queued", repo: "fixture", blocked: false, held: false, holdReason: null, body,
  });
  expect(await store.read("missing-z9")).toBeUndefined();
});

test("start, done and hold read back what the store holds", async () => {
  const { store } = await fixture([
    ["add", "done-a1", "Done task", "--repo", "fixture", "--body", "Original"],
    ["add", "hold-b1", "Hold task", "--repo", "fixture", "--body", "Original"],
    ["add", "dependent-c1", "Dependent", "--repo", "fixture", "--blocked-by", "hold-b1"],
  ]);
  expect((await store.start("done-a1")).state).toBe("in_flight");
  const note = JSON.stringify({ leaseId: "lease-1", resultCommit: "b".repeat(40) });
  expect((await store.recordDone("done-a1", note)).state).toBe("done");
  // Repeating done is accepted by tasks-axi and leaves the same record.
  expect((await store.recordDone("done-a1", note)).body).toContain(note);

  await store.start("hold-b1");
  const body = `Original\n\nSwitchboard outcome: ${note}`;
  const held = await store.recordHold("hold-b1", { reason: "Review required", body });
  expect(held).toMatchObject({ state: "queued", held: true, holdReason: "Review required", body });
  expect((await store.read("dependent-c1"))?.blocked).toBe(true);
  expect(await store.ready()).toEqual([]);
});

test("a partly applied hold is completed by running it again", async () => {
  const { store } = await fixture([
    ["add", "part-a1", "Partial", "--repo", "fixture", "--body", "Original"],
    ["start", "part-a1"],
    ["hold", "part-a1", "--reason", "Review required"],
  ]);
  const held = await store.recordHold("part-a1", { reason: "Review required", body: "Original\n\nOutcome" });
  expect(held).toMatchObject({ state: "queued", held: true, body: "Original\n\nOutcome" });
});

test("an invalid hold reason is refused before any write", async () => {
  const { store, file } = await fixture([["add", "bad-a1", "Bad", "--repo", "fixture"], ["start", "bad-a1"]]);
  const before = readFileSync(file, "utf8");
  await expect(store.recordHold("bad-a1", { reason: "Failed (exit 1)", body: "x" })).rejects.toThrow("parentheses");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("a refused change is reported as rejected", async () => {
  const { store } = await fixture();
  const error = await store.start("missing-z9").catch(e => e);
  expect(error).toBeInstanceOf(TaskStoreError);
  expect(error.reason).toBe("rejected");
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
  expect((await store.read("addr-a1"))?.state).toBe("in_flight");
  expect(readFileSync(copy, "utf8")).not.toContain("in_flight");
});

test("open refuses relative, linked and non-canonical store paths", async () => {
  const { dir, home, file } = await fixture();
  const base = { node: node!, entrypoint, repo: "fixture", home };
  await expect(TasksAxiStore.open({ ...base, file: "backlog.md" })).rejects.toThrow();
  const link = join(dir, "link.md");
  symlinkSync(file, link);
  await expect(TasksAxiStore.open({ ...base, file: link })).rejects.toThrow("link");
  await expect(TasksAxiStore.open({ ...base, file: `${dir}/home/../backlog.md` })).rejects.toThrow("canonical");
});

test("a command that does not finish is classified as an unknown outcome", async () => {
  const { home, file } = await fixture([["add", "slow-a1", "Slow", "--repo", "fixture"]]);
  const store = await TasksAxiStore.open({ node: node!, entrypoint, file, repo: "fixture", home, timeoutMs: 1 });
  const error = await store.start("slow-a1").catch(e => e);
  expect(error).toBeInstanceOf(TaskStoreError);
  expect(error.reason).toBe("outcome_unknown");
});
