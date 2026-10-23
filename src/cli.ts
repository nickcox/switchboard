#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createDependencies, databasePath, loadConfig } from "./config.ts";
import { dispatchOnce } from "./dispatch/dispatch.ts";
import { describe } from "./dispatch/result.ts";
import { requestControl } from "./dispatch/control.ts";
import { resolveLeaseReturned, resolveStopped } from "./dispatch/resolve.ts";
import { discard, finish } from "./dispatch/finish.ts";
import { leaseOfTask } from "./dispatch/select.ts";
import { prune } from "./dispatch/prune.ts";
import { describeStatus, status } from "./dispatch/status.ts";
import { watch } from "./dispatch/watch.ts";
import { describeEntry } from "./runtime/activity.ts";
import { taskCommand } from "./tasks/cli.ts";
import { SqliteTaskStore } from "./tasks/sqlite.ts";
import { requireRetainedStorage } from "./infra/storage.ts";

const usage = `Usage:
  switchboard --version
  switchboard task <add|show|list|ready|update|hold|release|block|unblock|done|reopen> [id] [options] [--json]
  switchboard import (--attempts | --runtime | --tasks-axi <backlog.md> [--archive <done-archive.md>]) [--json] [--config <path>]
  switchboard dispatch --once [--dry-run] [--task <id>] [--request-id <id>] [--json] [--config <path>]
  switchboard status [--json] [--config <path>]
  switchboard prune --older-than <days> [--dry-run] [--json] [--config <path>]
  switchboard resolve --lease <lease-id> [--worker-stopped | --lease-returned] [--note <text>] [--json] [--config <path>]
  switchboard resolve --task <task-id> [--attempt <n>] --lease-returned [--note <text>] [--json] [--config <path>]
  switchboard finish <attempt> [--no-processes] [--accept-output] [--dry-run] [--json] [--config <path>]
  switchboard discard <attempt> --confirm --no-processes [--note <text>] [--dry-run] [--json] [--config <path>]
  switchboard watch <attempt> [--no-follow] [--json] [--config <path>]
  switchboard stop <attempt> [--as <sender>] [--wait <seconds>] [--json] [--config <path>]
  switchboard steer <attempt> [--after] [--as <sender>] [--wait <seconds>] [--json] [--config <path>] "<message>"

<attempt> is --lease <lease-id>, or --task <task-id> [--attempt <n>] for a task's attempt (default: its latest).

dispatch --once --dry-run reports the selected task and delivery contract without changing anything or launching a worker.
Worker artefact references may name readable files or directories within the assigned artefact directory, including
that directory itself. Directories need at least one readable regular file; every file is checked. Empty directories,
escaping or dangling links, link cycles, unreadable targets and paths inside any recyclable workspace are refused.

watch prints an attempt's worker activity and follows it until the worker's exit is recorded. It reads the database
and runtime files, so it works from any terminal and after the dispatcher has stopped. status shows each attempt's lease ID.

stop and steer ask the dispatcher that owns a running worker to stop it, or to pass it a message (with --after,
once it finishes its current work). A request no dispatcher takes within --wait seconds (default 10) is withdrawn
and never forwarded. --as names the sender recorded with the request; the default is operator:<your user name>.

resolve records the operator's confirmation that a worker with no observed exit has stopped. Without
--worker-stopped it only reports what each owner holds. --lease-returned records the operator's confirmation that a
lease in a workspace pool Switchboard no longer lists, for example after the origin remote changed, was returned.
Use exactly one of --lease and --task. --task is only for --lease-returned; --attempt selects a task's attempt
(default: latest). resolve never changes the task or the lease.

finish --accept-output accepts committed output from a held attempt as your decision, without a worker result.
The output branch must advance the starting commit and the workspace must be clean.
finish completes an attempt awaiting review or awaiting finish under the context's finalisation policy (manual,
or local-merge, which first fast-forwards the target branch to the exact accepted commit) and records the task as done.
Without --no-processes it retains the lease, without blocking other tasks or the task's dependents. Run finish again
with --no-processes to return the lease, skipping completed steps. The text and JSON summary say whether the lease
was retained or returned; JSON lease is preserved or none respectively.
discard returns the lease of an attempt whose work is not wanted, removing the workspace's contents, and holds its
task. Both return a lease only with --no-processes, your confirmation that no worker process remains; discard
also needs --confirm. --dry-run shows what would be done.

prune archives summaries and removes records only for finished attempts older than --older-than days.
It preserves unfinished, leased, possibly running and unknown attempts. --dry-run lists removals without writing.

The configuration file defaults to $SWITCHBOARD_CONFIG, then ./switchboard.json.
Exit status: 0 when no work was ready, a dry run selected a task or the task was recorded as done (dispatch), nothing needs attention (status),
the confirmation was recorded (resolve), Pi accepted the request (stop, steer), the attempt was found (watch), or the
attempt was finished, discarded or its dry run planned (finish, discard), or pruning completed (prune);
1 for any other outcome, described by the report's reason; 2 for usage or configuration errors.`;

async function main(argv: string[]): Promise<number> {
  let commandIndex = 0;
  while (commandIndex < argv.length) {
    const option = argv[commandIndex]!;
    if (option === "--json" || option.startsWith("--config=")) commandIndex++;
    else if (option === "--config" && argv[commandIndex + 1] && !argv[commandIndex + 1]!.startsWith("--")) commandIndex += 2;
    else break;
  }
  const taskArgs = [...argv.slice(0, commandIndex), ...argv.slice(commandIndex + 1)];
  if (argv[commandIndex] === "task") return taskCommand(taskArgs);
  if (argv[commandIndex] === "import") return (await import("./tasks/import.ts")).importCommand(taskArgs);
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      once: { type: "boolean" }, "dry-run": { type: "boolean" }, task: { type: "string" }, "request-id": { type: "string" },
      json: { type: "boolean" }, config: { type: "string" }, help: { type: "boolean" }, version: { type: "boolean" },
      lease: { type: "string" }, "no-processes": { type: "boolean" }, "accept-output": { type: "boolean" }, confirm: { type: "boolean" }, "worker-stopped": { type: "boolean" }, "lease-returned": { type: "boolean" }, note: { type: "string" }, "no-follow": { type: "boolean" },
      after: { type: "boolean" }, as: { type: "string" }, wait: { type: "string" }, attempt: { type: "string" }, "older-than": { type: "string" },
    },
  });
  if (values.version) {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    return 0;
  }
  const command = positionals[0];
  const commands = ["dispatch", "status", "resolve", "watch", "stop", "steer", "finish", "discard", "prune"];
  if (values.help || !command || !commands.includes(command) || positionals.length !== (command === "steer" ? 2 : 1)) {
    console.error(usage);
    return values.help ? 0 : 2;
  }
  // An option that a command does not use is refused, so that, for example, `stop --dry-run` cannot send a real stop.
  const selectors = ["lease", "task", "attempt"];
  const allowed: Record<string, string[]> = {
    dispatch: ["once", "dry-run", "task", "request-id"], status: [], resolve: ["lease", "task", "attempt", "worker-stopped", "lease-returned", "note"],
    watch: [...selectors, "no-follow"], stop: [...selectors, "as", "wait"], steer: [...selectors, "after", "as", "wait"],
    prune: ["older-than", "dry-run"], finish: [...selectors, "no-processes", "accept-output", "dry-run"], discard: [...selectors, "no-processes", "confirm", "note", "dry-run"],
  };
  const misplaced = Object.keys(values).filter(name => !["json", "config", ...allowed[command]!].includes(name));
  if (misplaced.length > 0) {
    console.error(`${command} does not take ${misplaced.map(name => `--${name}`).join(", ")}.\n\n${usage}`);
    return 2;
  }
  if (command === "dispatch" && !values.once) {
    console.error("dispatch requires --once: Phase 1 dispatches exactly one task per invocation.\n\n" + usage);
    return 2;
  }
  const olderThan = Number(values["older-than"]);
  if (command === "prune" && (!Number.isFinite(olderThan) || olderThan <= 0)) {
    console.error("prune requires --older-than <days>, a positive number of days.");
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
  const byAttempt = ["watch", "stop", "steer", "finish", "discard"].includes(command);
  if (byAttempt && (
    (values.lease !== undefined) === (values.task !== undefined)
    || values.lease === "" || values.task === ""
    || (values.attempt !== undefined && (!values.task || !Number.isSafeInteger(attempt) || attempt! <= 0))
  )) {
    console.error(`${command} requires exactly one of --lease <lease-id> or --task <task-id>, and --attempt must be a positive integer with --task; \`switchboard status\` shows each attempt's task and lease ID.\n\n${usage}`);
    return 2;
  }
  const configPath = resolve(values.config ?? process.env.SWITCHBOARD_CONFIG ?? "switchboard.json");
  let deps;
  try {
    const config = await loadConfig(configPath);
    await requireRetainedStorage(config.runtimeRoot, [config.workspaces.poolRoot]);
    await requireRetainedStorage(databasePath(config), [config.workspaces.poolRoot]);
    deps = await createDependencies(config, message => { if (!values.json) console.error(message); });
    // Close the database however the process ends, so it never exits with the database open unless it crashes.
    const tasks = deps.tasks;
    if (tasks instanceof SqliteTaskStore) process.once("exit", () => tasks.close());
  } catch (error) {
    console.error(`Configuration error (${configPath}): ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  // A task's attempt is acted on through its lease, so --task is resolved to the attempt's lease ID first.
  let leaseId = values.lease;
  if (byAttempt && values.task !== undefined) {
    const selected = await leaseOfTask(deps, values.task, attempt);
    if ("refused" in selected) {
      console.log(values.json ? JSON.stringify(selected.refused, null, 2) : describe(selected.refused));
      return 1;
    }
    leaseId = selected.leaseId;
  }

  if (command === "prune") {
    const value = await prune(deps, { olderThan, dryRun: values["dry-run"] === true });
    console.log(values.json ? JSON.stringify(value, null, 2) : describe(value));
    return value.ok ? 0 : 1;
  }

  if (command === "status") {
    const value = await status(deps);
    console.log(values.json ? JSON.stringify(value, null, 2) : describeStatus(value));
    return value.ok ? 0 : 1;
  }

  if (command === "stop" || command === "steer") {
    const value = await requestControl(deps, {
      leaseId: leaseId!, kind: command === "stop" ? "stop" : values.after ? "follow_up" : "steer",
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
      leaseId: leaseId!, follow: values["no-follow"] !== true, signal: controller.signal,
      print: entry => console.log(values.json ? JSON.stringify(entry) : describeEntry(entry)),
    });
    if (!outcome.found) console.error(`No runtime record for lease ${leaseId} in this context. The worker may not have been launched.`);
    return outcome.found ? 0 : 1;
  }

  if (command === "finish" || command === "discard") {
    const common = { leaseId: leaseId!, noProcesses: values["no-processes"] === true, dryRun: values["dry-run"] === true };
    const value = command === "finish" ? await finish(deps, { ...common, acceptOutput: values["accept-output"] === true })
      : await discard(deps, { ...common, confirm: values.confirm === true, ...(values.note ? { note: values.note } : {}) });
    console.log(values.json ? JSON.stringify(value, null, 2) : describe(value));
    return value.ok ? 0 : 1;
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
  if (error instanceof Error && "code" in error && (
    error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || error.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
  )) {
    console.error(`${error.message.split("\n")[0]}\n\n${usage}`);
  } else {
    console.error(error instanceof Error ? error.stack : String(error));
  }
  return 2;
});
