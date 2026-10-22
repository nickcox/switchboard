import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, defineExtension, defineTask, Harness, type TaskId, type TaskRuntime, type Wake } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { refuse } from "../scenario/contract.ts";
import type { Outcome, Request, ScenarioDriver, Snapshot } from "../scenario/contract.ts";
import { Operations, phases, type Phase } from "./operations.ts";

const context = BACKGROUND_CONTEXT;
type Checkpoint = { phase: Phase; poll: number };
type Receipt = { requestId: string; taskId: number; revision: number; response: Outcome | null };
const Requests = defineDoc<{ entries: Receipt[] }>({
  kind: "investigation.b.requests", version: 1, scope: "session", initial: () => ({ entries: [] }), checkpointWhen: () => true,
});
type Runtime = TaskRuntime<Request, Checkpoint, Outcome, {}>;
export type EngineOptions = { manualClock?: boolean; pollMs?: number };

// This object belongs to one exclusive host. Clients never open either database.
export class DurableScenario implements ScenarioDriver {
  readonly operations: Operations;
  harness!: Harness;
  readonly reports: { message: string; info: unknown }[] = [];
  wake: Wake = { active: false };
  private readonly recovered = new Set<number>();
  private readonly manual: boolean;
  private readonly pollMs: number;
  private clock: number;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(operations: Operations, options: EngineOptions) {
    this.operations = operations;
    this.manual = options.manualClock ?? false;
    this.pollMs = options.pollMs ?? 250;
    if (!Number.isInteger(this.pollMs) || this.pollMs < 1) throw new Error("pollMs must be positive");
    this.clock = 1_000_000;
  }

  static async open(operations: Operations, options: EngineOptions = {}): Promise<DurableScenario> {
    const engine = new DurableScenario(operations, options);
    const handlers = Object.fromEntries(phases.map(phase => [phase,
      async (task: { id: TaskId<Outcome>; input: Request; state: { checkpoint: Checkpoint } }, runtime: Runtime) => {
        let result;
        try {
          if (engine.recovered.has(task.id) && ["acquire", "start", "launch", "prompt"].includes(phase)) {
            // Inspect independent effects, but do not turn a restart into permission to launch or adopt.
            const attempt = operations.store.byRequest(task.input.requestId);
            if (attempt) await operations.owners.forAttempt(attempt.id);
            result = { outcome: refuse(phase === "acquire" ? "acquisition_uncertain" : "possibly_running", attempt?.id ?? null) };
          } else result = await operations.run(phase, task.input);
        } catch (error) {
          runtime.report(error);
          result = { outcome: { ...refuse("host_unavailable", operations.store.byRequest(task.input.requestId)?.id ?? null),
            nextAction: `Inspect host storage and external owners: ${error instanceof Error ? error.message : String(error)}` } };
        }
        if ("next" in result) {
          await runtime.commit(() => ({ status: "running", checkpoint: { phase: result.next, poll: task.state.checkpoint.poll } }), context);
        } else {
          const response = result.outcome;
          // Response publication and execution checkpoint share one Durable commit, not an application transaction.
          await runtime.commit(async tx => {
            const receipt = (await tx.doc(Requests)).entries.find(entry => entry.taskId === task.id)!;
            receipt.response = response;
            receipt.revision++;
            return result.retry
              ? { status: "sleeping", until: runtime.now() + engine.pollMs,
                checkpoint: { phase, poll: task.state.checkpoint.poll + 1 } }
              : { status: "terminal", outcome: response.status === "refused"
                ? { status: "failed", error: { message: response.code }, result: response }
                : { status: "completed", result: response } };
          }, context);
        }
      }]));
    const Workflow = defineTask<Request, Checkpoint, Outcome>({
      name: "investigation.b.workflow", version: 1, initial: () => ({ phase: "reserve", poll: 0 }),
      phases: handlers as Record<Phase, (task: Parameters<typeof handlers[string]>[0], runtime: Runtime) => Promise<void>>,
      abort: async (task, runtime, taskContext) => {
        const response = await operations.cancel(task.input.requestId);
        await runtime.commit(async tx => {
          const receipt = (await tx.doc(Requests)).entries.find(entry => entry.taskId === task.id)!;
          receipt.response = response;
          receipt.revision++;
          return { status: "terminal", outcome: { status: "aborted", result: response } };
        }, taskContext);
      },
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "investigation-b", tasks: [Workflow] }));
    const storage = await openNodeSqliteStorage(join(operations.store.directory, "durable.db"));
    try {
      engine.harness = await Harness.open(storage, {
        registry, models: createModels(),
        ...(engine.manual ? { now: () => engine.clock, onWake: (wake: Wake) => { engine.wake = wake; } } : {}),
        onReport: (error, info) => { engine.reports.push({ message: String(error), info }); },
      }, context);
      for (const task of (await engine.harness.inspect(context)).tasks) engine.recovered.add(task.record.id);
      const root = await engine.harness.root(context);
      engine.create = request => root.commit(async tx => {
        const index = await tx.doc(Requests);
        const existing = index.entries.find(entry => entry.requestId === request.requestId);
        if (existing) return existing.taskId;
        const taskId = await tx.createTask(Workflow, request, { ownership: { kind: "conversation" } });
        index.entries.push({ requestId: request.requestId, taskId, revision: 0, response: null });
        return taskId;
      }, context);
      engine.harness.resume();
      return engine;
    } catch (error) { await storage.close(context); throw error; }
  }

  private create!: (request: Request) => Promise<number>;
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(() => {
      if (this.closed) throw new Error("Execution host is closed");
      return action();
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
  private async receipt(requestId: string): Promise<Readonly<Receipt> | undefined> {
    return (await this.harness.snapshot(Requests, context))?.entries.find(entry => entry.requestId === requestId);
  }
  private async response(requestId: string, revision: number): Promise<Outcome> {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const receipt = await this.receipt(requestId);
      if (receipt?.response && receipt.revision > revision) return structuredClone(receipt.response);
      const inspection = await this.harness.inspect(context);
      if (inspection.tasks.some(task => task.record.id === receipt?.taskId && task.state.kind === "blocked")) {
        return { ...refuse("host_unavailable"), nextAction: "Inspect the blocked Durable task; do not retry the worker" };
      }
      const task = receipt && await this.harness.getTask(receipt.taskId as TaskId<Outcome>, context);
      if (task?.state.status === "terminal") return task.state.outcome.result ?? refuse("host_unavailable");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return { ...refuse("host_unavailable"), nextAction: "Execution did not report progress within 10 seconds; inspect before retrying the stable request ID" };
  }

  submit(request: Request): Promise<Outcome> {
    return this.serial(async () => {
      if (!validRequest(request)) return refuse("invalid_request");
      const previous = await this.receipt(request.requestId);
      if (previous) {
        const task = await this.harness.getTask(previous.taskId as TaskId<Outcome>, context);
        if (!isDeepStrictEqual(task?.input, request)) return refuse("request_conflict", previous.response?.attemptId ?? null);
        return previous.response ? structuredClone(previous.response) : this.response(request.requestId, 0);
      }
      await this.create(structuredClone(request));
      this.harness.resume();
      return this.response(request.requestId, 0);
    });
  }

  advance(requestId: string): Promise<Outcome> {
    return this.serial(async () => {
      const receipt = await this.receipt(requestId);
      if (!receipt) return refuse("invalid_request");
      const task = await this.harness.getTask(receipt.taskId as TaskId<Outcome>, context);
      if (task?.state.status === "terminal") return task.state.outcome.result ?? refuse("host_unavailable");
      if (this.manual) this.clock = Math.max(this.clock + this.pollMs,
        task?.state.status === "sleeping" ? task.state.until : this.clock);
      this.harness.resume();
      return this.response(requestId, receipt.revision);
    });
  }

  cancel(requestId: string): Promise<Outcome> {
    return this.serial(async () => {
      const receipt = await this.receipt(requestId);
      if (!receipt) return refuse("invalid_request");
      const task = await this.harness.getTask(receipt.taskId as TaskId<Outcome>, context);
      if (task?.state.status === "terminal") return task.state.outcome.result ?? refuse("host_unavailable");
      await this.harness.abortTask(receipt.taskId as TaskId<Outcome>, context);
      return this.response(requestId, receipt.revision);
    });
  }

  async inspect(): Promise<Snapshot> {
    await this.queue;
    return { attempts: this.operations.store.list(), active: this.operations.store.attempts.activeCount(), maxAttempts: this.operations.maximum };
  }
  async diagnostics(): Promise<unknown> {
    return { engine: await this.harness.inspect(context), wake: this.harness.wake(), reports: this.reports };
  }
  async close(): Promise<void> {
    await this.queue;
    if (this.closed) return;
    this.closed = true;
    await this.harness.close(context);
    this.operations.store.close();
  }
}

export function validRequest(value: unknown): value is Request {
  if (!value || typeof value !== "object") return false;
  const request = value as Request;
  const nonempty = (input: unknown): input is string => typeof input === "string" && input.trim().length > 0;
  const names = (input: unknown): boolean => Array.isArray(input) && input.every(nonempty);
  return nonempty(request.requestId) && nonempty(request.taskId) && !!request.delivery &&
    nonempty(request.delivery.outputBranch) && names(request.delivery.requiredEvidence) && names(request.delivery.requiredDeliverables) &&
    ["review", "forge_merge"].includes(request.delivery.acceptance);
}
