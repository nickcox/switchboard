#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createDependencies, loadConfig } from "./config.ts";
import { dispatchOnce } from "./dispatch/dispatch.ts";
import { describe } from "./dispatch/result.ts";
import { requestControl } from "./dispatch/control.ts";
import { resolveLeaseReturned, resolveStopped } from "./dispatch/resolve.ts";
import { describeStatus, status } from "./dispatch/status.ts";
import { watch } from "./dispatch/watch.ts";
import { describeEntry } from "./runtime/activity.ts";

const usage = `Usage:
  switchboard --version
  switchboard dispatch --once [--dry-run] [--task <id>] [--request-id <id>] [--json] [--config <path>]
  switchboard status [--json] [--config <path>]
  switchboard resolve --lease <lease-id> [--worker-stopped | --lease-returned] [--note <text>] [--json] [--config <path>]
  switchboard resolve --task <task-id> [--attempt <n>] --lease-returned [--note <text>] [--json] [--config <path>]
  switchboard watch --lease <lease-id> [--no-follow] [--json] [--config <path>]
  switchboard stop --lease <lease-id> [--as <sender>] [--wait <seconds>] [--json] [--config <path>]
  switchboard steer --lease <lease-id> [--after] [--as <sender>] [--wait <seconds>] [--json] [--config <path>] "<message>"

dispatch --once --dry-run reports the selected task and delivery contract without changing anything or launching a worker.

watch prints an attempt's worker activity and follows it until the worker's exit is recorded. It reads files
only, so it works from any terminal and after the dispatcher has stopped. status shows each attempt's lease ID.

stop and steer ask the dispatcher that owns a running worker to stop it, or to pass it a message (with --after,
once it finishes its current work). A request no dispatcher takes within --wait seconds (default 10) is withdrawn
and never forwarded. --as names the sender recorded with the request; the default is operator:<your user name>.

resolve records the operator's confirmation that a worker with no observed exit has stopped. Without
--worker-stopped it only reports what each owner holds. --lease-returned records the operator's confirmation that a
lease in a workspace pool Switchboard no longer lists, for example after the origin remote changed, was returned.
Use exactly one of --lease and --task. --task is only for --lease-returned; --attempt selects a task's attempt
(default: latest). resolve never changes the task or the lease.

The configuration file defaults to $SWITCHBOARD_CONFIG, then ./switchboard.json.
Exit status: 0 when no work was ready, a dry run selected a task or the task was recorded as done (dispatch), nothing needs attention (status),
the confirmation was recorded (resolve), Pi accepted the request (stop, steer) or the attempt was found (watch);
1 for any other outcome, described by the report's reason; 2 for usage or configuration errors.`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      once: { type: "boolean" }, "dry-run": { type: "boolean" }, task: { type: "string" }, "request-id": { type: "string" },
      json: { type: "boolean" }, config: { type: "string" }, help: { type: "boolean" }, version: { type: "boolean" },
      lease: { type: "string" }, "worker-stopped": { type: "boolean" }, "lease-returned": { type: "boolean" }, note: { type: "string" }, "no-follow": { type: "boolean" },
      after: { type: "boolean" }, as: { type: "string" }, wait: { type: "string" }, attempt: { type: "string" },
    },
  });
  if (values.version) {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    return 0;
  }
  const command = positionals[0];
  const commands = ["dispatch", "status", "resolve", "watch", "stop", "steer"];
  if (values.help || !command || !commands.includes(command) || positionals.length !== (command === "steer" ? 2 : 1)) {
    console.error(usage);
    return values.help ? 0 : 2;
  }
  if (command === "dispatch" && !values.once) {
    console.error("dispatch requires --once: Phase 1 dispatches exactly one task per invocation.\n\n" + usage);
    return 2;
  }
  const wait = Number(values.wait ?? "10");
  if (!Number.isFinite(wait) || wait <= 0) {
    console.error("--wait must be a positive number of seconds.");
    return 2;
  }
  if (values["worker-stopped"] && values["lease-returned"]) {
    console.error("resolve takes either --worker-stopped or --lease-returned, not both.");
    return 2;
  }
  const attempt = values.attempt === undefined ? undefined : Number(values.attempt);
  if (command === "resolve" && (
    (values.lease !== undefined) === (values.task !== undefined)
    || values.lease === "" || values.task === ""
    || (values.task !== undefined && !values["lease-returned"])
    || (values.attempt !== undefined && (!values.task || !Number.isSafeInteger(attempt) || attempt! <= 0))
  )) {
    console.error("resolve requires exactly one of --lease or --task; --task requires --lease-returned, and --attempt must be a positive integer with --task.\n\n" + usage);
    return 2;
  }
  if (values.attempt !== undefined && command !== "resolve") {
    console.error("--attempt is only supported by resolve --task --lease-returned.");
    return 2;
  }
  if (["watch", "stop", "steer"].includes(command) && !values.lease) {
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

  if (command === "stop" || command === "steer") {
    const value = await requestControl(deps, {
      leaseId: values.lease!, kind: command === "stop" ? "stop" : values.after ? "follow_up" : "steer",
      ...(command === "steer" ? { message: positionals[1]! } : {}),
      sender: values.as ?? `operator:${process.env.USER ?? process.env.USERNAME ?? "unknown"}`, waitMs: wait * 1000,
    });
    console.log(values.json ? JSON.stringify(value, null, 2) : describe(value));
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
    const note = values.note ? { note: values.note } : {};
    const value = values["lease-returned"]
      ? await resolveLeaseReturned(deps, { ...(values.task ? { taskId: values.task, ...(attempt !== undefined ? { attempt } : {}) } : { leaseId: values.lease! }), ...note })
      : await resolveStopped(deps, { leaseId: values.lease!, confirmed: values["worker-stopped"] === true, ...note });
    console.log(values.json ? JSON.stringify(value, null, 2) : describe(value));
    return value.ok ? 0 : 1;
  }

  if (process.platform !== "darwin") console.error(`Warning: Switchboard has only been verified on macOS, not on ${process.platform}.`);
  // The first interrupt asks the worker to stop; the attempt is then held with an interruption reason.
  const controller = new AbortController();
  process.once("SIGINT", () => {
    console.error("Interrupt received: stopping the worker. The lease will be preserved.");
    controller.abort();
  });
  const value = await dispatchOnce(deps, {
    ...(values.task ? { taskId: values.task } : {}), ...(values["request-id"] ? { requestId: values["request-id"] } : {}), signal: controller.signal,
    dryRun: values["dry-run"] === true,
  });
  console.log(values.json ? JSON.stringify(value, null, 2) : describe(value));
  return value.ok ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  return 2;
});
