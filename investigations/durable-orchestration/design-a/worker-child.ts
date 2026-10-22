import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Identity, Request, WorkerResult } from "../scenario/contract.ts";

// A controlled child, not an agent. Its files belong to the external owner, outside host storage.
const directory = process.argv[2]!;
await mkdir(directory, { recursive: true });
await writeFile(join(directory, "pid.json"), JSON.stringify({ pid: process.pid }), { flag: "wx", flush: true });
let prompted = false;
process.on("message", async (message: { type: string; identity: Identity; request: Request }) => {
  if (message.type === "exit") process.exit(0);
  if (message.type !== "prompt" || prompted) throw new Error("Unexpected or repeated initial prompt");
  prompted = true;
  await appendFile(join(directory, "prompts.jsonl"), `${JSON.stringify(message.identity)}\n`, { flush: true });
  const result: WorkerResult = {
    identity: message.identity, outcome: "completed", commit: "a".repeat(40),
    branch: message.request.delivery.outputBranch,
    evidence: message.request.delivery.requiredEvidence, deliverables: message.request.delivery.requiredDeliverables,
  };
  await writeFile(join(directory, "result.json"), JSON.stringify(result), { flag: "wx", flush: true });
  process.send!({ type: "result" });
  // A written result is deliberately not exit evidence. The test releases this gate explicitly.
});
process.send!({ type: "ready" });
