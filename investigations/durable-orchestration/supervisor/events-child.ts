import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, InboxDoc } from "@earendil-works/pi-durable";
import { ApplicationStore } from "../design-a/store.ts";
import { openConfiguredStorage } from "../failures/configured-storage.ts";
import { EventDelivery, initialInput, wakeInput, deliveryPoints, type EventConfig, type DeliverySnapshot, type DeliveryEvidence } from "./event-delivery.ts";

const context = BACKGROUND_CONTEXT;

async function run(directory: string, mode: string): Promise<void> {
  assert.ok(["pause", "resume"].includes(mode));
  const config: EventConfig = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
  assert.ok(config.objectiveId && deliveryPoints.includes(config.point) && ["none", "initial", "event"].includes(config.failure));
  const host = join(directory, "host");
  const claim = join(host, "owner");
  try { await mkdir(claim); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("owner_claim_exists: confirm the fixture host stopped before recovery");
    throw error;
  }
  let store: ApplicationStore | undefined;
  let harness: Harness | undefined;
  try {
    await writeFile(join(claim, "claim.json"), JSON.stringify({ pid: process.pid }), { flag: "wx", flush: true });
    store = await ApplicationStore.open(host);
    const delivery = new EventDelivery(store, config);
    await delivery.initialise();
    let started!: () => void;
    const firstRequest = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const faux = fauxProvider();
    // No tool or network provider. A held initial request keeps inputs queued at exact boundaries.
    const respond: Parameters<typeof faux.setResponses>[0][number] = async transcript => {
      const last = transcript.messages.findLast(message => message.role === "user")!;
      assert.equal(last.role, "user");
      assert.equal(typeof last.content, "string");
      const content = last.content as string;
      await appendFile(join(directory, "model-inputs.jsonl"), `${JSON.stringify({ pid: process.pid, content })}\n`, { flush: true });
      if (content === initialInput.content) { started(); await gate; }
      const fail = config.failure === "initial" && content === initialInput.content ||
        config.failure === "event" && content === JSON.stringify(delivery.events()[0]);
      return fail ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "injected non-retryable supervisor error" })
        : fauxAssistantMessage("Input observed. No attempt operation requested.");
    };
    faux.setResponses(Array.from({ length: 5 }, () => respond));
    const models = createModels();
    models.setProvider(faux.provider);
    const storage = await openConfiguredStorage(join(host, "supervisor.db"), join(directory, "storage.jsonl"));
    try {
      harness = await Harness.open(storage, { models, registry: createRegistry(),
        settings: { retry: { enabled: false }, compaction: { enabled: false }, afterFailedRun: "keep", followUpMode: "one-at-a-time" },
        onReport: (error, info) => { console.error(JSON.stringify({ error: String(error), info })); },
      }, context);
    } catch (error) { await storage.close(context); throw error; }
    const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    const snapshot = async (): Promise<DeliverySnapshot> => ({
      conversationId: conversation.id, position: delivery.position(),
      events: await conversation.commit(async tx => Promise.all(delivery.events().map(async event => ({ ...event,
        submission: await tx.submissionByRequest(conversation.id, event.id) ?? null,
      }))), context),
      initial: await conversation.commit(tx => tx.submissionByRequest(conversation.id, initialInput.requestId), context) ?? null,
      inbox: (await harness!.snapshot(InboxDoc, conversation.id, context))!.items.map(item => ({ id: item.id, mode: item.mode })),
      transcript: await conversation.context(context), engine: await harness!.inspect(context),
    });
    const before = await snapshot(); // Read-only acquisition does not resume pending generation.
    await conversation.submit(initialInput, context);
    await firstRequest;
    const deliveryCalls: DeliveryEvidence["deliveryCalls"] = [];
    const pause = async () => {
      await writeFile(join(directory, "boundary.json"), JSON.stringify({ ...await snapshot(), deliveryCalls }), { flag: "wx", flush: true });
      process.send?.({ type: "boundary" });
      await new Promise<void>(() => { setInterval(() => {}, 1_000); });
    };
    await delivery.deliver(conversation, async (point, event, submissionId) => {
      deliveryCalls.push({ point, eventId: event.id, submissionId: submissionId ?? null });
      if (mode === "pause" && point === config.point && event.entry.sequence === 0) await pause();
    });
    if (mode === "pause" && config.point === "queued") await pause();
    const queued = await snapshot();
    release();
    await harness.waitForIdle(context);
    const afterFailure = config.failure === "none" ? null : await snapshot();
    // A failed run keeps later inputs queued. An explicit new operator input, not redelivery
    // of an acknowledged event, starts the next boundary. It never retries an unanswered input.
    const wake = afterFailure ? await conversation.submit(wakeInput, context) : null;
    if (wake) await wake.wait(context);
    await harness.waitForIdle(context);
    const result: DeliveryEvidence = { before, queued, afterFailure, final: await snapshot(),
      wake: wake ? await wake.status(context) : null, deliveryCalls };
    await writeFile(join(directory, "resume.json"), JSON.stringify(result), { flag: "wx", flush: true });
  } finally {
    await harness?.close(context);
    store?.close();
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
