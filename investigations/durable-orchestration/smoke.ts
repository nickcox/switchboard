import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, defineExtension, defineTask, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

const [mode, directoryArgument] = process.argv.slice(2);
assert.ok(mode === "start" || mode === "resume" || mode === "inspect", "Expected start, resume or inspect");
assert.ok(directoryArgument, "Expected a directory under .investigation/durable-orchestration");
const directory = resolve(directoryArgument);
const temporaryRoot = fileURLToPath(new URL("../../.investigation/durable-orchestration/", import.meta.url));
const within = relative(temporaryRoot, directory);
assert.ok(within && !within.startsWith("..") && !isAbsolute(within), "Storage must be under the ignored investigation directory");
const context = BACKGROUND_CONTEXT;
const phaseLog = resolve(directory, "phases.jsonl");
const Receipt = defineDoc<{ taskId: number }>({
  kind: "investigation.receipt", version: 1, scope: "session", initial: () => ({ taskId: 0 }),
});
const Probe = defineTask<{ requestId: string }, { phase: "prepare" } | { phase: "finish"; requestId: string }, string>({
  name: "investigation.restart-probe",
  version: 1,
  initial: () => ({ phase: "prepare" }),
  phases: {
    prepare: async (task, runtime, taskContext) => {
      await appendFile(phaseLog, `${JSON.stringify({ phase: "prepare", taskId: task.id })}\n`);
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "finish", requestId: task.input.requestId } }), taskContext);
      // Deliberately stop without close, after acknowledgement of the checkpoint.
      process.exit(75);
    },
    finish: async (task, runtime, taskContext) => {
      assert.equal(task.state.checkpoint.requestId, "baseline-1");
      await appendFile(phaseLog, `${JSON.stringify({ phase: "finish", taskId: task.id })}\n`);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "checkpoint recovered" } }), taskContext);
    },
  },
  abort: async (_task, runtime, taskContext) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
  },
});
const registry = createRegistry();
registry.install(defineExtension({ name: "investigation", tasks: [Probe] }));
const storage = await openNodeJsonlStorage(resolve(directory, "storage"), context, { fsync: true });
const harness = await Harness.open(storage, { models: createModels(), registry }, context);
try {
  if (mode === "start") {
    assert.equal(await harness.snapshot(Receipt, context), undefined, "Start requires a fresh store");
    const root = await harness.root(context);
    const taskId = await root.commit(async tx => {
      const id = await tx.createTask(Probe, { requestId: "baseline-1" }, { ownership: { kind: "conversation" } });
      (await tx.doc(Receipt)).taskId = id;
      return id;
    }, context);
    await harness.waitForTask(taskId, context);
    assert.fail("The prepare phase should have exited the process");
  } else {
    const receipt = await harness.snapshot(Receipt, context);
    assert.ok(receipt && receipt.taskId > 0, "The original task ID must survive restart");
    const taskId = receipt.taskId as TaskId<string>;
    const saved = await harness.getTask(taskId, context);
    assert.ok(saved);
    if (mode === "resume") {
      assert.deepEqual(saved.state, { status: "pending", checkpoint: { phase: "finish", requestId: "baseline-1" } });
      const finished = await harness.waitForTask(taskId, context);
      assert.deepEqual(finished.state, { status: "terminal", outcome: { status: "completed", result: "checkpoint recovered" } });
      console.log(JSON.stringify({ node: process.version, taskId, recovered: saved.state, result: finished.state }));
    } else {
      assert.equal(saved.state.status, "terminal");
      assert.equal((await harness.inspect(context)).tasks.length, 0);
      console.log(JSON.stringify({ taskId, state: saved.state }));
    }
  }
} finally {
  await harness.close(context);
}
