import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AttemptStoreError } from "../attempts/store.ts";
import { requestFingerprint, type RequestInputs } from "../attempts/requests.ts";
import { databasePath, type Config } from "../config.ts";
import type { Database } from "../database.ts";
import type { Dependencies } from "../dispatch/dependencies.ts";
import { dispatchOnce } from "../dispatch/dispatch.ts";
import { result, type DispatchResult } from "../dispatch/result.ts";
import { requireOperationAuthority } from "../dispatch/safety.ts";

function withOutput(value: DispatchResult, outputPath: string): DispatchResult {
  return { ...value, observed: { ...value.observed, outputPath } };
}

export function dispatchRequest(database: Database, context: string, requestId: string) {
  const row = database.get("SELECT * FROM supervisor_dispatches WHERE context = ? AND request_id = ?", context, requestId);
  if (!row) throw new Error("The recorded supervisor dispatch request is missing");
  return row;
}

export function dispatchStartFailed(requestId: string, outputPath: string, detail: string): DispatchResult {
  return result({ ok: false, reason: "dispatch_start_failed", stage: "preflight", lease: "none",
    observed: { requestId, outputPath }, detail: `${detail}. Output: ${outputPath}`, nextAction: "inspect_attempt" });
}

export async function recordDispatchResult(database: Database, context: string, requestId: string, value: DispatchResult): Promise<void> {
  await database.transaction(() => database.run("UPDATE supervisor_dispatches SET result = ? WHERE context = ? AND request_id = ? AND result IS NULL",
    JSON.stringify(value), context, requestId));
}

/** Record launch intent before spawning. Replays may observe that launch, but never repeat it. */
export async function detachedDispatch(deps: Dependencies, config: Config, configPath: string, inputs: RequestInputs & { taskId: string }, suppliedId?: string): Promise<DispatchResult> {
  requireOperationAuthority(deps, ["dispatch", ...(inputs.startingPoint ? ["continueAttempts" as const] : [])], inputs);
  const requestId = suppliedId ?? randomUUID();
  if (!requestId.trim()) throw new Error("Request ID must not be blank");
  const database = deps.attempts.database;
  const context = deps.contextId;
  const fingerprint = requestFingerprint(inputs);
  const outputPath = join("supervisor-dispatches", createHash("sha256").update(JSON.stringify([context, requestId])).digest("hex"), "output.log");
  let created: boolean;
  try {
    created = await database.transaction(() => {
      const previous = database.get("SELECT caller, fingerprint FROM supervisor_dispatches WHERE context = ? AND request_id = ?", context, requestId);
      if (previous) {
        if (previous.caller !== JSON.stringify(deps.caller) || previous.fingerprint !== fingerprint) {
          throw new AttemptStoreError("request_input_mismatch", "The request ID has already been used with different explicit inputs or a different caller");
        }
        return false;
      }
      // An ordinary dispatch may already own the ID. Its durable reservation still takes precedence.
      database.run("INSERT INTO supervisor_dispatches(context, request_id, caller, inputs, fingerprint, config_path, runtime_root, output_path, recorded_at) VALUES(?,?,?,?,?,?,?,?,?)",
        context, requestId, JSON.stringify(deps.caller), JSON.stringify(inputs), fingerprint, configPath, config.runtimeRoot, outputPath, new Date().toISOString());
      return true;
    });
    const existing = await deps.attempts.findByRequest(requestId, inputs);
    if (existing) return withOutput(await dispatchOnce(deps, { ...inputs, requestId }), String(dispatchRequest(database, context, requestId).output_path));
  } catch (error) {
    if (!(error instanceof AttemptStoreError)) throw error;
    return result({ ok: false, reason: error.reason === "request_input_mismatch" ? "request_input_mismatch" : "refused", stage: "preflight",
      lease: "none", observed: { requestId }, detail: error.message, nextAction: "inspect_attempt" });
  }

  let child: ChildProcess | undefined;
  let ended: string | undefined;
  const row = dispatchRequest(database, context, requestId);
  const recordedOutput = String(row.output_path);
  if (created) {
    try {
      const path = join(config.runtimeRoot, recordedOutput);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const output = await open(path, "a", 0o600);
      try {
        child = spawn(process.execPath, [join(import.meta.dirname, "dispatch-process.ts"), databasePath(config), context, requestId], {
          detached: true, stdio: ["ignore", output.fd, output.fd], windowsHide: true,
        });
        child.once("exit", (code, signal) => { ended = `Dispatcher exited (${signal ?? code}) before reserving an attempt`; });
        await new Promise<void>((resolve, reject) => { child!.once("spawn", resolve); child!.once("error", reject); });
        child.unref();
      } finally { await output.close(); }
    } catch (error) {
      ended = `Could not start dispatcher: ${error instanceof Error ? error.message : String(error)}`;
      await recordDispatchResult(database, context, requestId, dispatchStartFailed(requestId, recordedOutput, ended));
    }
  }

  for (;;) {
    // The attempt store owns reservation. Do not copy its identity or state into the launch record.
    const reservation = database.get("SELECT task, attempt FROM request_records WHERE context = ? AND request_id = ?", context, requestId);
    if (reservation?.attempt != null) {
      if (!created) return withOutput(await dispatchOnce(deps, { ...inputs, requestId }), recordedOutput);
      return result({ ok: true, reason: "dispatch_started", stage: "select", lease: "unknown",
        attempt: { contextId: context, taskId: String(reservation.task), attempt: Number(reservation.attempt), requestId },
        observed: { outputPath: recordedOutput }, nextAction: "watch_attempt" });
    }
    const current = dispatchRequest(database, context, requestId);
    if (current.result !== null) return JSON.parse(String(current.result));
    if (ended === undefined && !created && current.process_pid !== null) {
      try { process.kill(Number(current.process_pid), 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") ended = "The recorded dispatcher process ended before reserving an attempt";
      }
    }
    if (ended !== undefined) {
      const failed = dispatchStartFailed(requestId, recordedOutput, ended);
      await recordDispatchResult(database, context, requestId, failed);
      return failed;
    }
    if (!created && current.process_pid === null && Date.now() - Date.parse(String(current.recorded_at)) > 10000) {
      return result({ ok: false, reason: "reconciliation_required", stage: "preflight", lease: "unknown", observed: { requestId, outputPath: recordedOutput },
        detail: `The launch was recorded but process start is unconfirmed. No second process was started. Inspect ${recordedOutput}`, nextAction: "inspect_attempt" });
    }
    await sleep(25);
  }
}
