import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkerInput } from "../src/runtime/contracts.ts";
import { RuntimeRecords } from "../src/runtime/records.ts";
import { PiWorker, type PiWorkerOptions } from "../src/runtime/pi/worker.ts";

export function fixture(scenario = "normal", overrides: Partial<PiWorkerOptions> = {}) {
  const root = resolve(import.meta.dir, "../.investigation/runtime-unit");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "case-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  mkdirSync(join(dir, "home"));
  const input: WorkerInput = {
    identity: { contextId: "fixture-context", taskId: "task-a1", leaseId: randomUUID(), sessionId: randomUUID() },
    workspace,
    instructions: "Implement the task. Preserve literal Unicode separators: α\u2028β\u2029γ",
    acceptanceCriteria: ["Keep the output branch"],
    delivery: {
      baseRef: "main", startingCommit: "a".repeat(40), outputBranch: "switchboard/task-a1/attempt-1",
      kind: "code", acceptance: "review_or_integration",
      requiredEvidence: ["tests"], requiredDeliverables: ["code"],
    },
  };
  const records = new RuntimeRecords(join(dir, "runtime"));
  const log = join(dir, "requests.jsonl");
  const options: PiWorkerOptions = {
    executable: process.execPath,
    entrypoint: resolve(import.meta.dir, "fixtures/pi-rpc.ts"),
    provider: "fixture", model: "fixture", shellTool: "bash",
    requestMs: 1000, runMs: 1000, stopMs: 600,
    environment: {
      PATH: process.env.PATH ?? "", HOME: join(dir, "home"),
      FAKE_PI_SCENARIO: scenario, FAKE_PI_LOG: log,
    },
    ...overrides,
  };
  return { dir, input, records, log, options, worker: new PiWorker(records, options) };
}

export function resultFor(input: WorkerInput) {
  return {
    version: 1 as const, identity: input.identity, outcome: "completed" as const,
    summary: "Implementation complete; review remains",
    validationEvidence: [{ name: "tests", summary: "Fixture checks passed" }],
    workReferences: [{ kind: "git" as const, name: "code", branch: input.delivery.outputBranch, commit: "b".repeat(40) }],
  };
}
