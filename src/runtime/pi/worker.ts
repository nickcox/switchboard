import { isAbsolute } from "node:path";
import { z } from "zod";
import { bounded, RuntimeFailure } from "../async.ts";
import { validateWorkerResult, workerResultSchema, type WorkerInput, type WorkerResult } from "../contracts.ts";
import { ActivityWriter, shorten, type ActivityEntry } from "../activity.ts";
import { startHeartbeat } from "../heartbeat.ts";
import { claimRequest, recordResult, unclaimedRequests, type ControlRequest, type RequestResult } from "../requests.ts";
import { inside, readJsonFile, RuntimeRecords, type ChildExit, type RuntimeBinding } from "../records.ts";
import type { RpcRecord } from "./jsonl.ts";
import { PiRpcClient } from "./rpc-client.ts";

const stateSchema = z.object({
  model: z.object({ provider: z.string(), id: z.string() }),
  sessionId: z.string(), sessionFile: z.string(),
  isStreaming: z.boolean(), isCompacting: z.boolean(), pendingMessageCount: z.number().int().nonnegative(),
});
const promptSchema = z.object({ disposition: z.literal("started") });
const resultJsonSchema = z.toJSONSchema(workerResultSchema);
const optionsSchema = z.object({
  executable: z.string().refine(isAbsolute, "Executable must be absolute"),
  entrypoint: z.string().refine(isAbsolute, "Entrypoint must be absolute").optional(),
  provider: z.string().min(1).refine(value => !value.startsWith("-")),
  model: z.string().min(1).refine(value => !value.startsWith("-")),
  environment: z.record(z.string(), z.string()),
  shellTool: z.enum(["bash", "powershell"]),
  requestMs: z.number().int().positive().default(5000),
  runMs: z.number().int().positive().default(30 * 60 * 1000),
  stopMs: z.number().int().min(100).default(5000),
  /** How often to record a usage snapshot while the worker runs. One is also taken after each assistant message. */
  statsMs: z.number().int().positive().default(5 * 60 * 1000),
  /** Stop the worker once a usage snapshot exceeds either limit. Subscription providers may report a cost of zero. */
  maxCost: z.number().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  /** How often the owning dispatcher checks for stop requests and operator messages while the worker runs. */
  requestPollMs: z.number().int().positive().default(1000),
});
export type WorkerHooks = {
  onActivity?: (entry: ActivityEntry) => void;
  /** Called once for each stop request or operator message this worker forwarded, with what happened. */
  onRequest?: (request: ControlRequest, result: Omit<RequestResult, "version" | "at">) => void;
};
const statsSchema = z.object({ tokens: z.object({ total: z.number() }), cost: z.number() });
export type PiWorkerOptions = z.input<typeof optionsSchema>;
export type PiRunReport = {
  binding: RuntimeBinding;
  directory: string;
  status: "reported" | "failed" | "interrupted" | "unresolved";
  childExit: ChildExit | undefined;
  /** Direct-child exit does not establish that tool subprocesses have stopped. */
  workerTermination: "unverified";
  reason: string | undefined;
  detail: string | undefined;
  stderrTail: string;
  result: WorkerResult | undefined;
};

/** Initial RPC adapter foundation. Not safe to use as a workspace-return authority yet. */
export class PiWorker {
  private readonly records: RuntimeRecords;
  private readonly options: z.output<typeof optionsSchema>;
  constructor(records: RuntimeRecords, options: PiWorkerOptions) {
    this.records = records;
    this.options = optionsSchema.parse(options);
  }

  async execute(input: WorkerInput, operator?: AbortSignal, hooks: WorkerHooks = {}): Promise<PiRunReport> {
    if (operator?.aborted) throw new RuntimeFailure("interrupted", "Interrupted before launch");
    const reserved = await this.records.reserve(input);
    const stopHeartbeat = await startHeartbeat(reserved.directory);
    try { return await this.executeReserved(reserved, operator, hooks); }
    finally { await stopHeartbeat(); }
  }

  private async executeReserved(reserved: { binding: RuntimeBinding; directory: string }, operator: AbortSignal | undefined, hooks: WorkerHooks): Promise<PiRunReport> {
    const { binding, directory } = reserved;
    const activity = new ActivityWriter(directory, hooks.onActivity);
    // Exceeding a usage limit, or a stop request, stops the worker the same way an operator interruption does.
    const budget = new AbortController();
    const stopRequest = new AbortController();
    let stoppedBy: string | undefined;
    const signal = AbortSignal.any([budget.signal, stopRequest.signal, ...(operator ? [operator] : [])]);
    let requestTimer: ReturnType<typeof setInterval> | undefined;
    let forwarding = false;
    // Only this process holds the worker's RPC channel, so it alone forwards requests, each at most once.
    const forwardRequests = async (current: PiRpcClient) => {
      if (forwarding || current.childExit) return;
      forwarding = true;
      try {
        for (const request of await unclaimedRequests(reserved).catch(() => [])) {
          if (!(await claimRequest(reserved, request.id, "dispatcher").catch(() => false))) continue;
          let result: Omit<RequestResult, "version" | "at">;
          if (request.kind === "stop") {
            stoppedBy ??= request.sender;
            result = { outcome: "stopping" };
            activity.write({ kind: "note", text: `Stop requested by ${request.sender}` });
            stopRequest.abort();
          } else {
            try {
              const data = await current.request(request.kind, { message: request.message }, this.options.requestMs);
              const disposition = isObject(data) && typeof data.disposition === "string" ? data.disposition : "accepted";
              result = { outcome: disposition };
            } catch (error) { result = { outcome: "failed", error: asError(error).message }; }
            activity.write({ kind: "note", text: `${request.kind === "steer" ? "Steering message" : "Follow-up"} from ${request.sender} (${result.outcome}): ${shorten(request.message ?? "")}` });
          }
          await recordResult(reserved, request.id, result).catch(() => {});
          try { hooks.onRequest?.(request, result); } catch { /* Recording must not affect the worker. */ }
        }
      } finally { forwarding = false; }
    };
    let lastSnapshot = 0;
    let statsTimer: ReturnType<typeof setInterval> | undefined;
    const snapshot = async (current: PiRpcClient) => {
      if (current.childExit || budget.signal.aborted) return;
      lastSnapshot = Date.now();
      try {
        const stats = statsSchema.parse(await current.request("get_session_stats", {}, this.options.requestMs));
        activity.write({ kind: "stats", tokens: stats.tokens.total, cost: stats.cost });
        const over = (this.options.maxCost !== undefined && stats.cost > this.options.maxCost) ||
          (this.options.maxTokens !== undefined && stats.tokens.total > this.options.maxTokens);
        if (over && !budget.signal.aborted) {
          activity.write({ kind: "note", text: `Usage limit exceeded (${stats.tokens.total} tokens, $${stats.cost.toFixed(2)}); stopping the worker` });
          budget.abort();
        }
      } catch { /* Usage snapshots are diagnostic; a failed one is skipped. */ }
    };
    const observe = (record: RpcRecord, current: () => PiRpcClient | undefined) => {
      if (record.type === "tool_execution_start") {
        activity.write({ kind: "tool_start", tool: String(record.toolName), id: String(record.toolCallId), args: shorten(JSON.stringify(record.args ?? {})) });
      } else if (record.type === "tool_execution_end") {
        activity.write({ kind: "tool_end", tool: String(record.toolName), id: String(record.toolCallId), ms: typeof record.durationMs === "number" ? record.durationMs : null, error: record.isError === true });
      } else if (record.type === "queue_update") {
        activity.write({ kind: "queue", steering: Array.isArray(record.steering) ? record.steering.length : 0, followUp: Array.isArray(record.followUp) ? record.followUp.length : 0 });
      } else if (record.type === "message_end" && isObject(record.message) && record.message.role === "assistant") {
        const text = Array.isArray(record.message.content)
          ? record.message.content.flatMap(part => (isObject(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join(" ")
          : "";
        if (text.trim()) activity.write({ kind: "assistant", text: shorten(text) });
        const client = current();
        if (client && Date.now() - lastSnapshot > 30_000) void snapshot(client);
      }
    };
    let client: PiRpcClient | undefined;
    let failure: Error | undefined;
    let result: WorkerResult | undefined;
    let receipt: Promise<void> | undefined;
    try {
      if (signal?.aborted) throw new RuntimeFailure("interrupted", "Interrupted before spawn");
      client = new PiRpcClient({
        executable: this.options.executable,
        args: this.arguments(binding),
        cwd: binding.input.workspace,
        env: { ...this.options.environment, PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" },
        onEvent: record => observe(record, () => client),
      });
      receipt = client.exited.then(exit => this.records.recordChildExit(reserved, exit));
      void receipt.catch(() => {});
      await bounded(client.started, this.options.requestMs, "startup_timeout", signal);
      const state = stateSchema.parse(await this.rpc(client, "get_state", {}, signal));
      this.validateState(state, binding);
      await this.rpc(client, "set_auto_retry", { enabled: false }, signal);
      const settled = client.beginRun();
      // Never retry this command: a lost acknowledgement may still have started work.
      promptSchema.parse(await this.rpc(client, "prompt", { message: workerPrompt(binding) }, signal));
      activity.write({ kind: "note", text: `Worker started (session ${binding.input.identity.sessionId})` });
      const running = client;
      statsTimer = setInterval(() => void snapshot(running), this.options.statsMs);
      requestTimer = setInterval(() => void forwardRequests(running), this.options.requestPollMs);
      const ending = await bounded(settled, this.options.runMs, "worker_timeout", signal);
      await snapshot(client);
      if (ending.aborted) throw new RuntimeFailure("worker_aborted", "Pi reported an aborted run");
      if (ending.lastAssistantStop !== "stop") throw new RuntimeFailure("invalid_model_end", "Missing successful terminal assistant response");
      this.validateState(stateSchema.parse(await this.rpc(client, "get_state", {}, signal)), binding);
    } catch (error) { failure = asError(error); }
    if (statsTimer) clearInterval(statsTimer);
    if (requestTimer) clearInterval(requestTimer);

    if (client) {
      await this.shutdown(client, failure !== undefined);
      if (client.childExit) {
        try {
          await bounded(client.closed, this.options.requestMs, "stream_close_timeout");
          await bounded(receipt!, this.options.requestMs, "exit_receipt_timeout");
          if (client.failure) throw client.failure;
        } catch (error) { failure ??= asError(error); }
      }
      if (!failure && client.childExit?.started && client.childExit.code === 0 && client.childExit.signal === null) {
        try { result = validateWorkerResult(await readJsonFile(binding.resultPath), binding.input); }
        catch (error) { failure = new RuntimeFailure("invalid_result", asError(error).message); }
      } else if (!failure && client.childExit) {
        failure = new RuntimeFailure("worker_exit", "Pi did not exit successfully");
      }
    } else {
      // A synchronous spawn failure creates no child. Retain the unused allocation evidence.
      await this.records.recordChildExit(reserved, { started: false, code: null, signal: null });
    }
    if (operator?.aborted) {
      result = undefined;
      failure = new RuntimeFailure("interrupted", "Operator interrupted the worker");
    } else if (stopRequest.signal.aborted) {
      result = undefined;
      failure = new RuntimeFailure("interrupted", `Stopped at the request of ${stoppedBy}`);
    } else if (budget.signal.aborted) {
      result = undefined;
      failure = new RuntimeFailure("over_budget", "The worker was stopped because the attempt exceeded its usage limit");
    }
    const childExit = client?.childExit;
    const stopped = failure instanceof RuntimeFailure && (failure.reason === "interrupted" || failure.reason === "over_budget");
    const status = !childExit && client ? "unresolved" : stopped ? "interrupted" : failure ? "failed" : "reported";
    activity.write({ kind: "note", text: `Worker finished: ${status}${failure ? ` (${failure instanceof RuntimeFailure ? failure.reason : "runtime_failure"})` : ""}` });
    await activity.close();
    return {
      binding, directory, workerTermination: "unverified", childExit,
      status,
      reason: !childExit && client ? "termination_unknown" : failure instanceof RuntimeFailure ? failure.reason : failure ? "runtime_failure" : undefined,
      detail: failure?.message, stderrTail: client?.stderrTail ?? "", result,
    };
  }

  private rpc(client: PiRpcClient, type: string, fields: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return bounded(client.request(type, fields, this.options.requestMs), this.options.requestMs, "rpc_timeout", signal);
  }

  private validateState(state: z.infer<typeof stateSchema>, binding: RuntimeBinding): void {
    if (state.sessionId !== binding.input.identity.sessionId || !isAbsolute(state.sessionFile) ||
      !inside(binding.sessionDirectory, state.sessionFile) || state.sessionFile === binding.sessionDirectory) {
      throw new RuntimeFailure("session_identity", "Pi state does not match the allocated session");
    }
    if (state.model.provider !== this.options.provider || state.model.id !== this.options.model) {
      throw new RuntimeFailure("model_identity", "Pi did not select the exact configured model");
    }
    if (state.isStreaming || state.isCompacting || state.pendingMessageCount !== 0) {
      throw new RuntimeFailure("unexpected_activity", "Pi is not idle with an empty input queue");
    }
  }

  private arguments(binding: RuntimeBinding): string[] {
    return [
      ...(this.options.entrypoint ? [this.options.entrypoint] : []),
      "--mode", "rpc", "--session-id", binding.input.identity.sessionId,
      "--session-dir", binding.sessionDirectory,
      "--provider", this.options.provider, "--model", this.options.model,
      "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "--no-approve",
      "--tools", `read,edit,write,${this.options.shellTool}`,
    ];
  }

  private async shutdown(client: PiRpcClient, abort: boolean): Promise<void> {
    const start = Date.now();
    const total = this.options.stopMs;
    if (abort && !client.childExit) {
      for (const type of ["clear_queue", "abort"]) {
        const remaining = Math.floor(total / 2 - (Date.now() - start));
        if (remaining <= 0) break;
        try { await client.request(type, {}, remaining); } catch { /* Still close stdin and observe exit. */ }
      }
    }
    client.endInput();
    for (const [fraction, force] of [[0.75, undefined], [0.875, false], [1, true]] as const) {
      if (client.childExit) return;
      if (force !== undefined) client.terminateChild(force);
      const remaining = Math.max(1, Math.floor(total * fraction - (Date.now() - start)));
      try { await bounded(client.exited, remaining, "stop_timeout"); } catch { /* Sending a signal is not confirmation. */ }
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

export function workerPrompt(binding: RuntimeBinding): string {
  return [
    "Complete this one assigned task in the current workspace. Do not launch other agents.",
    "Do not change authoritative task records, mutate Treehouse leases, merge, push or publish.",
    "Use this instruction snapshot and resolved delivery contract unchanged:",
    JSON.stringify(binding.input, null, 2),
    `Before your final response, use the standard write tool to write exactly one JSON object to ${JSON.stringify(binding.resultPath)}.`,
    "Do not write binding.json or child-exit.json. Do not create alternative result files.",
    "Use the exact supplied identity and this result JSON Schema:",
    JSON.stringify(resultJsonSchema, null, 2),
    "validationEvidence is an array of {name,summary}. It reports your checks; it is not independent acceptance verification.",
    "workReferences is an array of {kind:'git',name,branch,commit} or {kind:'artefact',name,path,description}.",
    ...(binding.artefactDirectory ? [
      `Write reports and other artefact deliverables under ${JSON.stringify(binding.artefactDirectory)}, which survives after the workspace is recycled, and give their absolute paths in workReferences. Files left only in the workspace are not retained.`,
    ] : []),
    "For completed work, include every required evidence and deliverable name. Code must be committed to the named output branch.",
    "For hold or failed, also include nonempty reason and nextAction strings. Report completed implementation honestly even when review remains; Switchboard decides task acceptance.",
    "Use JSON double quotes. Missing or invalid results are failures, not completion. Do not create background processes; stop any tool subprocesses before finishing.",
    `The session directory is ${JSON.stringify(binding.sessionDirectory)}.`,
  ].join("\n\n");
}
