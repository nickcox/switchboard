import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const [directory, mode] = process.argv.slice(2) as [string, string];
const Workflow = defineTask<{}, { phase: "prepare" | "finish" }, string>({
  name: "investigation.upgrade", version: 1, initial: () => ({ phase: "prepare" }),
  phases: {
    prepare: async (_task, runtime) => {
      // Independent evidence must be consulted on retry. The test reopens for inspection only,
      // rather than claiming that a failed commit means the effect did not happen.
      await appendFile(join(directory, "effects.jsonl"), "prepare\n", { flush: true });
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "finish" } }), context);
    },
    finish: async (_task, runtime) => {
      await appendFile(join(directory, "effects.jsonl"), "finish-new\n", { flush: true });
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "new" } }), context);
    },
  },
  abort: async (_task, runtime) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context); },
});
const registry = createRegistry();
if (mode !== "missing") registry.install(defineExtension({ name: "upgrade", tasks: [Workflow] }));
const storage = await openNodeSqliteStorage(join(directory, "durable.db"));
const original = storage.commit.bind(storage);
let injected = false;
if (mode.startsWith("fault")) storage.commit = async (writes, ctx) => {
  if (!injected && writes.some(write => write.type === "task" && write.value.state.status === "running" &&
    (write.value.state.checkpoint as { phase?: string }).phase === "finish")) {
    injected = true;
    if (mode === "fault-after") await original(writes, ctx);
    throw new Error("injected engine commit failure");
  }
  return original(writes, ctx);
};
const reports: string[] = [];
const harness = await Harness.open(storage, { registry, models: createModels(), onReport: (_error, info) => reports.push(info.type) }, context);
try {
  if (mode.startsWith("fault")) {
    const id = await (await harness.root(context)).commit(tx => tx.createTask(Workflow, {}, { ownership: { kind: "conversation" } }), context);
    await assert.rejects(harness.waitForTask(id, context), /injected|failed/i);
    await assert.rejects(harness.inspect(context), /failed/i);
    assert.ok(injected);
    assert.ok(reports.includes("session_failed"));
    console.log(JSON.stringify({ injected, reports, mode }));
    // End without a graceful close after the storage failure, as the process-crash counterpart.
    process.exit(77);
  }
  const inspection = await harness.inspect(context);
  console.log(JSON.stringify(inspection.tasks));
  if (mode === "resume") await harness.waitForTask(inspection.tasks[0]!.record.id, context);
} finally { await harness.close(context); }
