import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { databasePath, loadConfig } from "../config.ts";
import { requireRetainedStorage } from "../infra/storage.ts";
import { TaskStoreError, type TaskState } from "./store.ts";
import { SqliteTaskStore, type TaskChanges } from "./sqlite.ts";

const usage = "Usage: switchboard task <add|show|list|ready|update|hold|release|block|unblock|done|reopen|convert-criteria> [id] [title] [--json] [--config <path>]";
export async function taskCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    json: { type: "boolean" }, config: { type: "string" }, help: { type: "boolean" },
    title: { type: "string" }, body: { type: "string" }, "body-file": { type: "string" },
    criterion: { type: "string", multiple: true }, "criteria-file": { type: "string" },
    repo: { type: "string" }, kind: { type: "string" }, reason: { type: "string" },
    by: { type: "string" }, note: { type: "string" }, state: { type: "string" },
  } });
  const [command, id, title] = positionals;
  const allowed: Record<string, string[]> = {
    add: ["title", "body", "body-file", "repo", "kind", "criterion", "criteria-file"], show: [], list: ["state", "repo"], ready: ["repo"],
    "convert-criteria": [], update: ["title", "body", "body-file", "repo", "kind", "criterion", "criteria-file"], hold: ["reason"], release: [], block: ["by"], unblock: ["by"], done: ["note"], reopen: [],
  };
  const invalid = !command || !allowed[command] || Object.keys(values).some(key => !["json", "config", "help", ...allowed[command]!].includes(key))
    || positionals.length !== (command === "add" && title !== undefined ? 3 : ["list", "ready", "convert-criteria"].includes(command) ? 1 : 2)
    || (command === "add" && title === undefined && values.title === undefined)
    || (command === "hold" && !values.reason) || (["block", "unblock"].includes(command) && !values.by)
    || (values.criterion !== undefined && values["criteria-file"] !== undefined)
    || (values.body !== undefined && values["body-file"] !== undefined)
    || (values.state !== undefined && !["queued", "in_flight", "done"].includes(values.state));
  if (values.help || invalid) { console.error(usage); return values.help ? 0 : 2; }
  const config = await loadConfig(resolve(values.config ?? process.env.SWITCHBOARD_CONFIG ?? "switchboard.json"));
  const path = databasePath(config);
  await requireRetainedStorage(path, [config.workspaces.poolRoot]);
  let store: SqliteTaskStore | undefined;
  try {
    store = await SqliteTaskStore.open({ path, repo: values.repo ?? config.tasks.repo, retryMs: config.databaseRetryMs });
    const changes: TaskChanges = {};
    for (const key of ["title", "body", "kind"] as const) if (values[key] !== undefined) changes[key] = values[key];
    if (values.repo !== undefined) changes.repo = values.repo;
    if (values["body-file"] !== undefined) changes.body = await readFile(resolve(values["body-file"]), "utf8");
    if (values.criterion !== undefined) changes.acceptanceCriteria = values.criterion;
    if (values["criteria-file"] !== undefined) changes.acceptanceCriteria = (await readFile(resolve(values["criteria-file"]), "utf8"))
      .split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    let value: unknown;
    switch (command) {
      case "convert-criteria": value = await store.convertCriteria(); break;
      case "add": value = await store.add({ ...changes, id: id!, title: title ?? values.title! }); break;
      case "show": value = await store.read(id!); if (!value) throw new TaskStoreError("rejected", `Task ${id} does not exist`); break;
      case "list": value = await store.list(values.state as TaskState | undefined); break;
      case "ready": value = await store.ready(); break;
      case "update": value = await store.update(id!, changes); break;
      case "hold": value = await store.hold(id!, values.reason!); break;
      case "release": value = await store.release(id!); break;
      case "block": value = await store.block(id!, values.by!); break;
      case "unblock": value = await store.unblock(id!, values.by!); break;
      case "done": value = await store.done(id!, values.note); break;
      case "reopen": value = await store.reopen(id!); break;
    }
    console.log(values.json ? JSON.stringify({ ok: true, action: command, [command === "ready" ? "ready" : command === "list" ? "tasks" : command === "convert-criteria" ? "reports" : "task"]: value }, null, 2)
      : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));
    return 0;
  } catch (error) {
    if (!(error instanceof TaskStoreError)) throw error;
    console.log(values.json ? JSON.stringify({ ok: false, reason: error.reason, detail: error.message }) : `${error.reason}: ${error.message}`);
    return 1;
  } finally { store?.close(); }
}
