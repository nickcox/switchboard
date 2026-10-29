import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Database } from "../../src/database.ts";
import { defaultPermissions } from "../../src/objectives/store.ts";

const cli = resolve("src/cli.ts");
const root = resolve(".investigation/supervise-cli");
mkdirSync(root, { recursive: true });

function fixture() {
  const dir = realpathSync(mkdtempSync(join(root, "case-")));
  const home = join(dir, "home");
  const repository = join(dir, "repository");
  mkdirSync(home);
  mkdirSync(repository);
  const environment = { ...process.env, HOME: home, USER: "operator:spoofed", USERNAME: "operator:spoofed",
    SWITCHBOARD_CALLER: "operator:spoofed", SWITCHBOARD_OBJECTIVE: "other",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Switchboard fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Switchboard fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repository, env: environment, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repository, "base.txt"), "base\n");
  git("add", ".");
  git("commit", "-q", "--no-gpg-sign", "-m", "Fixture base");
  const configPath = join(dir, "switchboard.json");
  const log = join(dir, "requests.jsonl");
  const config = {
    contextId: "supervise-fixture", runtimeRoot: join(dir, "runtime"), tasks: { repo: "fixture" },
    workspaces: { repository, poolRoot: join(dir, "pool") }, maxAttemptsPerTask: 6,
    delivery: { baseRef: "main", byTaskKind: { review: { kind: "artefact", acceptance: "independent_deliverable", requiredDeliverables: ["report"] } } },
    finalisation: { kind: "manual", globalFile: join(dir, "no-policy.json") },
    worker: { piEntrypoint: resolve("tests/fixtures/pi-rpc.ts"), provider: "fixture", model: "fixture", runMs: 20000,
      environment: { ...environment, FAKE_PI_SCENARIO: "commit-result", FAKE_PI_LOG: log } },
  };
  const scenario = (name: string) => {
    config.worker.environment.FAKE_PI_SCENARIO = name;
    writeFileSync(configPath, JSON.stringify(config));
  };
  scenario("commit-result");
  const raw = (...args: string[]) => spawnSync(process.execPath, [cli, ...args, "--config", configPath], { env: environment, encoding: "utf8" });
  const run = (...args: string[]) => {
    const result = raw("supervise", ...args, "--objective", "goal");
    assert.equal(result.stderr.replace(/\(node:\d+\) ExperimentalWarning:[^\n]*\n(?:\(Use[^\n]*\n)?/g, ""), "", result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1, result.stdout);
    return { code: result.status, value: JSON.parse(result.stdout) };
  };
  const ok = (...args: string[]) => {
    const result = run(...args);
    assert.equal(result.code, 0, JSON.stringify(result));
    return result.value;
  };
  const person = (...args: string[]) => {
    const result = raw(...args, "--json");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  person("objective", "add", "goal", "Make the fixture useful", "--criterion", "Useful output");
  person("objective", "add", "other", "Other objective", "--criterion", "Other output");
  person("task", "add", "foreign", "Other task", "--objective", "other");
  person("task", "add", "unlinked", "Unlinked task");
  const rows = async (sql: string, ...args: string[]) => {
    const db = await Database.open(join(config.runtimeRoot, "switchboard.db"));
    try { return db.all(sql, ...args); } finally { db.close(); }
  };
  return { dir, configPath, config, log, environment, git, raw, run, ok, person, scenario, rows };
}

test("supervise task operations bind the objective and record the supervisor for every change", async () => {
  const f = fixture();
  const body = join(f.dir, "body.md");
  const criteria = join(f.dir, "criteria.txt");
  writeFileSync(body, "Instructions\n");
  writeFileSync(criteria, "First\n\nSecond\n");
  assert.equal(f.ok("task", "add", "work", "Work", "--body-file", body, "--criteria-file", criteria).task.objectiveId, "goal");
  f.ok("task", "add", "blocker", "Blocker");
  f.ok("task", "add", "another-repo", "Other repository", "--repo", "other");
  f.ok("task", "update", "work", "--title", "Changed", "--body", "New instructions", "--criterion", "Replacement", "--kind", "code");
  f.ok("task", "hold", "work", "--reason", "Waiting");
  f.ok("task", "release", "work");
  f.ok("task", "block", "work", "--by", "blocker");
  assert.deepEqual(f.ok("task", "show", "work").task.blockedBy, ["blocker"]);
  f.ok("task", "unblock", "work", "--by", "blocker");
  f.ok("task", "done", "work", "--note", "Completed");
  const shown = f.ok("task", "show", "work").task;
  assert.equal(shown.state, "done");
  assert.deepEqual(shown.acceptanceCriteria, ["Replacement"]);
  assert.deepEqual(f.ok("task", "list").tasks.map((task: { id: string }) => task.id), ["work", "blocker", "another-repo"]);
  assert.deepEqual(f.ok("task", "list", "--repo", "fixture").tasks.map((task: { id: string }) => task.id), ["work", "blocker"]);
  assert.deepEqual(f.ok("task", "list", "--state", "done").tasks.map((task: { id: string }) => task.id), ["work"]);
  const changes = await f.rows("SELECT action,changed_by FROM task_changes WHERE task = 'work' ORDER BY sequence");
  assert.deepEqual(changes.map(row => row.action), ["add", "update", "hold", "release", "block", "unblock", "done"]);
  assert.ok(changes.every(row => row.changed_by === "supervisor:goal"));
  assert.equal(f.ok("objective", "show").objective.id, "goal");
  const prefixed = spawnSync(process.execPath, [cli, "--config", f.configPath, "--json", "supervise", "objective", "show", "--objective=goal"], { env: f.environment, encoding: "utf8" });
  assert.equal(prefixed.status, 0, prefixed.stderr);
  assert.equal(JSON.parse(prefixed.stdout).objective.id, "goal");
});

test("supervise note and briefing return one JSON object with current records, without Pi installed", async () => {
  const f = fixture();
  f.config.worker.piEntrypoint = join(f.dir, "missing-pi.js");
  writeFileSync(f.configPath, JSON.stringify(f.config));
  const note = f.ok("note", "Remember the smaller design").note;
  assert.equal(note.writtenBy, "supervisor:goal");
  assert.equal(note.sequence, 1);
  f.ok("note", "Keep all leases for the person");
  f.ok("task", "add", "work", "Work", "--criterion", "Useful output");
  let value = f.ok("briefing");
  assert.equal(value.objective.id, "goal");
  assert.equal(value.tasks.length, 1);
  assert.equal(value.personInterventions.count, 0);
  assert.deepEqual(value.notes.map((item: { text: string }) => item.text), ["Remember the smaller design", "Keep all leases for the person"]);
  f.person("task", "hold", "work", "--reason", "A person's decision");
  value = f.ok("briefing");
  assert.equal(value.tasks[0].holdReason, "A person's decision");
  assert.equal(value.personInterventions.count, 1);
  assert.deepEqual(value.personInterventions, f.person("objective", "show", "goal").objective.personInterventions);
  assert.deepEqual(value.personInterventions, f.ok("objective", "show").objective.personInterventions);
  for (const args of [["note"], ["note", ""], ["note", "   "], ["note", "First", "Second"], ["briefing", "extra"], ["briefing", "--task", "work"], ["note", "Text", "--as", "operator:admin"]]) {
    assert.equal(f.run(...args).code, 2);
  }
  assert.equal((await f.rows("SELECT * FROM supervisor_notes")).length, 2);
});

test("supervise rejects every unavailable operation and identity or objective override before any change", async () => {
  const f = fixture();
  f.ok("task", "add", "work", "Work");
  const before = await f.rows("SELECT name,sql FROM sqlite_master ORDER BY name");
  const tasks = await f.rows("SELECT * FROM tasks ORDER BY id");
  const changes = await f.rows("SELECT * FROM task_changes ORDER BY sequence");
  const objectives = await f.rows("SELECT * FROM objectives ORDER BY id");
  const history = await f.rows("SELECT * FROM objective_changes ORDER BY sequence");
  for (const args of [
    ["discard", "--task", "work", "--confirm", "--no-processes"], ["resolve", "--task", "work", "--lease-returned"],
    ["prune", "--older-than", "1"], ["cleanup-output-branches"], ["import", "--attempts"],
    ["finish", "--task", "work", "--no-processes"],
    ...["add", "update", "confirm-budget", "abandon", "reopen", "list"].map(action => ["objective", action]),
    ["task", "reopen", "work"], ["task", "ready"], ["task", "convert-criteria"], ["status"], ["watch", "--task", "work"],
    ["task", "update", "work", "--clear-objective"], ["task", "update", "work", "--objective", "other"],
    ["task", "add", "injected", "Injected", "--objective", "other"],
    ["objective", "show", "other"], ["objective", "complete", "other", "--statements-file", "missing.json"],
    ["task", "add", "injected", "Injected", "--caller", "operator:admin"], ["task", "add", "injected", "Injected", "--as", "operator:admin"],
    ["dispatch", "--once", "--task", "work"], ["stop", "--task", "work", "--dry-run"],
  ]) {
    const result = f.run(...args);
    assert.equal(result.code, 2, `${args.join(" ")}: ${JSON.stringify(result)}`);
    assert.equal(result.value.ok, false);
  }
  assert.deepEqual(await f.rows("SELECT name,sql FROM sqlite_master ORDER BY name"), before);
  assert.deepEqual(await f.rows("SELECT * FROM tasks ORDER BY id"), tasks);
  assert.deepEqual(await f.rows("SELECT * FROM task_changes ORDER BY sequence"), changes);
  assert.deepEqual(await f.rows("SELECT * FROM objectives ORDER BY id"), objectives);
  assert.deepEqual(await f.rows("SELECT * FROM objective_changes ORDER BY sequence"), history);
  assert.deepEqual(await f.rows("SELECT * FROM attempts"), []);
  assert.deepEqual(await f.rows("SELECT * FROM confirmations"), []);
  assert.deepEqual(await f.rows("SELECT * FROM control_requests"), []);
});

test("usage and configuration errors are one JSON object with the ordinary exit code", () => {
  for (const args of [[], ["task", "list"], ["task", "list", "--objective"], ["task", "list", "--objective", "goal", "--unknown"],
    ["task", "list", "--objective", "goal", "--objective", "other"], ["dispatch", "--objective", "goal"],
    ["dispatch", "--objective", "goal", "--task", "work", "--from-attempt", "0"],
    ["finish", "--objective", "goal", "--task", "work", "--lease", "lease"],
    ["stop", "--objective", "goal", "--task", "work", "--attempt", "bad"],
    ["answer", "--objective", "goal", "--task", "work", "--question", "q", "", "--wait", "0"],
    ["task", "list", "--objective", "goal", "--state", "bad"],
    ["task", "list", "--objective", "goal", "--json=value"],
    ["objective", "show", "--objective", "goal"],
  ]) {
    const result = spawnSync(process.execPath, [cli, "supervise", ...args, "--config", join(root, "missing-config.json")], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.equal(result.stderr, "");
  }
});

test("supervise passes through existing scope and permission refusals, including for reads", async () => {
  const f = fixture();
  f.ok("task", "add", "work", "Work");
  for (const task of ["foreign", "unlinked"]) {
    const dispatched = f.raw("dispatch", "--once", "--task", task, "--json");
    assert.equal(JSON.parse(dispatched.stdout).reason, "held", dispatched.stderr + dispatched.stdout);
  }
  const foreign = await f.rows("SELECT * FROM tasks WHERE id IN ('foreign','unlinked') ORDER BY id");
  for (const task of ["foreign", "unlinked"]) {
    for (const args of [["show"], ["update", "--title", "No"], ["hold", "--reason", "No"], ["release"], ["block", "--by", "work"], ["unblock", "--by", "work"], ["done"]]) {
      const result = f.run("task", args[0]!, task, ...args.slice(1));
      assert.equal(result.code, 1);
      assert.match(result.value.detail, /outside_objective/);
    }
    for (const args of [["dispatch", "--dry-run"], ["review"], ["answer", "--question", "unknown", "No"], ["finish"], ["steer", "No"], ["stop"]]) {
      const result = f.run(...args, "--task", task);
      assert.equal(result.code, 1, JSON.stringify(result));
      assert.match(result.value.detail, /outside_objective/);
    }
  }
  const permissions = join(f.dir, "permissions.json");
  writeFileSync(permissions, JSON.stringify(Object.fromEntries(Object.keys(defaultPermissions).map(key => [key, false]))));
  f.person("objective", "update", "goal", "--permissions-file", permissions);
  const statements = join(f.dir, "statements.json");
  writeFileSync(statements, JSON.stringify([{ position: 1, statement: "Claim", references: [{ kind: "accepted_commit", contextId: "supervise-fixture", taskId: "work", attempt: 1, commit: "a".repeat(40) }] }]));
  for (const args of [["task", "add", "denied", "Denied"], ["task", "update", "work", "--title", "Denied"], ["task", "done", "work"],
    ["dispatch", "--task", "work", "--dry-run"], ["review", "--task", "work"], ["answer", "--task", "work", "--question", "q", "No"],
    ["objective", "complete", "--statements-file", statements]]) {
    const result = f.run(...args);
    assert.equal(result.code, 1, JSON.stringify(result));
    assert.match(result.value.detail, /permission_denied/);
  }
  assert.equal(f.ok("task", "show", "work").task.id, "work", "Read-only inspection does not need manageTasks");
  assert.equal(f.ok("task", "list").tasks.length, 1);
  assert.deepEqual(await f.rows("SELECT * FROM tasks WHERE id IN ('foreign','unlinked') ORDER BY id"), foreign);
});

test("unknown and closed objectives refuse all operations with one JSON object", () => {
  const f = fixture();
  for (const state of ["missing", "abandoned"]) {
    if (state === "abandoned") f.person("objective", "abandon", "goal");
    for (const args of [["briefing"], ["note", "Remember"], ["objective", "show"], ["task", "add", "no", "No"], ["task", "list"], ["dispatch", "--task", "foreign"], ["finish", "--task", "foreign"]]) {
      const result = f.raw("supervise", ...args, "--objective", state === "missing" ? "missing" : "goal");
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const value = JSON.parse(result.stdout);
      assert.equal(value.ok, false);
      assert.match(value.detail, state === "missing" ? /does not exist/ : /abandoned/);
    }
  }
});

test("dispatch, continuation, review, finish and completion record the fixed supervisor actor", async () => {
  const f = fixture();
  f.ok("task", "add", "work", "Work", "--criterion", "Working output");
  const dry = f.ok("dispatch", "--task", "work", "--dry-run", "--request-id", "initial");
  assert.equal(dry.reason, "dry_run");
  assert.deepEqual(await f.rows("SELECT * FROM attempts"), []);
  const initial = f.run("dispatch", "--task", "work", "--request-id", "initial");
  assert.equal(initial.code, 1);
  assert.equal(initial.value.reason, "held");
  const replay = f.run("dispatch", "--task", "work", "--request-id", "initial");
  assert.equal(replay.code, 1);
  assert.equal(replay.value.reason, "existing_request");
  f.ok("task", "release", "work");
  const note = join(f.dir, "note.txt");
  writeFileSync(note, "Repair from kept output");
  assert.equal(f.ok("dispatch", "--task", "work", "--from-attempt", "1", "--note-file", note, "--dry-run").reason, "dry_run");
  const continued = f.run("dispatch", "--task", "work", "--from-attempt", "1", "--note-file", note, "--request-id", "repair");
  assert.equal(continued.value.reason, "held", JSON.stringify(continued));
  assert.equal(continued.value.attempt.attempt, 2);
  const unsafe = f.run("finish", "--task", "work", "--attempt", "2", "--accept-output");
  assert.equal(unsafe.code, 1);
  assert.match(unsafe.value.detail, /review/);
  const review = f.ok("review", "--task", "work", "--attempt", "2");
  assert.equal(f.ok("task", "show", review.task.id).task.objectiveId, "goal");
  const reviewChanges = await f.rows("SELECT changed_by FROM task_changes WHERE task = ?", review.task.id);
  assert.ok(reviewChanges.length > 0);
  assert.ok(reviewChanges.every(row => row.changed_by === "supervisor:goal"));
  f.scenario("review-pass");
  assert.equal(f.run("dispatch", "--task", review.task.id).value.reason, "held");
  const planned = f.ok("finish", "--task", "work", "--attempt", "2", "--dry-run");
  assert.equal(planned.reason, "planned");
  const finished = f.ok("finish", "--task", "work", "--attempt", "2", "--accept-output");
  assert.equal(finished.reason, "finished");
  assert.equal(finished.lease, "preserved");
  const entries = (await f.rows("SELECT entry FROM attempt_entries WHERE task = 'work' ORDER BY sequence")).map(row => JSON.parse(String(row.entry)));
  assert.ok(entries.length > 0);
  assert.ok(entries.every(entry => entry.askedBy === "supervisor:goal"));
  const confirmations = await f.rows("SELECT * FROM confirmations WHERE task = 'work'");
  assert.ok(confirmations.length > 0);
  assert.ok(confirmations.every(row => row.confirmed_by === "supervisor:goal"));
  assert.ok(confirmations.every(row => row.fact !== "no_processes" && row.fact !== "lease_returned"));
  assert.equal(f.person("finish", "--task", "work", "--attempt", "2", "--no-processes").lease, "none");
  const objective = f.ok("objective", "show").objective;
  assert.equal(objective.personInterventions.count, 0, "The person's mandatory lease return is not an intervention in the work");
  assert.equal(objective.personInterventions.leaseReturns.count, 1);
  const statements = join(f.dir, "statements.json");
  writeFileSync(statements, JSON.stringify([{ position: 1, statement: "The accepted output meets the criterion", references: objective.availableReferences }]));
  assert.equal(f.ok("objective", "complete", "--statements-file", statements).objective.state, "completed");
  const history = await f.rows("SELECT changed_by FROM objective_changes WHERE objective = 'goal' AND action = 'complete'");
  assert.deepEqual(history.map(row => row.changed_by), ["supervisor:goal"]);
  for (const args of [["objective", "show"], ["task", "list"], ["dispatch", "--task", "work"], ["finish", "--lease", initial.value.attempt.leaseId]]) {
    const refused = f.run(...args);
    assert.equal(refused.code, 1);
    assert.match(refused.value.detail, /completed/);
  }
});

for (const operation of ["steer", "stop", "answer"] as const) test(`${operation} records the supervisor, never a supplied display label or environment identity`, async () => {
  const f = fixture();
  f.ok("task", "add", "work", "Work");
  f.scenario(operation === "answer" ? "await-question" : "await-steer");
  const child = execFile(process.execPath, [cli, "supervise", "dispatch", "--task", "work", "--objective", "goal", "--config", f.configPath], { env: f.environment });
  const completed = new Promise<{ code: number | string | null; stdout: string; stderr: string }>(resolve => child.on("close", code => resolve({ code, stdout, stderr })));
  let stdout = "", stderr = "";
  child.stdout!.on("data", data => { stdout += data; });
  child.stderr!.on("data", data => { stderr += data; });
  try {
    let ready = false;
    for (let i = 0; i < 400; i++) {
      if (operation === "answer") ready = (await f.rows("SELECT * FROM question_files WHERE document IS NOT NULL")).length > 0;
      else ready = existsSync(f.log) && readFileSync(f.log, "utf8").includes('"type":"prompt"');
      if (ready) break;
      await sleep(25);
    }
    assert.ok(ready, `The synthetic worker must start: ${stderr}`);
    const permissions = join(f.dir, "permissions.json");
    const permission = operation === "answer" ? "answerQuestions" : operation === "steer" ? "steerWorkers" : "stopWorkers";
    writeFileSync(permissions, JSON.stringify({ ...defaultPermissions, [permission]: false }));
    f.person("objective", "update", "goal", "--permissions-file", permissions);
    const question = operation === "answer" ? (await f.rows("SELECT id FROM question_files WHERE document IS NOT NULL"))[0]!.id as string : undefined;
    const args = operation === "answer" ? ["--question", question!, "Use the smaller design"] : operation === "steer" ? ["--as", "operator:admin", "Finish now"] : ["--as", "operator:admin"];
    const refused = f.run(operation, "--task", "work", ...args, "--wait", "5");
    assert.equal(refused.code, 1);
    assert.match(refused.value.detail, /permission_denied/);
    writeFileSync(permissions, JSON.stringify(defaultPermissions));
    f.person("objective", "update", "goal", "--permissions-file", permissions);
    f.ok(operation, "--task", "work", ...args, "--wait", "5");
    await completed;
    assert.equal(JSON.parse(stdout).reason, "held", stderr + stdout);
    if (operation === "answer") {
      assert.deepEqual((await f.rows("SELECT answered_by FROM question_answers")).map(row => row.answered_by), ["supervisor:goal"]);
    } else {
      const requests = (await f.rows("SELECT request FROM control_requests")).map(row => JSON.parse(String(row.request)));
      assert.equal(requests.length, 1);
      assert.equal(requests[0].sender, "supervisor:goal");
      assert.equal(requests[0].label, "operator:admin");
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGINT");
    await completed;
  }
});
