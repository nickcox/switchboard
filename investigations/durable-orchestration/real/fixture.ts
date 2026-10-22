import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../../../src/config.ts";
import { runCommand } from "../../../src/infra/command.ts";
import { onPath } from "../../../src/infra/executables.ts";
import { ApplicationStore } from "../design-a/store.ts";
import { fixtureDirectory } from "../design-b/paths.ts";
import { environment, RealOwners, type RealSettings } from "./owners.ts";

export async function settingsAt(directory: string): Promise<RealSettings> {
  return JSON.parse(await readFile(join(directory, "real.json"), "utf8"));
}

// Only worker configuration and delivery requirements are imported. Never open the configured
// production repository, task database, runtime root or workspace pool.
export async function initialise(directory: string, design: "A" | "B", configPath: string, instructionsPath: string): Promise<string> {
  directory = await fixtureDirectory(directory);
  if ((await readdir(directory)).length) throw new Error("Initialise an empty disposable fixture directory");
  const config = await loadConfig(configPath);
  if (config.delivery.kind !== "code") throw new Error("The real prototype requires a code delivery contract");
  const instructions = await readFile(instructionsPath, "utf8");
  if (!instructions.trim()) throw new Error("Supply non-empty fixture instructions");
  const settings: RealSettings = { design, instructions, baseRef: config.delivery.baseRef,
    worker: config.worker, keepAwake: config.keepAwake,
    request: { requestId: "real-request-1", taskId: "real-task-1", delivery: {
      outputBranch: `durable-real/${design.toLowerCase()}/attempt-1`, acceptance: "review",
      requiredEvidence: config.delivery.requiredEvidence, requiredDeliverables: config.delivery.requiredDeliverables,
    } } };
  await writeFile(join(directory, "real.json"), JSON.stringify(settings, null, 2), { flag: "wx", flush: true, mode: 0o600 });
  const repository = join(directory, "repository");
  await mkdir(repository);
  const git = async (args: string[]) => {
    const result = await runCommand(onPath("git"), ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repository, env: environment(), timeoutMs: 15_000,
    });
    if (result.exitCode !== 0) throw new Error(`Fixture git failed: ${result.stderr}`);
  };
  await git(["check-ref-format", "--branch", settings.baseRef]);
  await git(["init", "-q", "-b", settings.baseRef]);
  await git(["config", "user.name", "Switchboard fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await git(["config", "commit.gpgsign", "false"]);
  await writeFile(join(repository, "README.md"), "# Disposable durable orchestration fixture\n");
  await git(["add", "README.md"]);
  await git(["commit", "-q", "-m", "Initial fixture"]);
  const store = await ApplicationStore.open(join(directory, "host"));
  try { await store.tasks.add({ id: settings.request.taskId, title: "Disposable real attempt", body: instructions }); }
  finally { store.close(); }
  const owners = await RealOwners.open(directory, settings);
  try { await owners.initialise(); } finally { await owners.close(); }
  return directory;
}
