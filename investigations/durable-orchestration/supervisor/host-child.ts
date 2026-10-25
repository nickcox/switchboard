import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import { SwitchboardScenario } from "../design-a/driver.ts";
import { ApplicationStore } from "../design-a/store.ts";
import { openConfiguredStorage } from "../failures/configured-storage.ts";
import type { Request } from "../scenario/contract.ts";
import { FakeOwners } from "../scenario/owners.ts";

const context = BACKGROUND_CONTEXT;
export type Config = { objectiveId: string; replay: "safe" | "unsafe" };
export const taskId = "supervisor-fixture-task";
const input = { type: "input", content: "Dispatch the fixture task once, then inspect its current state.", requestId: "objective-input-1" } as const;

async function run(directory: string, mode: string): Promise<void> {
  assert.ok(["pause", "resume"].includes(mode));
  const config: Config = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
  assert.ok(config.objectiveId && ["safe", "unsafe"].includes(config.replay));
  const hostDirectory = join(directory, "host");
  const claim = join(hostDirectory, "owner");
  // Claim before either database opens. A surviving claim is never taken over automatically.
  try { await mkdir(claim); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("owner_claim_exists: confirm the fixture host stopped before recovery");
    throw error;
  }
  let driver: SwitchboardScenario | undefined;
  let harness: Harness | undefined;
  try {
    await writeFile(join(claim, "claim.json"), JSON.stringify({ pid: process.pid }), { flag: "wx", flush: true });
    const store = await ApplicationStore.open(hostDirectory);
    const owners = new FakeOwners(join(directory, "owners"), hostDirectory);
    driver = new SwitchboardScenario(store, owners);
    const application = driver;
    const journal = async (record: object) => appendFile(join(directory, "calls.jsonl"),
      `${JSON.stringify({ pid: process.pid, ...record })}\n`, { flush: true });
    const dispatch = defineTool({
      name: "dispatch", description: "Dispatch the one fixture task using the host's stable operation identity.",
      parameters: Type.Object({}), replay: config.replay,
      execute: async (_args, api) => {
        // The provider call ID is not session-unique. The persisted tool task ID is stable on replay;
        // the fixture objective UUID namespaces it across independently created stores.
        const request: Request = { requestId: `${config.objectiveId}:dispatch:${api.taskId}`, taskId,
          delivery: { outputBranch: "output/supervisor", requiredEvidence: ["tests"], requiredDeliverables: ["code"], acceptance: "review" } };
        await journal({ tool: "dispatch", taskId: api.taskId, callId: api.callId, requestId: request.requestId });
        const outcome = await application.submit(request);
        return { output: [{ type: "text", text: JSON.stringify(outcome) }] };
      },
    });
    const inspect = defineTool({
      name: "inspect_attempt", description: "Read current application facts and independent owner receipts; do not start or adopt workers.",
      parameters: Type.Object({}), replay: "safe",
      execute: async (_args, api) => {
        const snapshot = await application.inspect();
        const receipts = await owners.records();
        await journal({ tool: "inspect_attempt", taskId: api.taskId, snapshot, receipts });
        return { output: [{ type: "text", text: JSON.stringify({ snapshot, receipts }) }] };
      },
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "supervisor-fixture", tools: [dispatch, inspect], hooks: [hook(ToolTask, {
      afterTool: async (call, result, api) => {
        if (mode !== "pause" || call.name !== "dispatch") return undefined;
        // Public hook runs after application completion and before Durable's tool-result commit.
        const root = await harness!.root(context);
        const boundary = { conversationId: root.id, taskId: api.taskId, result,
          engine: await harness!.inspect(context), transcript: await root.context(context), snapshot: await application.inspect() };
        await writeFile(join(directory, "boundary.json"), JSON.stringify(boundary), { flag: "wx", flush: true });
        process.send?.({ type: "boundary" });
        // Deliberate hard-kill boundary, not graceful shutdown or an automatic retry.
        await new Promise<void>(() => { setInterval(() => {}, 1_000); });
        return undefined;
      },
    })] }));
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider); // Never register a network provider, even if credentials exist.
    const respond: FauxResponseFactory = async transcript => {
      const results = transcript.messages.filter(message => message.role === "toolResult");
      await journal({ modelRequest: true, results });
      if (!results.length) return fauxAssistantMessage(fauxToolCall("dispatch", {}, { id: "dispatch-call" }), { stopReason: "toolUse" });
      if (!results.some(message => message.toolName === "inspect_attempt")) {
        return fauxAssistantMessage(fauxToolCall("inspect_attempt", {}, { id: "inspect-call" }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("Existing attempt retained; worker termination is unverified. No replacement requested.");
    };
    faux.setResponses([respond, respond, respond]);
    const storage = await openConfiguredStorage(join(hostDirectory, "supervisor.db"), join(directory, "storage.jsonl"));
    try {
      harness = await Harness.open(storage, { models, registry,
        settings: { retry: { enabled: false }, compaction: { enabled: false } },
        onReport: (error, info) => { console.error(JSON.stringify({ error: String(error), info })); },
      }, context);
    } catch (error) { await storage.close(context); throw error; }
    const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    // These reads do not enable scheduling. Capture recovered intent before submit resumes it.
    const before = { engine: await harness.inspect(context), transcript: await root.context(context) };
    const submission = await root.submit(input, context);
    const settled = await submission.wait(context);
    await harness.waitForIdle(context);
    const result = { conversationId: root.id, submissionId: submission.id, settled, before,
      transcript: await root.context(context), engine: await harness.inspect(context), snapshot: await application.inspect() };
    await writeFile(join(directory, `${mode}.json`), JSON.stringify(result), { flag: "wx", flush: true });
  } finally {
    // Failure to close leaves the claim rather than allowing another owner into live storage.
    await harness?.close(context);
    await driver?.close();
    await rm(claim, { recursive: true });
  }
}

try {
  const [directory, mode] = process.argv.slice(2);
  if (!directory || !mode) throw new Error("Expected disposable fixture directory and mode");
  await run(directory, mode);
  process.disconnect?.();
} catch (error) {
  console.error(error);
  process.exitCode = 2;
  process.disconnect?.();
}
