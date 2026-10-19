import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { onPath } from "../src/infra/executables.ts";

// Runs the real CLI with a configuration file that points at disposable fixtures and the synthetic Pi peer.
const git = onPath("git");
const cli = resolve(import.meta.dirname, "../src/cli.ts");
const tasksAxi = resolve(import.meta.dirname, "../node_modules/tasks-axi/dist/bin/tasks-axi.js");
const evidence = resolve(import.meta.dirname, "../.investigation/cli-unit");
mkdirSync(evidence, { recursive: true });

function fixture() {
  const dir = realpathSync(mkdtempSync(join(evidence, "case-")));
  const home = join(dir, "home");
  mkdirSync(home);
  const gitEnvironment = {
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Switchboard fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Switchboard fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const environment = { PATH: process.env.PATH ?? "", HOME: home, ...gitEnvironment };
  const repository = join(dir, "repository");
  mkdirSync(repository);
  const run = (args: string[]) => execFileSync(git, ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repository, env: environment, encoding: "utf8" });
  run(["init", "-q", "-b", "main"]);
  writeFileSync(join(repository, "tracked.txt"), "base\n");
  run(["add", "."]);
  // Commits exist only in disposable fixture repositories.
  run(["commit", "-q", "--no-gpg-sign", "-m", "Fixture base"]);
  const file = join(dir, "backlog.md");
  for (const args of [["add", "seed-z9", "Seed", "--repo", "other"], ["add", "cli-a1", "CLI task", "--repo", "fixture", "--body", "Change the fixture"]]) {
    execFileSync(process.execPath, [tasksAxi, ...args, "--json", "--backend", "markdown", "--file", file], { env: environment });
  }
  const config = join(dir, "switchboard.json");
  writeFileSync(config, JSON.stringify({
    contextId: "cli-fixture", runtimeRoot: join(dir, "runtime"),
    tasks: { file, repo: "fixture" },
    workspaces: { repository, poolRoot: join(dir, "pool") },
    delivery: { baseRef: "main", requiredEvidence: ["tests"], requiredDeliverables: ["code"] },
    worker: {
      piEntrypoint: resolve(import.meta.dirname, "fixtures/pi-rpc.ts"), provider: "fixture", model: "fixture", runMs: 5000,
      environment: { ...environment, FAKE_PI_SCENARIO: "commit-result", FAKE_PI_LOG: join(dir, "requests.jsonl") },
    },
  }));
  // The CLI's own Git and Treehouse calls use its environment, so give it the fixture's Git identity too.
  const switchboard = (args: string[]) => spawnSync(process.execPath, [cli, ...args, "--config", config], {
    env: { ...process.env, ...gitEnvironment, HOME: home }, encoding: "utf8",
  });
  return { switchboard };
}

test("dispatch --once and status report the attempt as structured JSON with documented exit codes", async () => {
  const { switchboard } = fixture();
  const before = switchboard(["status", "--json"]);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(JSON.parse(before.stdout).version, 1);
  assert.equal(JSON.parse(before.stdout).reason, "clear");

  const dispatched = switchboard(["dispatch", "--once", "--json", "--request-id", "cli-1"]);
  assert.equal(dispatched.status, 1, dispatched.stderr);
  const report = JSON.parse(dispatched.stdout);
  assert.equal(report.version, 1);
  assert.equal(report.reason, "held");
  assert.equal(report.attempt.taskId, "cli-a1");
  assert.equal(report.lease, "preserved");
  assert.equal(report.nextAction.code, "review_branch");

  const after = switchboard(["status", "--json"]);
  assert.equal(after.status, 1);
  const view = JSON.parse(after.stdout);
  assert.equal(view.version, 1);
  assert.equal(view.reason, "attention");
  assert.equal(view.attempts[0].nextAction.code, "review_branch");
  assert.equal(view.attempts[0].leaseHeld, true);

  const replay = switchboard(["dispatch", "--once", "--json", "--request-id", "cli-1"]);
  assert.equal(JSON.parse(replay.stdout).version, 1);
  assert.equal(JSON.parse(replay.stdout).reason, "existing_request");
  for (const args of [["resolve"], ["stop"], ["steer", "Fixture message"]]) {
    const refused = switchboard([...args, "--lease", "unknown-lease", "--json"]);
    assert.equal(refused.status, 1, refused.stderr);
    const refusal = JSON.parse(refused.stdout);
    assert.equal(refusal.version, 1);
    assert.equal(refusal.reason, "refused");
  }
  const none = switchboard(["dispatch", "--once"]);
  assert.equal(none.status, 0);
  assert.match(none.stdout, /no_ready_work/);
});
