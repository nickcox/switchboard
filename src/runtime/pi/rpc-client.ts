import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { bounded, deferred, RuntimeFailure } from "../async.ts";
import type { ChildExit } from "../records.ts";
import { JsonlDecoder, type RpcRecord } from "./jsonl.ts";

export type RunSettled = { aborted: boolean; lastAssistantStop: string | undefined; lastAssistantError: string | undefined };
type Pending = { command: string; resolve: (value: unknown) => void; reject: (reason: unknown) => void };

/** Narrow Pi RPC transport. It observes the direct child only, not its descendants. */
export class PiRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly decoder: JsonlDecoder;
  private readonly spawned = deferred<void>();
  private readonly exit = deferred<ChildExit>();
  private readonly streamsClosed = deferred<void>();
  private readonly settled = deferred<RunSettled>();
  private readonly pending = new Map<string, Pending>();
  private sequence = 0;
  private armed = false;
  private agentStarted = false;
  private lastAssistantStop: string | undefined;
  private lastAssistantError: string | undefined;
  private observedExit: ChildExit | undefined;
  private transportFailure: Error | undefined;
  private stderr = "";
  readonly started: Promise<void>;
  readonly exited: Promise<ChildExit>;
  readonly closed: Promise<void>;

  private readonly onEvent: ((record: RpcRecord) => void) | undefined;

  constructor(options: {
    executable: string; args: string[]; cwd: string; env: Record<string, string>; maxRecordBytes?: number;
    /** Observes every event record (not responses). Errors it throws are ignored. */
    onEvent?: (record: RpcRecord) => void;
  }) {
    this.decoder = new JsonlDecoder(options.maxRecordBytes);
    this.onEvent = options.onEvent;
    this.child = spawn(options.executable, options.args, {
      cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.started = this.spawned.promise;
    this.exited = this.exit.promise;
    this.closed = this.streamsClosed.promise;
    this.child.once("close", () => this.streamsClosed.resolve());
    this.child.once("spawn", () => this.spawned.resolve());
    this.child.on("error", error => {
      this.fail(error);
      this.spawned.reject(error);
      if (this.child.pid === undefined) this.observeExit({ started: false, code: null, signal: null });
    });
    this.child.once("exit", (code, signal) => this.observeExit({ started: true, code, signal }));
    this.child.stdout.on("data", (bytes: Buffer) => {
      try { for (const record of this.decoder.push(bytes)) this.receive(record); }
      catch (error) { this.fail(asError(error)); }
    });
    this.child.stdout.on("end", () => {
      try { this.decoder.finish(); }
      catch (error) { this.fail(asError(error)); }
    });
    this.child.stdout.on("error", error => this.fail(error));
    this.child.stderr.on("data", (bytes: Buffer) => { this.stderr = (this.stderr + bytes.toString()).slice(-16384); });
    this.child.stderr.on("error", error => this.fail(error));
    this.child.stdin.on("error", error => this.fail(error));
  }

  get childExit(): ChildExit | undefined { return this.observedExit; }
  get failure(): Error | undefined { return this.transportFailure; }
  get stderrTail(): string { return this.stderr; }

  /** Arm before sending the one prompt, so a fast run cannot finish before observation starts. */
  beginRun(): Promise<RunSettled> {
    if (this.armed) throw new Error("This worker already received its one prompt");
    this.armed = true;
    return this.settled.promise;
  }

  async request(type: string, fields: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.transportFailure) throw this.transportFailure;
    if (this.observedExit) throw new RuntimeFailure("rpc_exited", "Pi child has exited");
    const id = `switchboard-${++this.sequence}`;
    const result = deferred<unknown>();
    this.pending.set(id, { command: type, resolve: result.resolve, reject: result.reject });
    try {
      this.child.stdin.write(`${JSON.stringify({ ...fields, id, type })}\n`, error => {
        if (error) this.pending.get(id)?.reject(error);
      });
      return await bounded(result.promise, timeoutMs, "rpc_timeout");
    } finally { this.pending.delete(id); }
  }

  endInput(): void { this.child.stdin.end(); }

  /** Platform-specific process control stays here. A kill request is not an exit observation. */
  terminateChild(force: boolean): void {
    if (!this.observedExit) this.child.kill(force ? "SIGKILL" : "SIGTERM");
  }

  private observeExit(exit: ChildExit): void {
    if (this.observedExit) return;
    this.observedExit = exit;
    this.exit.resolve(exit);
    const error = new RuntimeFailure("rpc_exited", "Pi child exited before the pending operation completed");
    for (const pending of this.pending.values()) pending.reject(error);
    this.settled.reject(error);
  }

  private fail(error: Error): void {
    this.transportFailure ??= error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.settled.reject(error);
  }

  private receive(record: RpcRecord): void {
    if (record.type === "response") {
      if (typeof record.id !== "string") return; // Uncorrelated parse diagnostics cannot acknowledge a request.
      const pending = this.pending.get(record.id);
      if (!pending) return; // A late acknowledgement never causes a retry or a replacement launch.
      if (record.command !== pending.command || typeof record.success !== "boolean") {
        throw new RuntimeFailure("rpc_protocol", "Mismatched RPC response");
      }
      this.pending.delete(record.id);
      if (record.success) pending.resolve(record.data);
      else pending.reject(new RuntimeFailure("rpc_rejected", typeof record.error === "string" ? record.error : "Pi rejected RPC command"));
      return;
    }
    try { this.onEvent?.(record); } catch { /* Observation must never affect the protocol. */ }
    if (!this.armed) return;
    if (record.type === "agent_start") this.agentStarted = true;
    if (record.type === "message_end" && isObject(record.message) && record.message.role === "assistant") {
      if (typeof record.message.stopReason !== "string") throw new Error("Missing assistant stop reason");
      this.lastAssistantStop = record.message.stopReason;
      this.lastAssistantError = typeof record.message.errorMessage === "string" ? record.message.errorMessage : undefined;
    }
    if (record.type === "agent_settled" && this.agentStarted) {
      if (typeof record.aborted !== "boolean") throw new Error("Missing settled abort flag");
      this.settled.resolve({ aborted: record.aborted, lastAssistantStop: this.lastAssistantStop, lastAssistantError: this.lastAssistantError });
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
