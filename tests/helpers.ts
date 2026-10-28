import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkerInput } from "../src/runtime/contracts.ts";
import { RuntimeRecords, type RuntimeRecord } from "../src/runtime/records.ts";
import { Database } from "../src/database.ts";
import { PiWorker, type PiWorkerOptions } from "../src/runtime/pi/worker.ts";
import type { Task } from "../src/tasks/store.ts";
import type { AttemptRef } from "../src/attempts/log.ts";
import type { AttemptSpecification, RuntimeSettings } from "../src/attempts/specification.ts";

export const runtimeSettings: RuntimeSettings = {
  profile: "pi", executable: process.execPath, entrypoint: resolve(import.meta.dirname, "fixtures/pi-rpc.ts"),
  provider: "fixture", model: "fixture", shellTool: "bash", requestMs: 1000, runMs: 5000, stopMs: 600, statsMs: 300000, requestPollMs: 1000,
};
export function specificationFor(task: Task, ref: AttemptRef, overrides: Partial<AttemptSpecification> = {}): AttemptSpecification {
  return {
    version: 1, taskId: task.id, contextId: ref.contextId, definitionRevision: task.definitionRevision,
    title: task.title, instructions: task.body.trim() === "" ? task.title : task.body, acceptanceCriteria: task.acceptanceCriteria, repository: task.repo, kind: task.kind, objectiveId: task.objectiveId,
    backingRepository: "/fixture", baseRef: "main", outputBranch: "output",
    delivery: { kind: "code", acceptance: "review_or_integration", requiredEvidence: [], requiredDeliverables: [] },
    runtime: runtimeSettings, provenance: { configuration: "fixture" }, ...overrides,
  };
}

/** Runtime-only fixtures still have a real attempt to which launch rows refer. */
class FixtureRuntimeRecords extends RuntimeRecords {
  readonly databasePath: string;
  constructor(root: string) { super(root); this.databasePath = join(root, "switchboard.db"); }
  async reserve(input: WorkerInput, hook?: (record: RuntimeRecord) => Promise<void>) {
    const database = await Database.open(this.databasePath);
    try {
      await database.transaction(() => {
        const { contextId, taskId, leaseId } = input.identity;
        if (database.get("SELECT 1 FROM attempt_entries WHERE context = ? AND json_extract(entry, '$.data.leaseId') = ?", contextId, leaseId)) return;
        database.run("INSERT OR IGNORE INTO tasks(id,title,body,position) SELECT ?,?,'',COALESCE(MAX(position),0)+1 FROM tasks", taskId, taskId);
        const attempt = Number(database.get("SELECT COALESCE(MAX(number),0)+1 AS n FROM attempt_numbers WHERE context = ? AND task = ?", contextId, taskId)!.n);
        database.run("INSERT INTO attempt_numbers VALUES(?,?,?)", contextId, taskId, attempt);
        database.run("INSERT INTO attempts(context,task,number,reserved_at,closed) VALUES(?,?,?,?,1)", contextId, taskId, attempt, new Date().toISOString());
        database.run("INSERT INTO attempt_entries VALUES(?,?,?,?,?)", contextId, taskId, attempt, 0, JSON.stringify({ kind: "leased", data: {
          leaseId, workspace: input.workspace, baseRef: input.delivery.baseRef, outputBranch: input.delivery.outputBranch,
          startingCommit: input.delivery.startingCommit, backingRepository: "/fixture",
        } }));
        const { baseRef, outputBranch, startingCommit: _, ...delivery } = input.delivery;
        const specification = specificationFor({ id: taskId, title: taskId, body: input.instructions, acceptanceCriteria: input.acceptanceCriteria, definitionRevision: 1,
          repo: null, kind: null, objectiveId: null, state: "queued", held: false, holdReason: null, blocked: false }, { contextId, taskId, attempt },
        { baseRef, outputBranch, delivery, acceptanceCriteria: input.acceptanceCriteria });
        database.run("INSERT INTO attempt_specifications VALUES(?,?,?,?)", contextId, taskId, attempt, JSON.stringify(specification));
      });
    } finally { database.close(); }
    return super.reserve(input, hook);
  }
}

export function fixture(scenario = "normal", overrides: Partial<PiWorkerOptions> = {}) {
  const root = resolve(import.meta.dirname, "../.investigation/runtime-unit");
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
  const records = new FixtureRuntimeRecords(join(dir, "runtime"));
  const log = join(dir, "requests.jsonl");
  const options: PiWorkerOptions = {
    executable: process.execPath,
    entrypoint: resolve(import.meta.dirname, "fixtures/pi-rpc.ts"),
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

export async function withRuntimeDatabase<T>(records: { databasePath: string }, action: (database: Database) => T | Promise<T>): Promise<T> {
  const database = await Database.open(records.databasePath);
  try { return await action(database); } finally { database.close(); }
}

export function resultFor(input: WorkerInput) {
  return {
    version: 1 as const, identity: input.identity, outcome: "completed" as const,
    summary: "Implementation complete; review remains",
    criteriaReport: input.acceptanceCriteria.map((criterion, index) => ({
      position: index + 1, criterion, status: "met" as const, evidence: "Synthetic fixture evidence",
    })),
    validationEvidence: [{ name: "tests", summary: "Fixture checks passed" }],
    workReferences: [{ kind: "git" as const, name: "code", branch: input.delivery.outputBranch, commit: "b".repeat(40) }],
  };
}
