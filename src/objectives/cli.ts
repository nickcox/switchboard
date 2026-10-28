import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { databasePath, loadConfig } from "../config.ts";
import { Database } from "../database.ts";
import { requireRetainedStorage } from "../infra/storage.ts";
import { TaskStoreError } from "../tasks/store.ts";
import { ObjectiveStore, type Objective, type ObjectiveChanges } from "./store.ts";

const usage = `Usage: switchboard objective <add|show|list|update|complete|abandon|reopen> [id] [request] [--json] [--config <path>]
add: <id> <request> (or --request-file <path>), --criterion <text> (repeatable) or --criteria-file <path>
add/update: --scope <text>, --constraints <text>, --permissions-file <json>, --budget-file <json>, --deadline <ISO timestamp> or --clear-deadline
complete: <id> --statements-file <json>
list: [--state open|completed|abandoned]`;
export async function objectiveCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    json: { type: "boolean" }, config: { type: "string" }, help: { type: "boolean" },
    "request-file": { type: "string" }, criterion: { type: "string", multiple: true }, "criteria-file": { type: "string" },
    scope: { type: "string" }, constraints: { type: "string" }, "permissions-file": { type: "string" }, "budget-file": { type: "string" },
    deadline: { type: "string" }, "clear-deadline": { type: "boolean" }, "statements-file": { type: "string" }, state: { type: "string" },
  } });
  const [command, id, request] = positionals;
  const fields = ["criterion", "criteria-file", "scope", "constraints", "permissions-file", "budget-file", "deadline", "clear-deadline"];
  const allowed: Record<string, string[]> = { add: [...fields, "request-file"], update: fields, show: [], list: ["state"], complete: ["statements-file"], abandon: [], reopen: [] };
  const invalid = !command || !allowed[command] || Object.keys(values).some(key => !["json", "config", "help", ...allowed[command]!].includes(key))
    || positionals.length !== (command === "list" ? 1 : command === "add" && request !== undefined ? 3 : 2)
    || (command === "add" && (request === undefined) === (values["request-file"] === undefined))
    || (command === "complete" && !values["statements-file"])
    || (values.criterion !== undefined && values["criteria-file"] !== undefined)
    || (values.deadline !== undefined && values["clear-deadline"] === true)
    || (values.state !== undefined && !["open", "completed", "abandoned"].includes(values.state));
  if (values.help || invalid) { console.error(usage); return values.help ? 0 : 2; }
  const config = await loadConfig(resolve(values.config ?? process.env.SWITCHBOARD_CONFIG ?? "switchboard.json"));
  const path = databasePath(config);
  await requireRetainedStorage(path, [config.workspaces.poolRoot]);
  let database: Database | undefined;
  try {
    database = await Database.open(path, config.databaseRetryMs);
    const store = new ObjectiveStore(database, `operator:${userInfo().username}`);
    const changes: ObjectiveChanges = {};
    if (values.scope !== undefined) changes.scope = values.scope;
    if (values.constraints !== undefined) changes.constraints = values.constraints;
    if (values.criterion !== undefined) changes.acceptanceCriteria = values.criterion;
    if (values["criteria-file"] !== undefined) changes.acceptanceCriteria = (await readFile(resolve(values["criteria-file"]), "utf8")).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (values["permissions-file"] !== undefined) changes.permissions = JSON.parse(await readFile(resolve(values["permissions-file"]), "utf8"));
    if (values["budget-file"] !== undefined) changes.budget = JSON.parse(await readFile(resolve(values["budget-file"]), "utf8"));
    if (values.deadline !== undefined) changes.deadline = values.deadline;
    if (values["clear-deadline"]) changes.deadline = null;
    let value: unknown;
    switch (command) {
      case "add": value = await store.add({ ...changes, id: id!, request: request ?? await readFile(resolve(values["request-file"]!), "utf8") }); break;
      case "show": value = store.show(id!); break;
      case "list": value = store.list(values.state as Objective["state"] | undefined); break;
      case "update": value = await store.update(id!, changes); break;
      case "complete": value = await store.complete(id!, JSON.parse(await readFile(resolve(values["statements-file"]!), "utf8"))); break;
      case "abandon": value = await store.abandon(id!); break;
      case "reopen": value = await store.reopen(id!); break;
    }
    console.log(values.json ? JSON.stringify({ ok: true, action: command, [command === "list" ? "objectives" : "objective"]: value }, null, 2) : JSON.stringify(value, null, 2));
    return 0;
  } catch (error) {
    if (!(error instanceof TaskStoreError) && !(error instanceof SyntaxError)) throw error;
    console.log(values.json ? JSON.stringify({ ok: false, reason: error instanceof TaskStoreError ? error.reason : "rejected", detail: error.message }) : `rejected: ${error.message}`);
    return 1;
  } finally { database?.close(); }
}
