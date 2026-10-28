import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultPermissions } from "../../src/objectives/store.ts";
import { SqliteTaskStore, AttemptStore } from "../caller.ts";
import { specificationFor } from "../helpers.ts";

const cli = resolve("src/cli.ts");
async function fixture() {
  const root = resolve(".investigation/objective-commands");
  await mkdir(root, { recursive: true });
  const dir = await realpath(await mkdtemp(join(root, "case-")));
  const config = join(dir, "switchboard.json");
  const path = join(dir, "runtime", "switchboard.db");
  await writeFile(config, JSON.stringify({ contextId: "fixture", runtimeRoot: join(dir, "runtime"), tasks: { repo: "fixture" },
    workspaces: { repository: join(dir, "repository"), poolRoot: join(dir, "pool") }, delivery: { baseRef: "main" },
    worker: { piEntrypoint: cli, provider: "fixture", model: "fixture" } }));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args, "--config", config], { encoding: "utf8" });
  const json = (...args: string[]) => {
    const result = run(...args, "--json");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  return { dir, path, config, run, json };
}

test("objective CLI creates, shows, lists, updates, abandons and reopens without worker preflight", async () => {
  const f = await fixture();
  const request = "Please do exactly this\nIn my words.\n";
  const requestFile = join(f.dir, "request.txt");
  const criteriaFile = join(f.dir, "criteria.txt");
  const permissionsFile = join(f.dir, "permissions.json");
  const budgetFile = join(f.dir, "budget.json");
  await writeFile(requestFile, request);
  await writeFile(criteriaFile, "First\r\n\r\nSecond\r\n");
  await writeFile(permissionsFile, JSON.stringify({ ...defaultPermissions, dispatch: false }));
  await writeFile(budgetFile, JSON.stringify({ maxCost: 12.5, maxWorkerTimeMs: 120000 }));
  const added = f.json("objective", "add", "goal", "--request-file", requestFile, "--criteria-file", criteriaFile).objective;
  assert.equal(added.request, request);
  assert.equal(added.createdBy, `operator:${userInfo().username}`);
  assert.deepEqual(added.acceptanceCriteria, ["First", "Second"]);
  assert.deepEqual(f.json("objective", "list").objectives.map((o: { id: string }) => o.id), ["goal"]);
  assert.equal(f.json("objective", "list", "--state", "completed").objectives.length, 0);
  f.json("objective", "update", "goal", "--scope", "This project", "--constraints", "No publishing", "--criterion", "Replacement",
    "--permissions-file", permissionsFile, "--budget-file", budgetFile, "--deadline", "2026-10-29T00:00:00+11:00");
  const shown = f.json("objective", "show", "goal").objective;
  assert.equal(shown.scope, "This project");
  assert.equal(shown.constraints, "No publishing");
  assert.deepEqual(shown.criteria, [{ position: 1, criterion: "Replacement", completion: null }]);
  assert.equal(shown.permissions.dispatch, false);
  assert.deepEqual(shown.budget, { maxCost: 12.5, maxWorkerTimeMs: 120000 });
  assert.equal(shown.history[1].changedBy, `operator:${userInfo().username}`);
  assert.deepEqual(shown.history[1].changes.scope, { before: "", after: "This project" });
  assert.equal(f.json("objective", "update", "goal", "--clear-deadline").objective.deadline, null);
  assert.equal(f.json("objective", "abandon", "goal").objective.state, "abandoned");
  assert.equal(f.json("objective", "list", "--state", "open").objectives.length, 0);
  assert.equal(f.run("objective", "update", "goal", "--scope", "No", "--json").status, 1);
  assert.equal(f.json("objective", "reopen", "goal").objective.state, "open");
  assert.match(f.run("objective", "show", "goal").stdout, /Replacement[\s\S]*permissions[\s\S]*maxCost/);
  const prefixed = spawnSync(process.execPath, [cli, "--config", f.config, "--json", "objective", "list"], { encoding: "utf8" });
  assert.equal(prefixed.status, 0, prefixed.stderr);
  assert.equal(JSON.parse(prefixed.stdout).objectives.length, 1);
  for (const args of [["show", "missing"], ["add", "goal", "Duplicate", "--criterion", "Criterion"], ["update", "goal", "--deadline", "bad"]]) {
    const result = f.run("objective", ...args, "--json");
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(JSON.parse(result.stdout).reason, "rejected");
  }
});

test("task CLI links and clears objectives with definition revisions; complete consumes checked statements", async () => {
  const f = await fixture();
  f.json("objective", "add", "goal", "A person's request", "--criterion", "Make it work");
  const added = f.json("task", "add", "work", "Work", "--objective", "goal").task;
  assert.equal(added.objectiveId, "goal");
  assert.equal(added.definitionRevision, 1);
  assert.equal(f.json("task", "update", "work", "--clear-objective").task.definitionRevision, 2);
  const linked = f.json("task", "update", "work", "--objective", "goal").task;
  assert.equal(linked.objectiveId, "goal");
  assert.equal(linked.definitionRevision, 3);
  const tasks = await SqliteTaskStore.open({ path: f.path });
  const attempts = new AttemptStore(tasks.database, "fixture");
  const { ref } = await attempts.reserveAttempt({ taskId: "work", requested: {}, maximum: 1, specification: specificationFor });
  const commit = "c".repeat(40);
  await attempts.appendConfirmed(ref, "output_accepted", { commit }, { fact: "output_accepted", scope: { commit } });
  tasks.close();
  const file = join(f.dir, "completion.json");
  await writeFile(file, JSON.stringify([{ position: 1, statement: "It works", references: [] }]));
  assert.equal(f.run("objective", "complete", "goal", "--statements-file", file, "--json").status, 1);
  const shown = f.json("objective", "show", "goal").objective;
  assert.equal(shown.tasks[0].id, "work");
  assert.equal(shown.tasks[0].latestAttempts[0].attempt, 1);
  await writeFile(file, JSON.stringify([{ position: 1, statement: "The accepted commit implements it", references: shown.availableReferences }]));
  assert.equal(f.json("objective", "complete", "goal", "--statements-file", file).objective.state, "completed");
  assert.equal(f.json("objective", "show", "goal").objective.criteria[0].completion.references[0].commit, commit);
  assert.equal(f.run("task", "update", "work", "--clear-objective", "--json").status, 1);
  f.json("objective", "reopen", "goal");
  assert.equal(f.json("task", "update", "work", "--clear-objective").task.objectiveId, null);
});

test("objective and task-link usage errors refuse before reading configuration", () => {
  for (const args of [["objective"], ["objective", "unknown"], ["objective", "show"], ["objective", "add", "goal"],
    ["objective", "add", "goal", "Request", "--request-file", "request"], ["objective", "list", "extra"], ["objective", "list", "--state", "bad"],
    ["objective", "update", "goal", "--criterion", "A", "--criteria-file", "criteria"], ["objective", "update", "goal", "--deadline", "date", "--clear-deadline"],
    ["objective", "update", "goal", "--state", "abandoned"], ["objective", "complete", "goal"],
    ["task", "update", "work", "--objective", "goal", "--clear-objective"]]) {
    const result = spawnSync(process.execPath, [cli, ...args, "--config", "missing.json"], { encoding: "utf8" });
    assert.equal(result.status, 2, args.join(" ") + result.stderr);
    assert.match(result.stderr, /Usage:/);
  }
});
