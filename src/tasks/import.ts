import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, lstat, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MarkdownStore } from "tasks-axi/dist/src/backends/markdown.js";
import { parseBacklog } from "tasks-axi/dist/src/backends/markdown-grammar.js";
import { isHoldActive, readyTasks } from "tasks-axi/dist/src/derive.js";
import { AttemptLog } from "../attempts/log.ts";
import { databasePath, loadConfig, type Config } from "../config.ts";
import { isOpen } from "../dispatch/dispatch.ts";
import { requireRetainedStorage } from "../infra/storage.ts";
import { dispatcherRunning } from "../runtime/heartbeat.ts";
import { RuntimeRecords } from "../runtime/records.ts";
import { SqliteTaskStore } from "./sqlite.ts";
import { TaskStoreError } from "./store.ts";

const exists = async (path: string) => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });

/**
 * Import is offline: every attempt must be settled and no dispatcher may be running, so no Switchboard process can be
 * writing the old records. Old attempts and runtime records stay in place until their own migration.
 */
export async function requireSettled(config: Config): Promise<void> {
  const attempts = await new AttemptLog(config.runtimeRoot, config.contextId).list();
  if (attempts.some(isOpen)) throw new TaskStoreError("rejected", "Import requires every attempt to be settled");
  const runtime = await new RuntimeRecords(config.runtimeRoot).discover(config.contextId);
  for (const record of runtime) {
    const stopped = record.child.status !== "unknown" || attempts.some(a => a.entries.some(e => e.kind === "operator_resolved" && e.data.action === "worker_stopped")
      && a.entries.some(e => e.kind === "leased" && e.data.leaseId === record.binding.input.identity.leaseId));
    if (!stopped) throw new TaskStoreError("rejected", "Import refuses a worker that may still be running");
    if (await dispatcherRunning(record.directory)) throw new TaskStoreError("rejected", "Import refuses while a dispatcher's heartbeat is fresh");
  }
}

export async function importTasks(config: Config, backlog: string, archive = join(dirname(backlog), "done-archive.md")) {
  await requireSettled(config);
  const path = databasePath(config);
  await requireRetainedStorage(path, [config.workspaces.poolRoot]);
  if (await exists(path)) throw new TaskStoreError("rejected", "Database is already activated; import will not replace it");
  const source = await readFile(backlog, "utf8");
  const archiveSource = await exists(archive) ? await readFile(archive, "utf8") : undefined;
  const active = (await new MarkdownStore({ path: backlog }).list({})).items;
  // tasks-axi writes its archive but never reads it: entries use the backlog's format under `## Archived <date>`
  // headings, which its parser does not recognise as a section. Read them as a Done section.
  const archived = archiveSource === undefined ? [] : parseBacklog(archiveSource.replace(/^## Archived\b.*$/gm, "## Done")).sections
    .flatMap(section => section.entries.flatMap(entry => (entry.kind === "task" ? [entry.task] : [])));
  // An independent count: every task line in either file must have been parsed, so an unrecognised format is refused
  // rather than skipped.
  const taskLines = (text: string) => text.split("\n").filter(line => /^- \[.\] /.test(line)).length;
  if (taskLines(source) !== active.length || taskLines(archiveSource ?? "") !== archived.length) {
    throw new TaskStoreError("rejected", `Parsed ${active.length} of ${taskLines(source)} backlog tasks and ${archived.length} of ${taskLines(archiveSource ?? "")} archived tasks`);
  }
  const tasks = [...active, ...archived];
  const ids = new Set(tasks.map(t => t.id));
  if (ids.size !== tasks.length) throw new TaskStoreError("rejected", "Duplicate task IDs in backlog and archive");
  // Each run has its own staging file, removed unless it is activated, so concurrent or repeated imports never share one.
  const staging = `${path}.import-${randomUUID()}`;
  const removeStaging = async () => { for (const suffix of ["", "-wal", "-shm"]) await rm(`${staging}${suffix}`, { force: true }); };
  const store = await SqliteTaskStore.open({ path: staging });
  const dropped: { task: string; blocker: string }[] = [];
  // A tasks-axi hold with a date: one still in force becomes an ordinary hold, and one whose date has passed is dropped.
  const timedHolds: { task: string; until: string; kept: boolean }[] = [];
  const holdOf = (task: (typeof tasks)[number]) => (task.hold && isHoldActive(task) ? task.hold.reason : null);
  let activated = false;
  try {
    for (const task of tasks) {
      await store.add({ id: task.id, title: task.title, body: task.body ?? "", repo: task.repo ?? null, kind: task.kind ?? null });
      if (task.hold?.until) timedHolds.push({ task: task.id, until: task.hold.until, kept: holdOf(task) !== null });
      const hold = holdOf(task);
      if (hold !== null) await store.hold(task.id, hold);
      await store.database.transaction(() => store.database.run("UPDATE tasks SET state = ? WHERE id = ?", task.state, task.id));
    }
    for (const task of tasks) for (const dep of task.deps.filter(d => d.type === "blocked-by")) {
      if (!ids.has(dep.id)) dropped.push({ task: task.id, blocker: dep.id });
      else await store.block(task.id, dep.id);
    }
    const imported = await store.list();
    assert.equal(imported.length, tasks.length, "Imported task count differs");
    for (const [index, task] of tasks.entries()) {
      const row = imported[index]!;
      assert.deepEqual({ id: row.id, title: row.title, body: row.body, repo: row.repo, kind: row.kind, state: row.state, holdReason: row.holdReason, position: row.position, blockedBy: row.blockedBy }, {
        id: task.id, title: task.title, body: task.body ?? "", repo: task.repo ?? null, kind: task.kind === "task" ? null : task.kind ?? null,
        state: task.state, holdReason: holdOf(task), position: index + 1,
        blockedBy: [...new Set(task.deps.filter(d => d.type === "blocked-by" && ids.has(d.id)).map(d => d.id))].sort(),
      });
    }
    assert.deepEqual(await store.ready(), readyTasks(tasks).map(t => t.id), "Imported ready list differs from tasks-axi");
    assert.equal(await readFile(backlog, "utf8"), source, "Backlog changed during import");
    if (archiveSource !== undefined) assert.equal(await readFile(archive, "utf8"), archiveSource, "Archive changed during import");
    await requireSettled(config);
    store.database.checkpoint();
    store.close();
    // Creating the link fails if a database already exists, so only one import can ever activate.
    await link(staging, path).catch(error => {
      if (error.code === "EEXIST") throw new TaskStoreError("rejected", "Database was activated during import");
      throw error;
    });
    activated = true;
  } finally {
    store.close();
    await removeStaging();
  }
  return { ok: activated, count: tasks.length, dropped, timedHolds, path };
}

export async function importCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    attempts: { type: "boolean" }, "tasks-axi": { type: "string" }, archive: { type: "string" }, json: { type: "boolean" }, config: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help || Boolean(values.attempts) === Boolean(values["tasks-axi"]) || (values.attempts && values.archive) || positionals.length) {
    console.error("Usage: switchboard import (--attempts | --tasks-axi <backlog.md> [--archive <done-archive.md>]) [--json] [--config <path>]");
    return values.help ? 0 : 2;
  }
  const config = await loadConfig(resolve(values.config ?? process.env.SWITCHBOARD_CONFIG ?? "switchboard.json"));
  try {
    const result = values.attempts ? await (await import("../attempts/import.ts")).importAttempts(config)
      : await importTasks(config, resolve(values["tasks-axi"]!), values.archive === undefined ? undefined : resolve(values.archive));
    console.log(JSON.stringify(result, null, values.json ? 2 : undefined));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, reason: error instanceof TaskStoreError ? error.reason : "validation_failed", detail: String(error) }));
    return 1;
  }
}
