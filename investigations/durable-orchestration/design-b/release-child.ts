import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, defineExtension, defineTask, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { fixtureDirectory } from "./paths.ts";

const [mode, path] = process.argv.slice(2);
assert.ok(path && ["start", "resume", "inspect"].includes(mode!));
const directory = await fixtureDirectory(path);
const context = BACKGROUND_CONTEXT;
const Receipt = defineDoc<{ taskId: number }>({ kind: "investigation.b.crash-receipt", version: 1, scope: "session",
  initial: () => ({ taskId: 0 }), checkpointWhen: () => true });
const Crash = defineTask<{}, { phase: "run" }, null>({
  name: "investigation.b.crash-limit-probe", version: 1, initial: () => ({ phase: "run" }),
  phases: { run: async () => {
    await appendFile(join(directory, "invocations.jsonl"), "run\n", { flush: true });
    // Leave the scheduler's running record behind, without new task progress or graceful close.
    process.exit(76);
  } },
  abort: async (_task, runtime, taskContext) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
  },
});
const registry = createRegistry();
registry.install(defineExtension({ name: "investigation-b-crash-probe", tasks: [Crash] }));
const reports: string[] = [];
const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "durable.db")), {
  registry, models: createModels(), onReport: (_error, info) => { reports.push(info.type); },
}, context);
try {
  if (mode === "start") {
    const root = await harness.root(context);
    const id = await root.commit(async tx => {
      const id = await tx.createTask(Crash, {}, { ownership: { kind: "conversation" } });
      (await tx.doc(Receipt)).taskId = id;
      return id;
    }, context);
    await harness.waitForTask(id, context);
    assert.fail("The task should have exited the process");
  } else {
    const receipt = await harness.snapshot(Receipt, context);
    assert.ok(receipt);
    if (mode === "resume") {
      await harness.waitForTask(receipt.taskId as TaskId<null>, context);
      assert.fail("The task should have exited the process");
    }
    const inspection = await harness.inspect(context);
    const task = inspection.tasks[0]!;
    assert.equal(task.record.restarts, 5);
    assert.deepEqual(task.state, { kind: "blocked", reason: "restart_limit" });
    assert.equal(harness.wake().active, false);
    assert.ok(reports.includes("task_parked"));
    console.log(JSON.stringify({ restarts: task.record.restarts, state: task.state, reports, wake: harness.wake() }));
  }
} finally { await harness.close(context); }
