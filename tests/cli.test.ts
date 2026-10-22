import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configSchema } from "../src/config.ts";
import { onPath } from "../src/infra/executables.ts";

// Runs the real CLI with a configuration file that points at disposable fixtures and the synthetic Pi peer.
const git = onPath("git");
const cli = resolve(import.meta.dirname, "../src/cli.ts");
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
  const config = join(dir, "switchboard.json");
  writeFileSync(config, JSON.stringify({
    contextId: "cli-fixture", runtimeRoot: join(dir, "runtime"),
    tasks: { repo: "fixture" },
    workspaces: { repository, poolRoot: join(dir, "pool") },
    delivery: { baseRef: "main", requiredEvidence: ["tests"], requiredDeliverables: ["code"] },
    worker: {
      piEntrypoint: resolve(import.meta.dirname, "fixtures/pi-rpc.ts"), provider: "fixture", model: "fixture", thinking: "high", runMs: 5000,
      environment: { ...environment, FAKE_PI_SCENARIO: "commit-result", FAKE_PI_LOG: join(dir, "requests.jsonl") },
    },
  }));
  // The CLI's own Git and Treehouse calls use its environment, so give it the fixture's Git identity too.
  const switchboard = (args: string[]) => spawnSync(process.execPath, [cli, ...args, "--config", config], {
    env: { ...process.env, ...gitEnvironment, HOME: home }, encoding: "utf8",
  });
  for (const args of [["add", "seed-z9", "Seed", "--repo", "other"], ["add", "cli-a1", "CLI task", "--repo", "fixture", "--body", "Change the fixture"]]) {
    const added = switchboard(["task", ...args, "--json"]);
    assert.equal(added.status, 0, added.stderr);
  }
  return { switchboard, run };
}

test("worker configuration accepts only Pi's thinking levels and leaves the field optional", () => {
  const worker = { piEntrypoint: cli, provider: "fixture", model: "fixture" };
  assert.equal(configSchema.shape.worker.parse(worker).thinking, undefined);
  for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    assert.equal(configSchema.shape.worker.parse({ ...worker, thinking }).thinking, thinking);
  }
  for (const thinking of ["auto", "HIGH", "", null, 1]) {
    assert.equal(configSchema.shape.worker.safeParse({ ...worker, thinking }).success, false);
  }
});

test("--version prints the package version without loading configuration", () => {
  const dir = mkdtempSync(join(evidence, "version-"));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const args of [["--version"], ["--version", "--config", join(dir, "missing.json")]]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: dir, env: { ...process.env, SWITCHBOARD_CONFIG: join(dir, "missing.json") }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${pkg.version}\n`);
    assert.equal(result.stderr, "");
  }
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stderr, /switchboard --version/);
});

test("an option that does not apply to the command is refused before loading configuration", () => {
  // Review finding 16: in particular, --dry-run on a command that changes something must not be ignored.
  for (const args of [
    ["stop", "--lease", "lease-1", "--dry-run"], ["steer", "--lease", "lease-1", "--dry-run", "Message"],
    ["resolve", "--lease", "lease-1", "--worker-stopped", "--dry-run"], ["status", "--task", "cli-a1"],
    ["dispatch", "--once", "--lease", "lease-1"], ["watch", "--lease", "lease-1", "--as", "someone"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args, "--config", "missing.json"], { encoding: "utf8" });
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, /does not take/);
    assert.doesNotMatch(result.stderr, /Configuration error/);
  }
});

test("invalid options print a one-line error and usage without a stack trace", () => {
  const invalid = [
    { args: ["--no-such-option"], problem: /Unknown option '--no-such-option'/ },
    { args: ["--config"], problem: /Option '--config <value>' argument missing/ },
    { args: ["--config", "--json"], problem: /Option '--config' argument is ambiguous/ },
    { args: ["--once=value"], problem: /Option '--once' does not take an argument/ },
  ];
  for (const { args, problem } of invalid) {
    const result = spawnSync(process.execPath, [cli, "dispatch", "--once", ...args], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr.split("\n")[0]!, problem);
    assert.match(result.stderr, /^[^\n]+\n\nUsage:\n/);
    assert.doesNotMatch(result.stderr, /\n\s+at\s|ERR_PARSE_ARGS|Configuration error/);
  }
});

test("resolve validates task and lease selectors before loading configuration", () => {
  const invalid = [
    [], ["--lease-returned"], ["--task", "cli-a1"], ["--task", "cli-a1", "--worker-stopped"],
    ["--lease", "lease-1", "--task", "cli-a1", "--lease-returned"],
    ["--lease", "lease-1", "--attempt", "1", "--lease-returned"],
    ...["0", "-1", "1.5", "bad"].map(n => ["--task", "cli-a1", "--lease-returned", "--attempt", n]),
  ];
  for (const args of invalid) {
    const result = spawnSync(process.execPath, [cli, "resolve", ...args, "--config", "missing.json"], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    assert.doesNotMatch(result.stderr, /Configuration error/);
  }
  const { switchboard } = fixture();
  for (const args of [[], ["--attempt", "1"]]) {
    const result = switchboard(["resolve", "--task", "unknown-task", "--lease-returned", ...args, "--json"]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).reason, "refused");
  }
});

test("finish, discard, watch, stop and steer validate their attempt selectors before loading configuration", () => {
  const invalid = [
    [], ["--lease", "lease-1", "--task", "cli-a1"], ["--lease", "lease-1", "--attempt", "1"], ["--task", ""], ["--lease", ""],
    ...["0", "-1", "1.5", "bad"].map(n => ["--task", "cli-a1", "--attempt", n]),
  ];
  for (const command of ["finish", "discard", "watch", "stop", "steer"]) {
    for (const args of invalid) {
      const result = spawnSync(process.execPath, [cli, command, ...args, ...(command === "steer" ? ["message"] : []), "--config", "missing.json"], { encoding: "utf8" });
      assert.equal(result.status, 2, `${command} ${args.join(" ")}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /Configuration error/);
    }
  }
});

test("finish, discard, watch, stop and steer select a task's attempt by its lease", () => {
  const { switchboard } = fixture();
  const lease = JSON.parse(switchboard(["dispatch", "--once", "--json"]).stdout).attempt.leaseId as string;
  for (const args of [["--task", "cli-a1"], ["--task", "cli-a1", "--attempt", "1"]]) {
    const watched = switchboard(["watch", ...args, "--no-follow", "--json"]);
    assert.equal(watched.status, 0, watched.stderr);
    for (const command of ["finish", "discard"]) {
      const planned = switchboard([command, ...args, "--dry-run", "--json"]);
      assert.equal(planned.status, 0, planned.stdout);
      assert.equal(JSON.parse(planned.stdout).reason, "planned");
    }
  }
  // No dispatcher owns the finished worker, so the request is not delivered, but it was addressed to the attempt's lease.
  for (const args of [["stop"], ["steer", "message"]]) {
    const sent = JSON.parse(switchboard([...args.slice(0, 1), "--task", "cli-a1", ...args.slice(1), "--wait", "0.2", "--json"]).stdout);
    assert.notEqual(sent.stage, "select", JSON.stringify(sent));
    assert.equal(sent.attempt?.leaseId, lease, JSON.stringify(sent));
  }
  for (const args of [["--task", "cli-a1", "--attempt", "2"], ["--task", "unknown-z9"]]) {
    const refused = switchboard(["finish", ...args, "--dry-run", "--json"]);
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(refused.stdout).stage, "select");
  }
});

test("dispatch --once --dry-run supports JSON, explicit selection and readable output", () => {
  const { switchboard } = fixture();
  const preview = switchboard(["dispatch", "--once", "--dry-run", "--task", "cli-a1", "--json"]);
  assert.equal(preview.status, 0, preview.stderr);
  const report = JSON.parse(preview.stdout);
  assert.equal(report.reason, "dry_run");
  assert.equal(report.selection.taskId, "cli-a1");
  assert.equal(report.selection.contract.name, "default");
  const readable = switchboard(["dispatch", "--once", "--dry-run"]);
  assert.equal(readable.status, 0, readable.stderr);
  assert.match(readable.stdout, /Task cli-a1, delivery contract default/);
  const refused = switchboard(["dispatch", "--once", "--dry-run", "--task", "missing-a1", "--json"]);
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).reason, "refused");
  assert.equal(switchboard(["dispatch", "--dry-run"]).status, 2);
});

test("dispatch --once and status report the attempt as structured JSON with documented exit codes", async () => {
  const { switchboard, run } = fixture();
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
  assert.equal(report.nextAction.code, "review_then_finish");

  const after = switchboard(["status", "--json"]);
  assert.equal(after.status, 1);
  const view = JSON.parse(after.stdout);
  assert.equal(view.version, 1);
  assert.equal(view.reason, "attention");
  assert.equal(view.attempts[0].nextAction.code, "review_then_finish");
  assert.equal(view.attempts[0].leaseHeld, true);
  assert.equal(view.attempts[0].thinkingLevel, "high");

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

  run(["remote", "add", "origin", "https://example.invalid/fixture.git"]);
  const resolved = switchboard(["resolve", "--task", "cli-a1", "--attempt", "1", "--lease-returned", "--json"]);
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(JSON.parse(resolved.stdout).reason, "resolved");
  assert.equal(switchboard(["resolve", "--task", "cli-a1", "--lease-returned"]).status, 1);
});

test("finish through the CLI: a dry run plans, work finishes with its lease retained, then confirmation returns it", () => {
  const { switchboard } = fixture();
  const dispatched = JSON.parse(switchboard(["dispatch", "--once", "--json"]).stdout);
  const lease = dispatched.attempt.leaseId as string;
  const planned = switchboard(["finish", "--lease", lease, "--dry-run", "--json"]);
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).reason, "planned");
  assert.match(JSON.parse(planned.stdout).detail, /record the task as done, then retain lease/);
  const retained = switchboard(["finish", "--lease", lease, "--json"]);
  assert.equal(retained.status, 0, retained.stdout);
  assert.equal(JSON.parse(retained.stdout).reason, "finished");
  assert.equal(JSON.parse(retained.stdout).lease, "preserved");
  assert.match(JSON.parse(retained.stdout).detail, new RegExp(`finish --lease ${lease} --no-processes`));
  const returning = switchboard(["finish", "--lease", lease, "--no-processes", "--dry-run", "--json"]);
  assert.equal(returning.status, 0, returning.stdout);
  assert.equal(JSON.parse(returning.stdout).detail, `Would return lease ${lease}`);
  const finished = switchboard(["finish", "--lease", lease, "--no-processes", "--json"]);
  assert.equal(finished.status, 0, finished.stdout);
  assert.equal(JSON.parse(finished.stdout).reason, "finished");
  assert.equal(JSON.parse(finished.stdout).lease, "none");
  for (const args of [["finish", "--lease", lease, "--confirm"], ["discard", "--lease", lease, "--task", "cli-a1"]]) {
    assert.equal(switchboard(args).status, 2, args.join(" "));
  }
});
