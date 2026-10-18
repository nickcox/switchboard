import { decode } from "@toon-format/toon";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { describeCommand as describe, runCommand, type CommandResult as Run } from "../infra/command.ts";
import { TaskStoreError, type Hold, type Task, type TaskStore } from "./store.ts";

/**
 * tasks-axi 0.2.6 adapter. Every command passes the absolute store path and explicit backend, so the caller's working
 * directory, environment and configuration files cannot redirect it. Read commands emit TOON; mutations emit JSON.
 * See docs/phases/01-basic-dispatch/investigation.md for the tested mapping.
 */
const optionsSchema = z.object({
  node: z.string().refine(isAbsolute, "Node executable must be absolute"),
  entrypoint: z.string().refine(isAbsolute, "tasks-axi entrypoint must be absolute"),
  file: z.string().refine(isAbsolute, "Task store path must be absolute"),
  repo: z.string().min(1),
  home: z.string().refine(isAbsolute, "Home directory must be absolute"),
  timeoutMs: z.number().int().positive().default(15000),
});
export type TasksAxiOptions = z.input<typeof optionsSchema>;

const yesNo = z.enum(["yes", "no"]).transform(value => value === "yes");
const dash = (value: string) => (value === "-" ? null : value);
const shownSchema = z.object({
  task: z.object({
    id: z.string().min(1),
    title: z.string(),
    state: z.enum(["queued", "in_flight", "done"]),
    blocked: yesNo,
    held: yesNo,
    hold_reason: z.string().transform(dash),
    repo: z.string().transform(dash),
    body: z.string(),
  }),
});
const rowsSchema = (field: string) => z.object({
  count: z.number().int().nonnegative(),
  [field]: z.union([z.array(z.object({ id: z.string().min(1) })), z.string()]),
});
const mutationSchema = z.object({
  ok: z.literal(true),
  action: z.string(),
  task: z.object({ id: z.string() }),
});

// tasks-axi rejects parentheses and newlines in hold reasons.
const holdReason = z.string().min(1).max(200).refine(value => !/[()\r\n]/.test(value), "Hold reason must not contain parentheses or newlines");

export class TasksAxiStore implements TaskStore {
  private readonly options: z.output<typeof optionsSchema>;
  private constructor(options: z.output<typeof optionsSchema>) { this.options = options; }

  /** Validates that the store path is an existing, canonical regular file before any command uses it. */
  static async open(options: TasksAxiOptions): Promise<TasksAxiStore> {
    const parsed = optionsSchema.parse(options);
    const stat = await lstat(parsed.file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Task store must be a regular file, not a link");
    if (await realpath(parsed.file) !== parsed.file) throw new Error("Task store path must be canonical");
    return new TasksAxiStore(parsed);
  }

  async ready(): Promise<string[]> {
    return this.rows(["ready", "--repo", this.options.repo], "ready");
  }

  async inFlight(): Promise<string[]> {
    return this.rows(["list", "--state", "in_flight", "--repo", this.options.repo], "tasks");
  }

  async read(id: string): Promise<Task | undefined> {
    const run = await this.run(["show", id, "--full"]);
    if (run.timedOut) throw new TaskStoreError("unreadable", `Reading task ${id} timed out`);
    const output = this.decodeToon(run, `show ${id}`);
    if (run.exitCode !== 0) {
      if (isRecord(output) && output.code === "NOT_FOUND") return undefined;
      throw new TaskStoreError("unreadable", `Reading task ${id} failed`, describe(run));
    }
    const parsed = shownSchema.safeParse(output);
    if (!parsed.success || parsed.data.task.id !== id) {
      throw new TaskStoreError("unreadable", `Unexpected show output for task ${id}`, describe(run));
    }
    const task = parsed.data.task;
    return {
      id: task.id, title: task.title, state: task.state, repo: task.repo, blocked: task.blocked,
      held: task.held, holdReason: task.hold_reason, body: task.body,
    };
  }

  async start(id: string): Promise<Task> {
    await this.mutate(id, "start", ["start", id]);
    return this.expect(id, task => task.state === "in_flight", "in flight");
  }

  async recordDone(id: string, note: string): Promise<Task> {
    // --no-prune keeps the done task inspectable after an uncertain update and avoids writing an archive.
    await this.mutate(id, "done", ["done", id, "--note", note, "--no-prune"]);
    return this.expect(id, task => task.state === "done" && task.body.includes(note), "done with the note retained");
  }

  /**
   * Three writes that are not atomic: hold, replace the body, reopen to queued. Each step is skipped when a read
   * shows it already applied, so a partly applied hold can be completed by running this again.
   */
  async recordHold(id: string, hold: Hold): Promise<Task> {
    const reason = holdReason.parse(hold.reason);
    let task = await this.require(id);
    if (!(task.held && task.holdReason === reason)) {
      await this.mutate(id, "hold", ["hold", id, "--reason", reason]);
      task = await this.expect(id, t => t.held && t.holdReason === reason, "held with the given reason");
    }
    if (task.body !== hold.body) {
      await this.mutate(id, "update", ["update", id, "--body", hold.body]);
      task = await this.expect(id, t => t.body === hold.body, "holding the given body");
    }
    if (task.state !== "queued") {
      // Reopen only after the hold is confirmed, so the task is never queued without it.
      await this.mutate(id, "reopen", ["reopen", id]);
      task = await this.expect(id, t => t.state === "queued" && t.held && t.holdReason === reason, "queued and held");
    }
    return task;
  }

  private async rows(args: string[], field: string): Promise<string[]> {
    const run = await this.run(args);
    if (run.timedOut || run.exitCode !== 0) throw new TaskStoreError("unreadable", `${args[0]} failed`, describe(run));
    const parsed = rowsSchema(field).safeParse(this.decodeToon(run, args[0]!));
    if (!parsed.success) throw new TaskStoreError("unreadable", `Unexpected ${args[0]} output`, describe(run));
    const rows = parsed.data[field] as { id: string }[] | string;
    // With no rows, tasks-axi prints a sentence in place of the list.
    if (typeof rows === "string") {
      if (parsed.data.count !== 0) throw new TaskStoreError("unreadable", `Unexpected ${args[0]} output`, describe(run));
      return [];
    }
    if (rows.length !== parsed.data.count) throw new TaskStoreError("unreadable", `Inconsistent ${args[0]} count`, describe(run));
    return rows.map(row => row.id);
  }

  private async mutate(id: string, action: string, args: string[]): Promise<void> {
    const run = await this.run([...args, "--json"]);
    if (run.timedOut || run.exitCode === null) {
      throw new TaskStoreError("outcome_unknown", `tasks-axi ${action} for ${id} did not report a result`, describe(run));
    }
    if (run.exitCode !== 0) throw new TaskStoreError("rejected", `tasks-axi refused ${action} for ${id}`, describe(run));
    let output: unknown;
    try { output = JSON.parse(run.stdout); }
    catch { throw new TaskStoreError("outcome_unknown", `Unreadable ${action} result for ${id}`, describe(run)); }
    const parsed = mutationSchema.safeParse(output);
    if (!parsed.success || parsed.data.action !== action || parsed.data.task.id !== id) {
      throw new TaskStoreError("outcome_unknown", `Unexpected ${action} result for ${id}`, describe(run));
    }
  }

  private async require(id: string): Promise<Task> {
    const task = await this.read(id);
    if (!task) throw new TaskStoreError("unexpected_state", `Task ${id} does not exist`);
    return task;
  }

  private async expect(id: string, predicate: (task: Task) => boolean, description: string): Promise<Task> {
    const task = await this.require(id);
    if (!predicate(task)) {
      throw new TaskStoreError("unexpected_state", `Task ${id} is not ${description} after a reported success`);
    }
    return task;
  }

  private decodeToon(run: Run, label: string): unknown {
    try { return decode(run.stdout); }
    catch { throw new TaskStoreError("unreadable", `Unreadable ${label} output`, describe(run)); }
  }

  private run(args: string[]): Promise<Run> {
    const { node, entrypoint, file, home, timeoutMs } = this.options;
    // A controlled environment: no TASKS_AXI_* variables, and a home directory chosen by configuration.
    return runCommand(node, [entrypoint, ...args, "--backend", "markdown", "--file", file], {
      cwd: dirname(file), env: { PATH: process.env.PATH ?? "", HOME: home, NO_COLOR: "1" }, timeoutMs,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
