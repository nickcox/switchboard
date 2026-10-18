#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createDependencies, loadConfig } from "./config.ts";
import { dispatchOnce } from "./dispatch/dispatch.ts";
import { describe } from "./dispatch/result.ts";
import { resolveStopped } from "./dispatch/resolve.ts";
import { describeStatus, status } from "./dispatch/status.ts";
import { watch } from "./dispatch/watch.ts";
import { describeEntry } from "./runtime/activity.ts";

const usage = `Usage:
  switchboard dispatch --once [--task <id>] [--request-id <id>] [--json] [--config <path>]
  switchboard status [--json] [--config <path>]
  switchboard resolve --lease <lease-id> [--worker-stopped] [--note <text>] [--json] [--config <path>]
  switchboard watch --lease <lease-id> [--no-follow] [--json] [--config <path>]

watch prints an attempt's worker activity and follows it until the worker's exit is recorded. It reads files
only, so it works from any terminal and after the dispatcher has stopped. status shows each attempt's lease ID.

resolve records the operator's confirmation that a worker with no observed exit has stopped. Without
--worker-stopped it only reports what each owner holds. It never changes the task or the lease.

The configuration file defaults to $SWITCHBOARD_CONFIG, then ./switchboard.json.
Exit status: 0 when no work was ready or the task was recorded as done (dispatch), nothing needs attention (status),
or the confirmation was recorded (resolve);
1 for any other outcome, described by the report's reason; 2 for usage or configuration errors.`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      once: { type: "boolean" }, task: { type: "string" }, "request-id": { type: "string" },
      json: { type: "boolean" }, config: { type: "string" }, help: { type: "boolean" },
      lease: { type: "string" }, "worker-stopped": { type: "boolean" }, note: { type: "string" }, "no-follow": { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.help || !command || positionals.length > 1 || !["dispatch", "status", "resolve", "watch"].includes(command)) {
    console.error(usage);
    return values.help ? 0 : 2;
  }
  if (command === "dispatch" && !values.once) {
    console.error("dispatch requires --once: Phase 1 dispatches exactly one task per invocation.\n\n" + usage);
    return 2;
  }
  if ((command === "resolve" || command === "watch") && !values.lease) {
    console.error(`${command} requires --lease <lease-id>; \`switchboard status\` shows each attempt's lease ID.\n\n${usage}`);
    return 2;
  }
  const configPath = resolve(values.config ?? process.env.SWITCHBOARD_CONFIG ?? "switchboard.json");
  let deps;
  try {
    deps = await createDependencies(await loadConfig(configPath), message => { if (!values.json) console.error(message); });
  } catch (error) {
    console.error(`Configuration error (${configPath}): ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  if (command === "status") {
    const value = await status(deps);
    console.log(values.json ? JSON.stringify(value, null, 2) : describeStatus(value));
    return value.ok ? 0 : 1;
  }

  if (command === "watch") {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    const outcome = await watch(deps, {
      leaseId: values.lease!, follow: values["no-follow"] !== true, signal: controller.signal,
      print: entry => console.log(values.json ? JSON.stringify(entry) : describeEntry(entry)),
    });
    if (!outcome.found) console.error(`No runtime record for lease ${values.lease} in this context. The worker may not have been launched.`);
    return outcome.found ? 0 : 1;
  }

  if (command === "resolve") {
    const value = await resolveStopped(deps, {
      leaseId: values.lease!, confirmed: values["worker-stopped"] === true, ...(values.note ? { note: values.note } : {}),
    });
    console.log(values.json ? JSON.stringify(value, null, 2) : describe(value));
    return value.ok ? 0 : 1;
  }

  // The first interrupt asks the worker to stop; the attempt is then held with an interruption reason.
  const controller = new AbortController();
  process.once("SIGINT", () => {
    console.error("Interrupt received: stopping the worker. The lease will be preserved.");
    controller.abort();
  });
  const value = await dispatchOnce(deps, {
    ...(values.task ? { taskId: values.task } : {}), ...(values["request-id"] ? { requestId: values["request-id"] } : {}), signal: controller.signal,
  });
  console.log(values.json ? JSON.stringify(value, null, 2) : describe(value));
  return value.ok ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  return 2;
});
