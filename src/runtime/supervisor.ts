import { bounded, RuntimeFailure } from "./async.ts";
import type { WorkerInput, WorkerResult } from "./contracts.ts";
import { recordValidatedResult } from "./validated-result.ts";
import { ActivityWriter, shorten, type ActivityEntry, type Payload } from "./activity.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { startKeepAwake, type KeepAwake } from "./keep-awake.ts";
import { claimRequest, recordResult, unclaimedRequests, type ControlRequest, type RequestResult } from "./requests.ts";
import { RuntimeRecords, type ChildExit, type RuntimeBinding, type RuntimeRecord, type ThinkingLevel } from "./records.ts";

/**
 * Supervision shared by every runtime (Phase 3 PRD, second runtime): the runtime directory and dispatcher heartbeat,
 * stop requests and operator messages, usage limits, activity recording, shutdown and the final observations. A
 * runtime adapter starts its process, speaks its protocol and carries out the control operations it supports; what
 * stopping means is the adapter's, not the supervisor's.
 */
export type SupervisorOptions = {
  keepAwake?: KeepAwake;
  requestMs: number;
  runMs: number;
  /** How often to record a usage snapshot while the worker runs. One is also taken after each turn. */
  statsMs: number;
  /** Stop the worker once a usage snapshot exceeds either limit. Subscription providers may report a cost of zero. */
  maxCost?: number | undefined;
  maxTokens?: number | undefined;
  /** How often the owning dispatcher checks for stop requests and operator messages while the worker runs. */
  requestPollMs: number;
};

export type WorkerHooks = {
  onActivity?: (entry: ActivityEntry) => void;
  /** Called once for each stop request or operator message this worker forwarded, with what happened. */
  onRequest?: (request: ControlRequest, result: Omit<RequestResult, "version" | "at">) => void;
};

export type RunReport = {
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

/** What a session reports to its supervisor while it runs. */
export type SessionEvents = {
  activity(entry: Payload): void;
  /** The worker finished a turn, so a usage snapshot is worth taking. */
  turnEnded(): void;
  /** The worker's session is open; recorded before the session is checked against the binding. */
  sessionStarted(thinkingLevel: ThinkingLevel): Promise<void>;
};

/** One running worker, as its runtime adapter exposes it. */
export interface RuntimeSession {
  /** Resolves once the direct child's exit is observed. */
  readonly exited: Promise<ChildExit>;
  readonly childExit: ChildExit | undefined;
  /** A failure of the channel to the worker, observed after it closed. */
  readonly failure: Error | undefined;
  readonly stderrTail: string;
  /** Starts the worker on its task. Throws a RuntimeFailure if it cannot be started as bound. */
  start(signal: AbortSignal): Promise<void>;
  /** Resolves when the worker's run ends, without judging how it ended. */
  waitForEnd(runMs: number, signal: AbortSignal): Promise<void>;
  /** Throws a RuntimeFailure unless the run ended successfully and the worker is idle as bound. */
  confirmEnd(signal: AbortSignal): Promise<void>;
  usage(): Promise<{ tokens: number; cost: number }>;
  /** Passes an operator message to the running worker and returns the runtime's disposition for it. */
  deliver(kind: "steer" | "follow_up", message: string): Promise<string>;
  /** Asks the worker to stop if `abort` is set, then ends it and waits, within the runtime's own limits, for its exit. */
  shutdown(abort: boolean): Promise<void>;
  /** Resolves once the worker's output streams have closed. */
  closed(): Promise<void>;
}

export type RuntimeAdapter = {
  /** Starts the worker's process. Throws if no process could be started. */
  open(binding: RuntimeBinding, events: SessionEvents): RuntimeSession;
};

export class WorkerSupervisor {
  private readonly records: RuntimeRecords;
  private readonly adapter: RuntimeAdapter;
  private readonly options: SupervisorOptions;
  constructor(records: RuntimeRecords, adapter: RuntimeAdapter, options: SupervisorOptions) {
    this.records = records;
    this.adapter = adapter;
    this.options = options;
  }

  async execute(input: WorkerInput, operator?: AbortSignal, hooks: WorkerHooks = {}): Promise<RunReport> {
    if (operator?.aborted) throw new RuntimeFailure("interrupted", "Interrupted before launch");
    // The launch permission and fresh claim are committed together, before the worker can start.
    let stopHeartbeat: (() => Promise<void>) | undefined;
    try {
      const reserved = await this.records.reserve(input, async record => { stopHeartbeat = await startHeartbeat(record); });
      return await this.supervise(reserved, operator, hooks);
    } finally { await stopHeartbeat?.(); }
  }

  private async supervise(reserved: RuntimeRecord, operator: AbortSignal | undefined, hooks: WorkerHooks): Promise<RunReport> {
    const activity = new ActivityWriter(reserved, hooks.onActivity);
    const stopKeepAwake = await startKeepAwake(this.options.keepAwake ?? true, text => activity.write({ kind: "note", text }));
    try { return await this.runSession(reserved, operator, hooks, activity); }
    finally {
      await stopKeepAwake();
      await activity.close();
    }
  }

  private async runSession(reserved: RuntimeRecord, operator: AbortSignal | undefined, hooks: WorkerHooks, activity: ActivityWriter): Promise<RunReport> {
    const { binding, directory } = reserved;
    // Exceeding a usage limit, or a stop request, stops the worker the same way an operator interruption does.
    const budget = new AbortController();
    const stopRequest = new AbortController();
    let stoppedBy: string | undefined;
    const signal = AbortSignal.any([budget.signal, stopRequest.signal, ...(operator ? [operator] : [])]);
    let requestTimer: ReturnType<typeof setInterval> | undefined;
    let forwarding: Promise<void> | undefined;
    // Set when the worker starts finishing: no request is claimed after that, so none is forwarded to a worker that is
    // shutting down.
    let closing = false;
    // Only this process holds the worker's channel, so it alone forwards requests, each at most once.
    const forwardRequests = (current: RuntimeSession) => {
      if (forwarding || closing || current.childExit) return;
      forwarding = forwardClaimed(current).finally(() => { forwarding = undefined; });
    };
    const forwardClaimed = async (current: RuntimeSession) => {
      for (const request of await unclaimedRequests(reserved).catch(() => [])) {
        if (closing || current.childExit) break;
        if (!(await claimRequest(reserved, request.id, "dispatcher").catch(() => false))) continue;
        let result: Omit<RequestResult, "version" | "at">;
        if (request.kind === "stop") {
          stoppedBy ??= request.sender;
          result = { outcome: "stopping" };
          activity.write({ kind: "note", text: `Stop requested by ${request.sender}` });
          stopRequest.abort();
        } else {
          try { result = { outcome: await current.deliver(request.kind, request.message ?? "") }; }
          catch (error) { result = { outcome: "failed", error: asError(error).message }; }
          activity.write({ kind: "note", text: `${request.kind === "steer" ? "Steering message" : "Follow-up"} from ${request.sender} (${result.outcome}): ${shorten(request.message ?? "")}` });
        }
        // A claimed request always ends with a result, so its sender never waits on it forever. Failing to record
        // one must not affect the worker, but it is reported rather than dropped.
        await recordResult(reserved, request.id, result).catch(error => {
          activity.write({ kind: "note", text: `The result of request ${request.id} could not be recorded: ${asError(error).message}` });
        });
        try { hooks.onRequest?.(request, result); }
        catch (error) { activity.write({ kind: "note", text: `Request ${request.id} could not be passed to the dispatcher: ${asError(error).message}` }); }
      }
    };
    let lastSnapshot = 0;
    let statsTimer: ReturnType<typeof setInterval> | undefined;
    const snapshot = async (current: RuntimeSession) => {
      if (current.childExit || budget.signal.aborted) return;
      lastSnapshot = Date.now();
      try {
        const usage = await current.usage();
        activity.write({ kind: "stats", tokens: usage.tokens, cost: usage.cost });
        const over = (this.options.maxCost !== undefined && usage.cost > this.options.maxCost) ||
          (this.options.maxTokens !== undefined && usage.tokens > this.options.maxTokens);
        if (over && !budget.signal.aborted) {
          activity.write({ kind: "note", text: `Usage limit exceeded (${usage.tokens} tokens, $${usage.cost.toFixed(2)}); stopping the worker` });
          budget.abort();
        }
      } catch { /* Usage snapshots are diagnostic; a failed one is skipped. */ }
    };
    let session: RuntimeSession | undefined;
    let failure: Error | undefined;
    let result: WorkerResult | undefined;
    let receipt: Promise<void> | undefined;
    try {
      if (signal.aborted) throw new RuntimeFailure("interrupted", "Interrupted before spawn");
      session = this.adapter.open(binding, {
        activity: entry => activity.write(entry),
        turnEnded: () => { if (session && Date.now() - lastSnapshot > 30_000) void snapshot(session); },
        sessionStarted: thinkingLevel => this.records.recordSessionStart(reserved, thinkingLevel),
      });
      receipt = session.exited.then(exit => this.records.recordChildExit(reserved, exit));
      void receipt.catch(() => {});
      await session.start(signal);
      activity.write({ kind: "note", text: `Worker started (session ${binding.input.identity.sessionId})` });
      const running = session;
      statsTimer = setInterval(() => void snapshot(running), this.options.statsMs);
      requestTimer = setInterval(() => void forwardRequests(running), this.options.requestPollMs);
      await session.waitForEnd(this.options.runMs, signal);
      await snapshot(session);
      await session.confirmEnd(signal);
    } catch (error) { failure = asError(error); }
    if (statsTimer) clearInterval(statsTimer);
    // Finish any forwarding already under way before shutting the worker down, so every claimed request is forwarded
    // or answered and recorded before this attempt is finalised.
    closing = true;
    if (requestTimer) clearInterval(requestTimer);
    await forwarding;

    if (session) {
      await session.shutdown(failure !== undefined);
      if (session.childExit) {
        try {
          await session.closed();
          await bounded(receipt!, this.options.requestMs, "exit_receipt_timeout");
          if (session.failure) throw session.failure;
        } catch (error) { failure ??= asError(error); }
      }
      if (!failure && session.childExit?.started && session.childExit.code === 0 && session.childExit.signal === null) {
        try { result = (await recordValidatedResult(reserved)).content; }
        catch (error) { failure = new RuntimeFailure("invalid_result", asError(error).message); }
      } else if (!failure && session.childExit) {
        failure = new RuntimeFailure("worker_exit", "The worker did not exit successfully");
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
    const childExit = session?.childExit;
    const stopped = failure instanceof RuntimeFailure && (failure.reason === "interrupted" || failure.reason === "over_budget");
    const status = !childExit && session ? "unresolved" : stopped ? "interrupted" : failure ? "failed" : "reported";
    activity.write({ kind: "note", text: `Worker finished: ${status}${failure ? ` (${failure instanceof RuntimeFailure ? failure.reason : "runtime_failure"})` : ""}` });
    return {
      binding, directory, workerTermination: "unverified", childExit,
      status,
      reason: !childExit && session ? "termination_unknown" : failure instanceof RuntimeFailure ? failure.reason : failure ? "runtime_failure" : undefined,
      detail: failure?.message, stderrTail: session?.stderrTail ?? "", result,
    };
  }
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
