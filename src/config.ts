import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { AttemptLog } from "./attempts/log.ts";
import type { Dependencies } from "./dispatch/dispatch.ts";
import { onPath } from "./infra/executables.ts";
import { PiWorker } from "./runtime/pi/worker.ts";
import { RuntimeRecords } from "./runtime/records.ts";
import { TasksAxiStore } from "./tasks/tasks-axi.ts";
import { checkRetention } from "./workspaces/retention.ts";
import { TreehouseProvider } from "./workspaces/treehouse.ts";

const absolute = z.string().refine(isAbsolute, "Must be an absolute path");
const nonempty = z.string().min(1);

/** The Switchboard configuration file. Every path is absolute so nothing depends on the caller's directory. */
export const configSchema = z.strictObject({
  contextId: nonempty,
  /** Holds runtime records and the attempt log. Must be outside every workspace. */
  runtimeRoot: absolute,
  tasks: z.strictObject({ file: absolute, repo: nonempty }),
  workspaces: z.strictObject({ repository: absolute, poolRoot: absolute, fetch: z.boolean().default(false) }),
  delivery: z.strictObject({
    baseRef: nonempty,
    branchPrefix: z.string().default("switchboard/"),
    kind: z.enum(["code", "artefact"]).default("code"),
    acceptance: z.enum(["review_or_integration", "independent_deliverable"]).default("review_or_integration"),
    requiredEvidence: z.array(nonempty).default([]),
    requiredDeliverables: z.array(nonempty).default([]),
  }),
  worker: z.strictObject({
    /** The Pi CLI entry point run with this Node.js executable, for example .../pi-coding-agent/dist/bundle/cli.js. */
    piEntrypoint: absolute,
    provider: nonempty,
    model: nonempty,
    shellTool: z.enum(["bash", "powershell"]).default("bash"),
    runMs: z.number().int().positive().default(30 * 60 * 1000),
    /** The worker's complete environment. Defaults to PATH, HOME, USER, TMPDIR and LANG from Switchboard's own. */
    environment: z.record(z.string(), z.string()).optional(),
  }),
});
export type Config = z.output<typeof configSchema>;

export async function loadConfig(path: string): Promise<Config> {
  const text = await readFile(path, "utf8");
  return configSchema.parse(JSON.parse(text));
}

const tasksAxiEntrypoint = resolve(import.meta.dirname, "../node_modules/tasks-axi/dist/bin/tasks-axi.js");

function inherited(names: string[]): Record<string, string> {
  return Object.fromEntries(names.flatMap(name => (process.env[name] === undefined ? [] : [[name, process.env[name]!]])));
}

/** Opens and validates every adapter. Fails before any dispatch if a store, repository or executable is unusable. */
export async function createDependencies(config: Config, progress?: (message: string) => void): Promise<Dependencies> {
  const git = onPath("git");
  // Git and Treehouse use the operator's own environment, including their Git identity and credentials.
  const hostEnvironment = Object.fromEntries(Object.entries(process.env).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])));
  const runtime = new RuntimeRecords(config.runtimeRoot);
  const worker = new PiWorker(runtime, {
    executable: process.execPath, entrypoint: config.worker.piEntrypoint,
    provider: config.worker.provider, model: config.worker.model, shellTool: config.worker.shellTool, runMs: config.worker.runMs,
    environment: config.worker.environment ?? inherited(["PATH", "HOME", "USER", "TMPDIR", "LANG"]),
  });
  return {
    contextId: config.contextId,
    tasks: await TasksAxiStore.open({
      node: process.execPath, entrypoint: tasksAxiEntrypoint, file: config.tasks.file, repo: config.tasks.repo, home: process.env.HOME ?? "/",
    }),
    workspaces: await TreehouseProvider.open({
      treehouse: onPath("treehouse"), git, repository: config.workspaces.repository, poolRoot: config.workspaces.poolRoot,
      fetch: config.workspaces.fetch, environment: hostEnvironment,
    }),
    attempts: new AttemptLog(config.runtimeRoot, config.contextId),
    runtime,
    launch: (input, signal) => worker.execute(input, signal),
    retention: request => checkRetention(git, hostEnvironment, request),
    repository: config.workspaces.repository,
    delivery: config.delivery,
    ...(progress ? { progress } : {}),
  };
}
