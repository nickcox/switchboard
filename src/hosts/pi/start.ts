import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { commandLineCaller } from "../../caller.ts";
import { databasePath, loadConfig, type Config } from "../../config.ts";
import { requireRetainedStorage } from "../../infra/storage.ts";
import { ObjectiveStore } from "../../objectives/store.ts";
import { SqliteTaskStore } from "../../tasks/sqlite.ts";
import { supervisorToolNames } from "./tools.ts";
import type { SupervisorBinding } from "./extension.ts";

export type SupervisorLaunch = { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };

/** A new session always reconstructs its state from the briefing, never an old transcript. */
export async function prepareSupervisor(config: Config, configPath: string, objectiveId: string): Promise<SupervisorLaunch> {
  await requireRetainedStorage(config.runtimeRoot, [config.workspaces.poolRoot]);
  await requireRetainedStorage(databasePath(config), [config.workspaces.poolRoot]);
  const tasks = await SqliteTaskStore.open({ caller: commandLineCaller(), path: databasePath(config), repo: config.tasks.repo, retryMs: config.databaseRetryMs });
  try {
    const objective = new ObjectiveStore(tasks.database, commandLineCaller()).read(objectiveId);
    if (!objective) throw new Error(`Objective ${objectiveId} does not exist`);
    if (objective.state !== "open") throw new Error(`Objective ${objectiveId} is ${objective.state}; reopen it explicitly before supervising it`);
  } finally { tasks.close(); }
  const key = createHash("sha256").update(objectiveId).digest("hex");
  const root = join(config.runtimeRoot, "supervisors", key);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "session-"));
  const cwd = join(directory, "work");
  const sessions = join(directory, "sessions");
  const privateDirectory = join(directory, "private");
  for (const path of [cwd, sessions, privateDirectory]) await mkdir(path, { mode: 0o700 });
  const sessionId = randomUUID();
  const binding: SupervisorBinding = {
    objectiveId, configPath: resolve(configPath), sessionId, privateDirectory,
    cliPath: fileURLToPath(new URL("../../cli.ts", import.meta.url)),
    ...(config.supervisor?.providerRetries === undefined ? {} : { providerRetries: config.supervisor.providerRetries }),
  };
  const bindingPath = join(privateDirectory, "binding.json");
  await writeFile(bindingPath, JSON.stringify(binding), { mode: 0o600 });
  const settings = {
    provider: config.supervisor?.provider ?? config.worker.provider,
    model: config.supervisor?.model ?? config.worker.model,
    thinking: config.supervisor?.thinking ?? config.worker.thinking,
  };
  return {
    executable: process.execPath, cwd,
    env: { ...process.env, SWITCHBOARD_SUPERVISOR_BINDING: bindingPath },
    args: [config.worker.piEntrypoint,
      "--session-id", sessionId, "--session-dir", sessions,
      "--provider", settings.provider, "--model", settings.model,
      ...(settings.thinking === undefined ? [] : ["--thinking", settings.thinking]),
      "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", fileURLToPath(new URL("./extension.ts", import.meta.url)),
      "--tools", supervisorToolNames.join(","),
      // --no-context-files does not suppress a user-level SYSTEM.md; fix the role as well as the routine.
      "--system-prompt", "You are the Switchboard supervisor for one objective. Act only through the supplied supervisor tools and follow the supervisor routine.",
      "--append-system-prompt", fileURLToPath(new URL("../../../skills/switchboard-supervisor/SKILL.md", import.meta.url)),
      "--", "Read the current briefing with sb_briefing before doing anything else. Continue this objective from Switchboard's records.",
    ],
  };
}

export async function launchSupervisor(launch: SupervisorLaunch): Promise<number> {
  const child = spawn(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env, stdio: "inherit", shell: false });
  // Both processes receive terminal interrupts. Wait for Pi to finish its session shutdown rather than abandoning it.
  const interrupt = () => {};
  process.on("SIGINT", interrupt);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
    });
  } finally { process.removeListener("SIGINT", interrupt); }
}

export async function supervisorCommand(argv: string[]): Promise<number> {
  try {
    const { values, positionals, tokens } = parseArgs({ args: argv, allowPositionals: true, tokens: true, options: {
      objective: { type: "string" }, config: { type: "string" },
    } });
    if (positionals.length !== 1 || positionals[0] !== "start" || !values.objective ||
      tokens.filter(token => token.kind === "option" && token.name === "objective").length !== 1) {
      throw new Error("Usage: switchboard supervisor start --objective <id> [--config <path>]");
    }
    const configPath = resolve(values.config ?? process.env.SWITCHBOARD_CONFIG ?? "switchboard.json");
    const config = await loadConfig(configPath);
    return await launchSupervisor(await prepareSupervisor(config, configPath, values.objective));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
