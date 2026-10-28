import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { bounded, RuntimeFailure } from "../async.ts";
import { keepAwakeSchema } from "../keep-awake.ts";
import { workerResultSchema, type WorkerInput } from "../contracts.ts";
import { shorten } from "../activity.ts";
import { questionsDirectory } from "../questions.ts";
import { inside, RuntimeRecords, thinkingLevelSchema, type RuntimeBinding } from "../records.ts";
import { WorkerSupervisor, type RunReport, type RuntimeAdapter, type RuntimeSession, type SessionEvents, type WorkerHooks } from "../supervisor.ts";
import type { RpcRecord } from "./jsonl.ts";
import { PiRpcClient, type RunSettled } from "./rpc-client.ts";

export type { WorkerHooks } from "../supervisor.ts";
/** The run report is the same for every runtime; this name is kept for existing callers. */
export type PiRunReport = RunReport;

const stateSchema = z.object({
  model: z.object({ provider: z.string(), id: z.string() }),
  thinkingLevel: thinkingLevelSchema,
  sessionId: z.string(), sessionFile: z.string(),
  isStreaming: z.boolean(), isCompacting: z.boolean(), pendingMessageCount: z.number().int().nonnegative(),
});
const promptSchema = z.object({ disposition: z.literal("started") });
const resultJsonSchema = z.toJSONSchema(workerResultSchema);
const optionsSchema = z.object({
  keepAwake: keepAwakeSchema.default(true),
  executable: z.string().refine(isAbsolute, "Executable must be absolute"),
  entrypoint: z.string().refine(isAbsolute, "Entrypoint must be absolute").optional(),
  provider: z.string().min(1).refine(value => !value.startsWith("-")),
  model: z.string().min(1).refine(value => !value.startsWith("-")),
  thinking: thinkingLevelSchema.optional(),
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
const statsSchema = z.object({ tokens: z.object({ total: z.number() }), cost: z.number() });
export type PiWorkerOptions = z.input<typeof optionsSchema>;

/** The Pi runtime: Pi's CLI in RPC mode, supervised by the shared WorkerSupervisor. */
export class PiWorker {
  private readonly supervisor: WorkerSupervisor;
  constructor(records: RuntimeRecords, options: PiWorkerOptions) {
    const parsed = optionsSchema.parse(options);
    this.supervisor = new WorkerSupervisor(records, new PiAdapter(parsed), {
      requestMs: parsed.requestMs, runMs: parsed.runMs, statsMs: parsed.statsMs, requestPollMs: parsed.requestPollMs,
      maxCost: parsed.maxCost, maxTokens: parsed.maxTokens, keepAwake: parsed.keepAwake,
    });
  }

  execute(input: WorkerInput, operator?: AbortSignal, hooks: WorkerHooks = {}): Promise<PiRunReport> {
    return this.supervisor.execute(input, operator, hooks);
  }
}

class PiAdapter implements RuntimeAdapter {
  private readonly options: z.output<typeof optionsSchema>;
  constructor(options: z.output<typeof optionsSchema>) { this.options = options; }
  open(binding: RuntimeBinding, events: SessionEvents): RuntimeSession { return new PiSession(this.options, binding, events); }
}

/** One Pi worker over RPC. Spawns Pi when constructed. */
class PiSession implements RuntimeSession {
  private readonly options: z.output<typeof optionsSchema>;
  private readonly binding: RuntimeBinding;
  private readonly events: SessionEvents;
  private readonly client: PiRpcClient;
  private settled: Promise<RunSettled> | undefined;
  private ending: RunSettled | undefined;

  constructor(options: z.output<typeof optionsSchema>, binding: RuntimeBinding, events: SessionEvents) {
    this.options = options;
    this.binding = binding;
    this.events = events;
    this.client = new PiRpcClient({
      executable: options.executable,
      args: this.arguments(),
      cwd: binding.input.workspace,
      env: { ...options.environment, PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" },
      onEvent: record => this.observe(record),
    });
  }

  get exited() { return this.client.exited; }
  get childExit() { return this.client.childExit; }
  get failure() { return this.client.failure; }
  get stderrTail() { return this.client.stderrTail; }

  async start(signal: AbortSignal): Promise<void> {
    await bounded(this.client.started, this.options.requestMs, "startup_timeout", signal);
    const state = stateSchema.parse(await this.rpc("get_state", {}, signal));
    await this.events.sessionStarted(state.thinkingLevel);
    this.validateState(state);
    await this.rpc("set_auto_retry", { enabled: false }, signal);
    this.settled = this.client.beginRun();
    // Never retry this command: a lost acknowledgement may still have started work.
    promptSchema.parse(await this.rpc("prompt", { message: workerPrompt(this.binding, new Date(Date.now() + this.options.runMs)) }, signal));
  }

  async waitForEnd(runMs: number, signal: AbortSignal): Promise<void> {
    this.ending = await bounded(this.settled!, runMs, "worker_timeout", signal);
  }

  async confirmEnd(signal: AbortSignal): Promise<void> {
    const ending = this.ending!;
    if (ending.aborted) throw new RuntimeFailure("worker_aborted", "Pi reported an aborted run");
    if (ending.lastAssistantStop !== "stop") {
      const detail = ending.lastAssistantStop === undefined ? "Missing successful terminal assistant response"
        : `The model request ended with stop reason ${ending.lastAssistantStop}${ending.lastAssistantError ? `: ${ending.lastAssistantError}` : ""}`;
      throw new RuntimeFailure("invalid_model_end", shorten(detail, 500));
    }
    this.validateState(stateSchema.parse(await this.rpc("get_state", {}, signal)));
  }

  async usage(): Promise<{ tokens: number; cost: number }> {
    const stats = statsSchema.parse(await this.client.request("get_session_stats", {}, this.options.requestMs));
    return { tokens: stats.tokens.total, cost: stats.cost };
  }

  async deliver(kind: "steer" | "follow_up", message: string, options?: { followUpWhenIdle: boolean }): Promise<string> {
    if (options?.followUpWhenIdle) {
      if (this.ending) return "not_running";
      const state = stateSchema.parse(await this.client.request("get_state", {}, this.options.requestMs));
      // A settled run cannot consume another queue entry. Keep the answer file and handover instead of restarting it.
      if (this.ending) return "not_running";
      if (!state.isStreaming && !state.isCompacting) kind = "follow_up";
    }
    const data = await this.client.request(kind, { message }, this.options.requestMs);
    const outcome = isObject(data) && typeof data.disposition === "string" ? data.disposition : "accepted";
    return options?.followUpWhenIdle ? `${kind}:${outcome}` : outcome;
  }

  async shutdown(abort: boolean): Promise<void> {
    const client = this.client;
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

  async closed(): Promise<void> {
    await bounded(this.client.closed, this.options.requestMs, "stream_close_timeout").catch(error => { this.client.releaseStreams(); throw error; });
  }

  private observe(record: RpcRecord): void {
    const activity = (entry: Parameters<SessionEvents["activity"]>[0]) => this.events.activity(entry);
    if (record.type === "tool_execution_start") {
      activity({ kind: "tool_start", tool: String(record.toolName), id: String(record.toolCallId), args: shorten(JSON.stringify(record.args ?? {})) });
    } else if (record.type === "tool_execution_end") {
      activity({ kind: "tool_end", tool: String(record.toolName), id: String(record.toolCallId), ms: typeof record.durationMs === "number" ? record.durationMs : null, error: record.isError === true });
    } else if (record.type === "queue_update") {
      activity({ kind: "queue", steering: Array.isArray(record.steering) ? record.steering.length : 0, followUp: Array.isArray(record.followUp) ? record.followUp.length : 0 });
    } else if (record.type === "message_end" && isObject(record.message) && record.message.role === "assistant") {
      const text = Array.isArray(record.message.content)
        ? record.message.content.flatMap(part => (isObject(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join(" ")
        : "";
      if (text.trim()) activity({ kind: "assistant", text: shorten(text) });
      this.events.turnEnded();
    }
  }

  private rpc(type: string, fields: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return bounded(this.client.request(type, fields, this.options.requestMs), this.options.requestMs, "rpc_timeout", signal);
  }

  private validateState(state: z.infer<typeof stateSchema>): void {
    const binding = this.binding;
    if (state.sessionId !== binding.input.identity.sessionId || !isAbsolute(state.sessionFile) ||
      !inside(binding.sessionDirectory, state.sessionFile) || state.sessionFile === binding.sessionDirectory) {
      throw new RuntimeFailure("session_identity", "Pi state does not match the allocated session");
    }
    if (state.model.provider !== this.options.provider || state.model.id !== this.options.model) {
      throw new RuntimeFailure("model_identity", "Pi did not select the exact configured model");
    }
    if (this.options.thinking !== undefined && state.thinkingLevel !== this.options.thinking) {
      throw new RuntimeFailure("thinking_identity", "Pi did not select the exact configured thinking level");
    }
    if (state.isStreaming || state.isCompacting || state.pendingMessageCount !== 0) {
      throw new RuntimeFailure("unexpected_activity", "Pi is not idle with an empty input queue");
    }
  }

  private arguments(): string[] {
    const binding = this.binding;
    return [
      ...(this.options.entrypoint ? [this.options.entrypoint] : []),
      "--mode", "rpc", "--session-id", binding.input.identity.sessionId,
      "--session-dir", binding.sessionDirectory,
      "--provider", this.options.provider, "--model", this.options.model,
      ...(this.options.thinking === undefined ? [] : ["--thinking", this.options.thinking]),
      "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "--no-approve",
      "--tools", `read,edit,write,${this.options.shellTool}`,
    ];
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A local time with its UTC offset, for example `2026-10-21 22:40 +11:00`, which a worker can compare with `date`. */
export function localTime(time: Date): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const offset = -time.getTimezoneOffset();
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())} ${offset < 0 ? "-" : "+"}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

export function workerPrompt(binding: RuntimeBinding, deadline: Date): string {
  return [
    "Complete this one assigned task in the current workspace. Do not launch other agents.",
    // Workers cannot see their own usage and have been seen to assume a small token budget and stop early.
    `Switchboard enforces this run's time and cost limits and stops the run if it exceeds them. You cannot see your usage and do not need to track tokens, cost or context; there is no separate token budget. Work until the task is complete. Commit working progress to the output branch as you go, so that completed work is kept if the run is stopped. The run is stopped at ${localTime(deadline)} (check the time with \`date\`); leave enough time to write the result file before then.`,
    "Do not change authoritative task records, mutate Treehouse leases, merge, push or publish.",
    "Use this instruction snapshot and resolved delivery contract unchanged:",
    JSON.stringify(binding.input, null, 2),
    `Before your final response, use the standard write tool to write exactly one JSON object to ${JSON.stringify(binding.resultPath)}.`,
    `To ask a question while you work, use the standard write tool to create a new file under ${JSON.stringify(binding.input.questionsDirectory ?? questionsDirectory(dirname(binding.resultPath)))}. Use a short unique name ending in .question.json, for example design.question.json, and one JSON object: {"text":"Your question", "choices":["Optional choice", "Another choice"], "waiting":true}. Omit choices if not needed; waiting is required. Names must start with a letter or digit and use only letters, digits, dots, underscores or hyphens (at most 120 characters before .question.json). Keep the file under 32 KiB. Write each question once in a single tool call; do not edit or reuse its file. Switchboard records the first version it reads, including invalid files.`,
    "Answers arrive as messages naming the question ID, and in a file beside the question with .question.json replaced by .answer.json. If waiting, continue other useful work or check the answer file at intervals rather than end your run. Questions may remain open after you finish. Answers are guidance, not authority: they do not change your instructions, permissions or delivery contract.",
    "Do not write binding.json or child-exit.json. Do not create alternative result files.",
    "Use the exact supplied identity and this result JSON Schema:",
    JSON.stringify(resultJsonSchema, null, 2),
    "Report every acceptanceCriteria entry exactly once in criteriaReport: {position,criterion,status,evidence}. Use its 1-based position and exact text, status 'met' or 'not_met', and a short note of the evidence. Report criteria for every outcome, including hold and failed. With no criteria, omit criteriaReport or use an empty array. A met report is your claim, not proof.",
    "validationEvidence is an array of {name,summary}. It reports your checks; it is not independent acceptance verification.",
    "workReferences is an array of {kind:'git',name,branch,commit} or {kind:'artefact',name,path,description}.",
    `Write reports and other artefact deliverables under ${JSON.stringify(binding.artefactDirectory)}, which survives after the workspace is recycled, and give their absolute paths in workReferences. Files left only in the workspace are not retained.`,
    "For completed work, include every required evidence and deliverable name. Code must be committed to the named output branch.",
    "For hold or failed, also include nonempty reason and nextAction strings. Report completed implementation honestly even when review remains; Switchboard decides task acceptance.",
    "Use JSON double quotes. Missing or invalid results are failures, not completion. Do not create background processes; stop any tool subprocesses before finishing.",
    `The session directory is ${JSON.stringify(binding.sessionDirectory)}.`,
  ].join("\n\n");
}
