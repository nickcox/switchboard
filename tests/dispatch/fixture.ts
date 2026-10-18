import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AttemptLog } from "../../src/attempts/log.ts";
import type { Dependencies } from "../../src/dispatch/dispatch.ts";
import { onPath } from "../../src/infra/executables.ts";
import type { DeliveryContract } from "../../src/runtime/contracts.ts";
import { PiWorker } from "../../src/runtime/pi/worker.ts";
import { RuntimeRecords } from "../../src/runtime/records.ts";
import { TasksAxiStore } from "../../src/tasks/tasks-axi.ts";
import { checkRetention } from "../../src/workspaces/retention.ts";
import { TreehouseProvider } from "../../src/workspaces/treehouse.ts";

// End to end with real tasks-axi, Treehouse and Git, and the synthetic Pi peer as the worker.
const git = onPath("git");
const treehouse = onPath("treehouse");
const entrypoint = resolve(import.meta.dirname, "../../node_modules/tasks-axi/dist/bin/tasks-axi.js");
const evidence = resolve(import.meta.dirname, "../../.investigation/dispatch-unit");
mkdirSync(evidence, { recursive: true });

export async function fixture(options: { tasks?: string[][]; scenario?: string; acceptance?: DeliveryContract["acceptance"]; baseRef?: string } = {}) {
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

  const file = join(dir, "backlog.md");
  for (const args of [["add", "seed-z9", "Seed", "--repo", "other"], ...(options.tasks ?? [])]) {
    execFileSync(process.execPath, [entrypoint, ...args, "--json", "--backend", "markdown", "--file", file], { env: { PATH: environment.PATH, HOME: home } });
  }
  const runtimeRoot = join(dir, "runtime");
  const runtime = new RuntimeRecords(runtimeRoot);
  const log = join(dir, "requests.jsonl");
  const worker = new PiWorker(runtime, {
    executable: process.execPath, entrypoint: resolve(import.meta.dirname, "../fixtures/pi-rpc.ts"),
    provider: "fixture", model: "fixture", shellTool: "bash", requestMs: 2000, runMs: 5000, stopMs: 600,
    environment: { ...environment, FAKE_PI_SCENARIO: options.scenario ?? "normal", FAKE_PI_LOG: log },
  });
  const tasks = await TasksAxiStore.open({ node: process.execPath, entrypoint, file, repo: "fixture", home });
  const deps: Dependencies = {
    contextId: "fixture-context", tasks,
    workspaces: await TreehouseProvider.open({ treehouse, git, repository, poolRoot: join(dir, "pool"), environment }),
    attempts: new AttemptLog(runtimeRoot, "fixture-context"), runtime,
    launch: (input, signal) => worker.execute(input, signal),
    retention: request => checkRetention(git, environment, request),
    repository,
    delivery: {
      baseRef: options.baseRef ?? "main", branchPrefix: "switchboard/", kind: "code",
      acceptance: options.acceptance ?? "review_or_integration", requiredEvidence: ["tests"], requiredDeliverables: ["code"],
    },
  };
  return { dir, deps, tasks, run, runtime };
}

export const task = (id: string, body = "Implement the fixture change") => ["add", id, `Task ${id}`, "--repo", "fixture", "--body", body];
