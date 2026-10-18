import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AttemptLog } from "../../src/attempts/log.ts";
import { dispatchOnce, type Dependencies } from "../../src/dispatch/dispatch.ts";
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

async function fixture(options: { tasks?: string[][]; scenario?: string; acceptance?: DeliveryContract["acceptance"]; baseRef?: string } = {}) {
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

const task = (id: string, body = "Implement the fixture change") => ["add", id, `Task ${id}`, "--repo", "fixture", "--body", body];

test("no ready work is a successful no-op", async () => {
  const { deps } = await fixture();
  const outcome = await dispatchOnce(deps);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reason, "no_ready_work");
  assert.equal(outcome.lease, "none");
});

test("completed code work is held for review, retained on its branch, and the lease is preserved", async () => {
  const { deps, tasks, run } = await fixture({ tasks: [task("work-a1")], scenario: "commit-result" });
  const outcome = await dispatchOnce(deps);
  assert.equal(outcome.reason, "held_review_required", JSON.stringify(outcome, null, 2));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.lease, "preserved");
  assert.equal(outcome.retention?.retained, true);
  assert.equal(outcome.attempt?.outputBranch, "switchboard/work-a1/attempt-1");
  assert.equal(run(["rev-parse", "refs/heads/switchboard/work-a1/attempt-1"]), outcome.attempt?.resultCommit);
  const held = await tasks.read("work-a1");
  assert.equal(held?.state, "queued");
  assert.equal(held?.held, true);
  assert.equal(held?.holdReason, "Switchboard attempt 1 review required");
  assert.ok(held?.body.startsWith("Implement the fixture change\n\n## Switchboard attempt 1"));
  assert.ok(held?.body.includes(outcome.attempt!.resultCommit!));
  const entries = (await deps.attempts.forTask("work-a1"))[0]!.entries.map(e => e.kind);
  assert.deepEqual(entries, ["requested", "leased", "task_started", "launched", "worker_finished", "retention_checked", "task_recorded"]);
  assert.equal((await deps.workspaces.leases()).filter(l => l.holder === "work-a1").length, 1);
});

test("an independent deliverable that is retained is recorded as done", async () => {
  const { deps, tasks } = await fixture({ tasks: [task("done-a1")], scenario: "commit-result", acceptance: "independent_deliverable" });
  const outcome = await dispatchOnce(deps);
  assert.equal(outcome.reason, "done", JSON.stringify(outcome, null, 2));
  assert.equal(outcome.ok, true);
  assert.equal((await tasks.read("done-a1"))?.state, "done");
  assert.equal(outcome.lease, "preserved");
});

test("a reported commit that is not on the output branch is held as not retained", async () => {
  // The default synthetic worker reports a commit ID that does not exist.
  const { deps, tasks } = await fixture({ tasks: [task("ghost-a1")], acceptance: "independent_deliverable" });
  const outcome = await dispatchOnce(deps);
  assert.equal(outcome.reason, "held_not_retained");
  assert.equal(outcome.retention?.retained, false);
  assert.equal((await tasks.read("ghost-a1"))?.held, true);
});

test("a worker with no valid result is held as failed", async () => {
  const { deps, tasks } = await fixture({ tasks: [task("fail-a1")], scenario: "missing-result" });
  const outcome = await dispatchOnce(deps);
  assert.equal(outcome.reason, "held_worker_failed");
  assert.equal(outcome.worker?.status, "failed");
  assert.equal((await tasks.read("fail-a1"))?.holdReason, "Switchboard attempt 1 failed");
});

test("a held task is not dispatched again, and naming it explicitly is refused because of its lease", async () => {
  const { deps } = await fixture({ tasks: [task("again-a1")], scenario: "commit-result" });
  await dispatchOnce(deps);
  assert.equal((await dispatchOnce(deps)).reason, "no_ready_work");
  assert.equal((await dispatchOnce(deps, { taskId: "again-a1" })).reason, "task_has_lease");
});

test("a repeated request ID returns the existing attempt without dispatching again", async () => {
  const { deps } = await fixture({ tasks: [task("req-a1"), task("req-b1")], scenario: "commit-result" });
  const first = await dispatchOnce(deps, { requestId: "request-1" });
  const again = await dispatchOnce(deps, { requestId: "request-1" });
  assert.equal(again.reason, "existing_request");
  assert.equal(again.attempt?.taskId, first.attempt?.taskId);
  assert.equal(again.attempt?.leaseId, first.attempt?.leaseId);
  assert.equal((await deps.workspaces.leases()).length, 1);
});

test("an attempt whose worker may still be running blocks all dispatch", async () => {
  const { deps, runtime, dir } = await fixture({ tasks: [task("next-a1")] });
  const workspace = join(dir, "orphan-workspace");
  mkdirSync(workspace);
  // A runtime binding with no exit record, as left by a dispatcher that died after launching a worker.
  await runtime.reserve({
    identity: { contextId: "fixture-context", taskId: "earlier-a1", leaseId: "lease-x", sessionId: randomUUID() },
    workspace, instructions: "Earlier", acceptanceCriteria: [],
    delivery: { baseRef: "main", startingCommit: "a".repeat(40), outputBranch: "o", kind: "code", acceptance: "review_or_integration", requiredEvidence: [], requiredDeliverables: [] },
  });
  const outcome = await dispatchOnce(deps);
  assert.equal(outcome.reason, "attempt_may_be_running");
  assert.equal(outcome.nextAction.code, "stop_worker");
  assert.deepEqual(await deps.attempts.forTask("next-a1"), []);
});

test("a refused lease leaves the task unchanged and records why the attempt stopped", async () => {
  const { deps, tasks } = await fixture({ tasks: [task("refused-a1")], baseRef: "missing-base" });
  const outcome = await dispatchOnce(deps);
  assert.equal(outcome.reason, "lease_refused");
  assert.equal(outcome.lease, "none");
  const unchanged = await tasks.read("refused-a1");
  assert.equal(unchanged?.state, "queued");
  assert.equal(unchanged?.held, false);
  assert.deepEqual((await deps.attempts.forTask("refused-a1"))[0]!.entries.map(e => e.kind), ["requested", "halted"]);
});
