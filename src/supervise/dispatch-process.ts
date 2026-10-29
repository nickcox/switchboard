import { withKeepAwake } from "../runtime/keep-awake.ts";
import { resolve } from "node:path";
import type { RequestInputs } from "../attempts/requests.ts";
import { callerSchema } from "../caller.ts";
import { createDependencies, databasePath, loadConfig } from "../config.ts";
import { Database } from "../database.ts";
import { dispatchOnce } from "../dispatch/dispatch.ts";
import { dispatchRequest, dispatchStartFailed, recordDispatchResult } from "./dispatch.ts";

/** Internal entry point. Arguments locate a recorded request; none supplies caller identity. */
async function main(): Promise<void> {
  const [path, context, requestId] = process.argv.slice(2);
  if (!path || !context || !requestId || process.argv.length !== 5) throw new Error("Expected database path, context and recorded request ID");
  const database = await Database.open(path);
  try {
    const claimed = await database.transaction(() => {
      const row = dispatchRequest(database, context, requestId);
      if (row.process_pid !== null || row.result !== null) return false;
      database.run("UPDATE supervisor_dispatches SET process_pid = ? WHERE context = ? AND request_id = ?", process.pid, context, requestId);
      return true;
    });
    if (!claimed) return;
    const row = dispatchRequest(database, context, requestId);
    try {
      const caller = callerSchema.parse(JSON.parse(String(row.caller)));
      if (caller.kind !== "supervisor") throw new Error("The recorded caller is not a supervisor");
      const inputs: RequestInputs = JSON.parse(String(row.inputs));
      const config = await loadConfig(String(row.config_path));
      if (resolve(databasePath(config)) !== resolve(path) || config.contextId !== context || config.runtimeRoot !== row.runtime_root) {
        throw new Error("The configuration no longer names the recorded database, context and runtime root");
      }
      await withKeepAwake(config.keepAwake, async () => {
        const deps = await createDependencies(config, caller, { dispatch: true, progress: message => console.log(message) });
        try {
          const controller = new AbortController();
          const interrupt = () => controller.abort();
          process.once("SIGINT", interrupt);
          process.once("SIGTERM", interrupt);
          try {
            const dispatched = await dispatchOnce(deps, { ...inputs, requestId, signal: controller.signal });
            const value = { ...dispatched, observed: { ...dispatched.observed, outputPath: String(row.output_path) } };
            await recordDispatchResult(database, context, requestId, value);
            console.log(JSON.stringify(value));
            process.exitCode = value.ok ? 0 : 1;
          } finally {
            process.removeListener("SIGINT", interrupt);
            process.removeListener("SIGTERM", interrupt);
          }
        } finally { deps.close(); }
      }, message => console.log(message));
    } catch (error) {
      console.error(error);
      await recordDispatchResult(database, context, requestId, dispatchStartFailed(requestId, String(row.output_path), error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    }
  } finally { database.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
