import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "pi-ai-1-3/models";
import { createRegistry, defineExtension, defineTask, Harness } from "durable-1-3";
import { openNodeSqliteStorage } from "durable-1-3/storage/sqlite/node";

const [directory, mode] = process.argv.slice(2) as [string, string];
const Workflow = defineTask<{}, { phase: "prepare" | "finish" }, string>({
  name: "investigation.upgrade", version: 1, initial: () => ({ phase: "prepare" }),
  phases: {
    prepare: async (_task, runtime) => {
      await appendFile(join(directory, "effects.jsonl"), "prepare\n", { flush: true });
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "finish" } }), context);
      process.exit(75);
    },
    finish: async (_task, runtime) => {
      await appendFile(join(directory, "effects.jsonl"), "finish-old\n", { flush: true });
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "old" } }), context);
    },
  },
  abort: async (_task, runtime) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context); },
});
try {
  const registry = createRegistry();
  registry.install(defineExtension({ name: "upgrade", tasks: [Workflow] }));
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "durable.db")), { registry, models: createModels() }, context);
  try {
    if (mode === "start") {
      const id = await (await harness.root(context)).commit(tx => tx.createTask(Workflow, {}, { ownership: { kind: "conversation" } }), context);
      await harness.waitForTask(id, context);
    } else {
      const inspection = await harness.inspect(context);
      console.log(JSON.stringify(inspection.tasks));
      if (mode === "resume") await harness.waitForTask(inspection.tasks[0]!.record.id, context);
    }
  } finally { await harness.close(context); }
} catch (error) { console.error(String(error)); process.exitCode = 2; }
