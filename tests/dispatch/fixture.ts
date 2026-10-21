import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AttemptStore } from "../../src/attempts/store.ts";
import type { EntryData } from "../../src/attempts/log.ts";

class FixtureAttemptStore extends AttemptStore {
  async create(taskId: string, requested: EntryData<"requested">, _previous: number) {
    return (await this.reserveAttempt({ taskId, requested, maximum: 100 })).ref;
  }
}
import type { ContractSpec, Dependencies } from "../../src/dispatch/dispatch.ts";
import { onPath } from "../../src/infra/executables.ts";
import type { DeliveryContract } from "../../src/runtime/contracts.ts";
import { PiWorker, type PiWorkerOptions } from "../../src/runtime/pi/worker.ts";
import { RuntimeRecords } from "../../src/runtime/records.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";
import { checkRetention } from "../../src/workspaces/retention.ts";
import { TreehouseProvider } from "../../src/workspaces/treehouse.ts";

// End to end with SQLite, Treehouse and Git, and the synthetic Pi peer as the worker.
const git = onPath("git");
const treehouse = onPath("treehouse");
const entrypoint = resolve(import.meta.dirname, "../../src/cli.ts");
const evidence = resolve(import.meta.dirname, "../../.investigation/dispatch-unit");
mkdirSync(evidence, { recursive: true });

export async function fixture(options: { tasks?: string[][]; scenario?: string; acceptance?: DeliveryContract["acceptance"]; baseRef?: string; byTaskKind?: Record<string, ContractSpec>; worker?: Partial<PiWorkerOptions> } = {}) {
  const dir = realpathSync(mkdtempSync(join(evidence, "case-")));
  const home = join(dir, "home");
  mkdirSync(home);
  const environment = {
    PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Switchboard fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Switchboard fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const repository = join(dir, "repository");
  const run = (args: string[], cwd = repository) => execFileSync(git, ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env: environment, encoding: "utf8" }).trim();
  mkdirSync(repository);
  run(["init", "-q", "-b", "main"]);
  writeFileSync(join(repository, "tracked.txt"), "base\n");
  run(["add", "."]);
  // Commits exist only in disposable fixture repositories.
  run(["commit", "-q", "--no-gpg-sign", "-m", "Fixture base"]);

  const runtimeRoot = join(dir, "runtime");
  const runtime = new RuntimeRecords(runtimeRoot);
  const log = join(dir, "requests.jsonl");
  const worker = new PiWorker(runtime, {
    executable: process.execPath, entrypoint: resolve(import.meta.dirname, "../fixtures/pi-rpc.ts"),
    provider: "fixture", model: "fixture", shellTool: "bash", requestMs: 2000, runMs: 5000, stopMs: 600,
    environment: { ...environment, FAKE_PI_SCENARIO: options.scenario ?? "normal", FAKE_PI_LOG: log },
    ...options.worker,
  });
  const tasks = await SqliteTaskStore.open({ path: join(dir, "tasks.db"), repo: "fixture" });
  const deps: Dependencies & { attempts: FixtureAttemptStore } = {
    contextId: "fixture-context", tasks,
    workspaces: await TreehouseProvider.open({ treehouse, git, repository, poolRoot: join(dir, "pool"), environment }),
    attempts: new FixtureAttemptStore(tasks.database, "fixture-context"), runtime,
    launch: (input, signal, onRequest) => worker.execute(input, signal, onRequest ? { onRequest } : {}),
    retention: request => checkRetention(git, environment, request),
    repository,
    delivery: {
      baseRef: options.baseRef ?? "main", branchPrefix: "switchboard/", byTaskKind: options.byTaskKind ?? {},
      default: { kind: "code", acceptance: options.acceptance ?? "review_or_integration", requiredEvidence: ["tests"], requiredDeliverables: ["code"] },
    },
  };
  // The same setup as a configuration file, for tests that run Switchboard in a separate process.
  const config = join(dir, "switchboard.json");
  writeFileSync(config, JSON.stringify({
    contextId: "fixture-context", runtimeRoot, databasePath: join(dir, "tasks.db"), tasks: { repo: "fixture" },
    workspaces: { repository, poolRoot: join(dir, "pool") },
    delivery: { baseRef: deps.delivery.baseRef, branchPrefix: deps.delivery.branchPrefix, ...deps.delivery.default, byTaskKind: deps.delivery.byTaskKind },
    worker: {
      piEntrypoint: resolve(import.meta.dirname, "../fixtures/pi-rpc.ts"), provider: "fixture", model: "fixture", runMs: 5000,
      environment: { ...environment, FAKE_PI_SCENARIO: options.scenario ?? "normal", FAKE_PI_LOG: log },
    },
  }));
  // Changes tasks through Switchboard, as an operator would.
  const tasksCli = (args: string[]) => execFileSync(process.execPath, [entrypoint, "task", ...args, "--json", "--config", config], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  // Tasks are given as `task add` arguments and added through the store, without starting a process for each.
  for (const args of [["add", "seed-z9", "Seed", "--repo", "other"], ...(options.tasks ?? [])]) {
    const { positionals: [, id, title], values } = parseArgs({ args, allowPositionals: true, options: { repo: { type: "string" }, body: { type: "string" }, kind: { type: "string" } } });
    await tasks.add({ id: id!, title: title!, ...(values.body === undefined ? {} : { body: values.body }), repo: values.repo ?? null, ...(values.kind === undefined ? {} : { kind: values.kind }) });
  }
  return { dir, deps, tasks, run, runtime, config, environment, tasksCli };
}

export const task = (id: string, body = "Implement the fixture change") => ["add", id, `Task ${id}`, "--repo", "fixture", "--body", body];
