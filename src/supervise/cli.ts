import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createDependencies, databasePath, loadConfig } from "../config.ts";
import { answerQuestion } from "../dispatch/answer.ts";
import { requestControl } from "../dispatch/control.ts";
import { dispatchOnce } from "../dispatch/dispatch.ts";
import { finish } from "../dispatch/finish.ts";
import { createReview } from "../dispatch/review.ts";
import { requireAuthority } from "../dispatch/safety.ts";
import { leaseOfTask } from "../dispatch/select.ts";
import { requireRetainedStorage } from "../infra/storage.ts";
import { ObjectiveStore } from "../objectives/store.ts";
import { SqliteTaskStore, type TaskChanges } from "../tasks/sqlite.ts";
import { TaskStoreError, type TaskState } from "../tasks/store.ts";
import { briefing } from "./briefing.ts";
import { appendNote } from "./notes.ts";
import { handleEvent, waitForEvent } from "./events.ts";

const usage = "Usage: switchboard supervise <operation> --objective <id> [options] [--config <path>]";
const selectors = ["lease", "task", "attempt"];
const definition = ["title", "body", "body-file", "repo", "kind", "criterion", "criteria-file"];
const allowed: Record<string, string[]> = {
  briefing: [], note: [], wait: ["timeout"], handled: [],
  "objective show": [], "objective complete": ["statements-file"],
  "task add": definition, "task show": [], "task list": ["state", "repo"], "task update": definition,
  "task hold": ["reason"], "task release": [], "task block": ["by"], "task unblock": ["by"], "task done": ["note"],
  dispatch: ["task", "from-attempt", "note", "note-file", "dry-run", "request-id"],
  review: ["task", "attempt"], answer: ["task", "question", "wait"],
  steer: [...selectors, "after", "as", "wait"], stop: [...selectors, "as", "wait"],
  finish: [...selectors, "accept-output", "rebase", "dry-run"],
};

class UsageError extends Error {}
const invalid = (detail: string): never => { throw new UsageError(detail); };
const rejected = (detail: string): never => { throw new TaskStoreError("rejected", detail); };

/** This boundary fixes the caller and command surface; operations still decide authority and safety. */
export async function superviseCommand(argv: string[]): Promise<number> {
  try {
    const result = await run(argv);
    console.log(JSON.stringify(result.value));
    return result.code;
  } catch (error) {
    const refusal = error instanceof TaskStoreError || error instanceof SyntaxError;
    console.log(JSON.stringify({ ok: false, reason: error instanceof TaskStoreError ? error.reason : refusal ? "rejected" : "error",
      detail: error instanceof Error ? error.message : String(error), ...(error instanceof UsageError ? { usage } : {}) }));
    return refusal ? 1 : 2;
  }
}

async function run(argv: string[]): Promise<{ code: number; value: unknown }> {
  const { values, positionals, tokens } = parseArgs({ args: argv, allowPositionals: true, tokens: true, options: {
    objective: { type: "string" }, config: { type: "string" }, json: { type: "boolean" },
    title: { type: "string" }, body: { type: "string" }, "body-file": { type: "string" },
    repo: { type: "string" }, kind: { type: "string" }, criterion: { type: "string", multiple: true }, "criteria-file": { type: "string" },
    state: { type: "string" }, reason: { type: "string" }, by: { type: "string" }, note: { type: "string" }, "note-file": { type: "string" },
    "statements-file": { type: "string" }, task: { type: "string" }, lease: { type: "string" }, attempt: { type: "string" },
    "from-attempt": { type: "string" }, "dry-run": { type: "boolean" }, "request-id": { type: "string" },
    question: { type: "string" }, wait: { type: "string" }, timeout: { type: "string" }, after: { type: "boolean" }, as: { type: "string" },
    "accept-output": { type: "boolean" }, rebase: { type: "boolean" },
  } });
  const grouped = positionals[0] === "task" || positionals[0] === "objective";
  const operation = positionals.slice(0, grouped ? 2 : 1).join(" ");
  const args = positionals.slice(grouped ? 2 : 1);
  if (!Object.hasOwn(allowed, operation)) invalid(`Operation ${operation || "(missing)"} is not offered to supervisors`);
  if (!values.objective || tokens.filter(token => token.kind === "option" && token.name === "objective").length !== 1) invalid("Supply exactly one --objective <id>");
  const misplaced = Object.keys(values).filter(key => !["objective", "config", "json", ...allowed[operation]!].includes(key));
  if (misplaced.length) invalid(`${operation} does not take ${misplaced.map(key => `--${key}`).join(", ")}`);
  const taskOperation = operation.startsWith("task ");
  const action = grouped ? positionals[1]! : operation;
  const expected = taskOperation && action !== "list" || operation === "steer" || operation === "answer" || operation === "note" || operation === "handled" ? 1 : 0;
  if (args.length !== expected && !(operation === "task add" && args.length === 2)) invalid(`Invalid arguments for ${operation}`);
  if (operation === "task add" && args[1] === undefined && values.title === undefined) invalid("task add requires a title");
  if (operation === "task hold" && !values.reason) invalid("task hold requires --reason");
  if (["task block", "task unblock"].includes(operation) && !values.by) invalid(`${operation} requires --by`);
  if (operation === "objective complete" && !values["statements-file"]) invalid("objective complete requires --statements-file");
  if (values.body !== undefined && values["body-file"] !== undefined) invalid("Use only one of --body and --body-file");
  if (values.criterion !== undefined && values["criteria-file"] !== undefined) invalid("Use only one of --criterion and --criteria-file");
  if (values.state !== undefined && !["queued", "in_flight", "done"].includes(values.state)) invalid("Invalid task state");
  const attempt = values.attempt === undefined ? undefined : Number(values.attempt);
  const fromAttempt = values["from-attempt"] === undefined ? undefined : Number(values["from-attempt"]);
  for (const number of [attempt, fromAttempt]) if (number !== undefined && (!Number.isSafeInteger(number) || number <= 0)) invalid("Attempt numbers must be positive integers");
  const byAttempt = ["steer", "stop", "finish"].includes(operation);
  if (byAttempt && ((values.lease !== undefined) === (values.task !== undefined) || values.lease === "" || values.task === "")) invalid(`${operation} requires exactly one of --lease or --task`);
  if (attempt !== undefined && !values.task) invalid("--attempt requires --task");
  if (["dispatch", "review", "answer"].includes(operation) && !values.task) invalid(`${operation} requires --task`);
  if (operation === "answer" && (!values.question || !args[0]?.trim())) invalid("answer requires --question and a nonempty answer");
  if (operation === "note" && !args[0]?.trim()) invalid("note requires nonempty text");
  if (operation === "dispatch" && ((fromAttempt === undefined && (values.note !== undefined || values["note-file"] !== undefined)) || (values.note !== undefined && values["note-file"] !== undefined))) invalid("Use at most one of --note and --note-file, with --from-attempt");
  const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeout !== undefined && (!values.timeout?.trim() || !Number.isFinite(timeout) || timeout < 0)) invalid("--timeout must be a nonnegative number of seconds");
  const wait = Number(values.wait ?? "10");
  if (!Number.isFinite(wait) || wait <= 0) invalid("--wait must be a positive number of seconds");

  const config = await loadConfig(resolve(values.config ?? process.env.SWITCHBOARD_CONFIG ?? "switchboard.json"));
  const caller = { kind: "supervisor", objectiveId: values.objective! } as const;
  const path = databasePath(config);
  await requireRetainedStorage(path, [config.workspaces.poolRoot]);
  const tasks = await SqliteTaskStore.open({ caller, path, repo: values.repo ?? (operation === "task list" ? null : config.tasks.repo), retryMs: config.databaseRetryMs });
  try {
    const objectives = new ObjectiveStore(tasks.database, caller);
    const objective = objectives.read(caller.objectiveId) ?? rejected(`Objective ${caller.objectiveId} does not exist`);
    if (objective.state !== "open") rejected(`Objective ${objective.id} is ${objective.state}; reopen it explicitly before supervising it`);
    if (operation === "wait") return { code: 0, value: await waitForEvent(tasks.database, caller.objectiveId, timeout) };
    if (operation === "handled") return { code: 0, value: { ok: true, action, event: await handleEvent(tasks.database, caller.objectiveId, args[0]!) } };
    if (operation === "note") return { code: 0, value: { ok: true, action, note: await appendNote(tasks.database, caller, caller.objectiveId, args[0]!) } };
    if (operation === "objective show") return { code: 0, value: { ok: true, action, objective: objectives.show(caller.objectiveId) } };
    if (operation === "objective complete") {
      const value = await objectives.complete(caller.objectiveId, JSON.parse(await readFile(resolve(values["statements-file"]!), "utf8")));
      return { code: 0, value: { ok: true, action, objective: value } };
    }
    if (taskOperation) {
      const changes: TaskChanges = {};
      for (const key of ["title", "body", "repo", "kind"] as const) if (values[key] !== undefined) changes[key] = values[key];
      if (values["body-file"] !== undefined) changes.body = await readFile(resolve(values["body-file"]), "utf8");
      if (values.criterion !== undefined) changes.acceptanceCriteria = values.criterion;
      if (values["criteria-file"] !== undefined) changes.acceptanceCriteria = (await readFile(resolve(values["criteria-file"]), "utf8")).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      let value: unknown;
      switch (action) {
        case "add": value = await tasks.add({ ...changes, id: args[0]!, title: args[1] ?? values.title!, objectiveId: caller.objectiveId }); break;
        case "show":
          // Reads need scope, not a mutation permission. Use the existing scope-only authority check.
          requireAuthority(tasks.database, caller, "recordAttempt", { taskId: args[0]! });
          value = await tasks.read(args[0]!);
          if (!value) rejected(`Task ${args[0]} does not exist`);
          break;
        case "list": value = (await tasks.list(values.state as TaskState | undefined)).filter(task => task.objectiveId === caller.objectiveId); break;
        case "update": value = await tasks.update(args[0]!, changes); break;
        case "hold": value = await tasks.hold(args[0]!, values.reason!); break;
        case "release": value = await tasks.release(args[0]!); break;
        case "block": value = await tasks.block(args[0]!, values.by!); break;
        case "unblock": value = await tasks.unblock(args[0]!, values.by!); break;
        case "done": value = await tasks.done(args[0]!, values.note); break;
      }
      return { code: 0, value: { ok: true, action, [action === "list" ? "tasks" : "task"]: value } };
    }
  } finally { tasks.close(); }

  const deps = await createDependencies(config, caller, { dispatch: operation === "dispatch" });
  try {
    let leaseId = values.lease;
    if (byAttempt && values.task !== undefined) {
      const selected = await leaseOfTask(deps, values.task, attempt);
      if ("refused" in selected) return { code: 1, value: selected.refused };
      leaseId = selected.leaseId;
    }
    let value;
    switch (operation) {
      case "briefing": return { code: 0, value: await briefing(deps, caller.objectiveId) };
      case "dispatch": {
        const note = values["note-file"] === undefined ? values.note : await readFile(resolve(values["note-file"]), "utf8");
        const controller = new AbortController();
        const interrupt = () => controller.abort();
        process.once("SIGINT", interrupt);
        try {
          value = await dispatchOnce(deps, { taskId: values.task!, dryRun: values["dry-run"] === true, signal: controller.signal,
            ...(values["request-id"] === undefined ? {} : { requestId: values["request-id"] }),
            ...(fromAttempt === undefined ? {} : { startingPoint: { taskId: values.task!, attempt: fromAttempt } }),
            ...(note === undefined ? {} : { note }) });
        } finally { process.removeListener("SIGINT", interrupt); }
        break;
      }
      case "review": value = await createReview(deps, { taskId: values.task!, ...(attempt === undefined ? {} : { attempt }) }); break;
      case "answer": value = await answerQuestion(deps, { taskId: values.task!, questionId: values.question!, answer: args[0]!, waitMs: wait * 1000 }); break;
      case "steer": case "stop": value = await requestControl(deps, { leaseId: leaseId!, kind: operation === "stop" ? "stop" : values.after ? "follow_up" : "steer",
        ...(operation === "steer" ? { message: args[0]! } : {}), ...(values.as === undefined ? {} : { label: values.as }), waitMs: wait * 1000 }); break;
      case "finish": value = await finish(deps, { leaseId: leaseId!, noProcesses: false, dryRun: values["dry-run"] === true, acceptOutput: values["accept-output"] === true, rebase: values.rebase === true }); break;
      default: return invalid(`Operation ${operation} is not offered to supervisors`);
    }
    return { code: value.ok ? 0 : 1, value };
  } finally { deps.close(); }
}
