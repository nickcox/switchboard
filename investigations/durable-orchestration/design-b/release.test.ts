import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness, type TaskId, type Wake } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const root = fileURLToPath(new URL("../../../.investigation/durable-orchestration/", import.meta.url));
const context = BACKGROUND_CONTEXT;
async function temporary(): Promise<string> {
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "design-b-release-"));
}

test("B release: sleepUntil persists its deadline; onWake leaves restart and wakeup to the host", async t => {
  const directory = await temporary();
  let harness: Harness | undefined;
  t.after(async () => { await harness?.close(context); await rm(directory, { recursive: true, force: true }); });
  let now = 100;
  let delivered = 0;
  const wakes: Wake[] = [];
  const Sleep = defineTask<{}, { phase: "wait" } | { phase: "deliver" }, string>({
    name: "investigation.b.sleep-probe", version: 1, initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (_task, runtime, taskContext) => { await runtime.sleepUntil(200, { phase: "deliver" }, taskContext); },
      deliver: async (_task, runtime, taskContext) => {
        delivered++;
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "due" } }), taskContext);
      },
    },
    abort: async (_task, runtime, taskContext) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "investigation-b-sleep-probe", tasks: [Sleep] }));
  const open = async () => Harness.open(await openNodeSqliteStorage(join(directory, "durable.db")), {
    registry, models: createModels(), now: () => now, onWake: wake => { wakes.push(wake); },
  }, context);
  harness = await open();
  const id = await (await harness.root(context)).commit(tx => tx.createTask(Sleep, {}, { ownership: { kind: "conversation" } }), context);
  harness.resume();
  let saved;
  for (let tries = 0; tries < 100; tries++) {
    saved = await harness.getTask(id, context);
    if (saved?.state.status === "sleeping") break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(saved?.state, { status: "sleeping", until: 200, checkpoint: { phase: "deliver" } });
  assert.ok(wakes.some(wake => !wake.active && wake.at === 200));
  await harness.close(context);
  harness = await open();
  assert.deepEqual((await harness.getTask(id, context))?.state, saved!.state);
  harness.resume();
  assert.equal(delivered, 0);
  now = 250;
  // onWake disabled the engine's sleep timer. Merely moving the clock starts nothing.
  assert.equal(delivered, 0);
  harness.resume();
  const receipt = await harness.waitForTask(id as TaskId<string>, context);
  assert.deepEqual(receipt.state.outcome, { status: "completed", result: "due" });
  assert.equal(delivered, 1);
});

test("B release: the fifth no-progress crash parks a task and reports restart_limit", async t => {
  const directory = await temporary();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = fileURLToPath(new URL("./release-child.ts", import.meta.url));
  const run = (mode: string): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((resolve, reject) => {
    execFile(process.execPath, [child, mode, directory], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error && !("code" in error && typeof error.code === "number")) reject(error);
      else resolve({ code: error?.code as number ?? 0, stdout, stderr });
    });
  });
  for (const mode of ["start", "resume", "resume", "resume", "resume"]) {
    const result = await run(mode);
    assert.equal(result.code, 76, result.stderr);
  }
  const parked = await run("inspect");
  assert.equal(parked.code, 0, parked.stderr);
  const result = JSON.parse(parked.stdout);
  assert.equal(result.restarts, 5);
  assert.equal(result.state.reason, "restart_limit");
  assert.equal((await readFile(join(directory, "invocations.jsonl"), "utf8")).trim().split("\n").length, 5);
  t.diagnostic(parked.stdout.trim());
});
