import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Database } from "../../src/database.ts";
import { onPath } from "../../src/infra/executables.ts";
import { defaultPermissions } from "../../src/objectives/store.ts";
import type { KeepAwake } from "../../src/runtime/keep-awake.ts";

const cli = resolve("src/cli.ts");
const root = resolve(".investigation/supervise-cli");
mkdirSync(root, { recursive: true });
const cleanups: (() => Promise<void>)[] = [];

test("supervisor asks the person; status, objective show and briefing expose it, and an answer reaches wait", async () => {
  const f = fixture();
  const question = f.ok("ask", "Which design?", "--choice", "Small", "--choice", "Large", "--request-id", "design").question;
  assert.equal(question.askedBy, "supervisor:goal");
  assert.deepEqual(question.choices, ["Small", "Large"]);
  assert.deepEqual(f.ok("ask", "Which design?", "--choice", "Small", "--choice", "Large", "--request-id", "design").question, question);
  assert.equal(f.run("ask", "Different?", "--request-id", "design").code, 1);
  assert.equal(f.run("ask", " ").code, 1);
  assert.equal(f.run("objective", "answer", "--question", question.id, "Small").code, 2);
  assert.deepEqual(f.ok("briefing").openPersonQuestions, [question]);
  assert.deepEqual(f.person("objective", "show", "goal").objective.openPersonQuestions, [question]);
  const jsonStatus = f.raw("status", "--json");
  assert.deepEqual(JSON.parse(jsonStatus.stdout).openPersonQuestions, [question]);
  const textStatus = f.raw("status");
  assert.match(textStatus.stdout, /Open person question.*objective goal – Which design\?/);
  assert.ok(textStatus.stdout.includes(`switchboard objective answer goal --question ${question.id}`));
  assert.match(textStatus.stdout, /Choices: Small; Large/);
  const wrong = f.raw("objective", "answer", "other", "--question", question.id, "Small", "--json");
  assert.equal(wrong.status, 1);
  assert.match(JSON.parse(wrong.stdout).detail, /Unknown question/);
  const answered = f.person("objective", "answer", "goal", "--question", question.id, "Small").question;
  assert.equal(answered.answer.text, "Small");
  assert.match(answered.answer.answeredBy, /^operator:/);
  const repeat = f.raw("objective", "answer", "goal", "--question", question.id, "Large", "--json");
  assert.equal(repeat.status, 1);
  assert.match(JSON.parse(repeat.stdout).detail, /already answered.*Small/);
  const briefing = f.ok("briefing");
  assert.deepEqual(briefing.openPersonQuestions, []);
  const intervention = briefing.personInterventions.items.find((item: { source: string }) => item.source === "person_answers");
  assert.equal(intervention.action, "answer");
  assert.equal(intervention.details.questionId, question.id);
  let event = f.ok("wait", "--timeout", "0").event;
  while (event && event.kind !== "person_answered") {
    f.ok("handled", event.id);
    event = f.ok("wait", "--timeout", "0").event;
  }
  assert.equal(event.kind, "person_answered");
  assert.equal(event.details.questionId, question.id);
  assert.equal(event.details.answer.text, "Small");
  assert.deepEqual(JSON.parse(f.raw("status", "--json").stdout).openPersonQuestions, []);
});

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for detached dispatch");
    await sleep(25);
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

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
    workspaces: { repository, poolRoot: join(dir, "pool") }, maxAttemptsPerTask: 6, keepAwake: false as KeepAwake,
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
  const finished = async (requestId: string) => {
    let value: unknown;
    await until(async () => {
      const row = (await rows("SELECT result FROM supervisor_dispatches WHERE request_id = ?", requestId))[0];
      if (!row?.result) return false;
      value = JSON.parse(String(row.result));
      return true;
    });
    return value as ReturnType<typeof run>["value"];
  };
  const f = { dir, configPath, config, log, environment, git, raw, run, ok, person, scenario, rows, finished };
  cleanups.push(async () => {
    for (const row of await rows("SELECT process_pid, result FROM supervisor_dispatches WHERE process_pid IS NOT NULL")) {
      const pid = Number(row.process_pid);
      if (row.result === null && alive(pid)) process.kill(pid, "SIGTERM");
      await until(() => !alive(pid));
    }
  });
  return f;
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

test("supervise wait reoffers unhandled events across processes and handled persists the position", async () => {
  const f = fixture();
  f.ok("task", "add", "work", "Work");
  assert.deepEqual(f.ok("wait", "--timeout", "0"), { ok: true, action: "wait", event: null, timedOut: true });
  f.person("task", "hold", "work", "--reason", "A person's decision");
  const first = f.ok("wait", "--timeout", "1");
  assert.equal(first.event.kind, "person_intervention");
  assert.equal(first.event.taskId, "work");
  assert.deepEqual(f.ok("wait", "--timeout", "0"), first, "Each call is a new process; reading does not acknowledge an event");
  assert.deepEqual(f.ok("briefing").events, { count: 1, first: first.event });
  f.person("task", "release", "work");
  assert.equal(f.ok("briefing").events.count, 2);
  const later = (await f.rows("SELECT id FROM supervisor_events WHERE objective = 'goal' AND sequence = 2"))[0]!.id;
  assert.equal(f.run("handled", String(later)).code, 1);
  assert.equal(f.run("handled", "unknown").code, 1);
  const foreign = (await f.rows("SELECT id FROM supervisor_events WHERE objective = 'other'"))[0]!.id;
  assert.equal(f.run("handled", String(foreign)).code, 1);
  assert.deepEqual(f.ok("handled", first.event.id).event, first.event);
  assert.deepEqual(f.ok("handled", first.event.id).event, first.event);
  assert.equal(f.ok("wait", "--timeout", "0").event.id, later);
  f.ok("handled", String(later));
  assert.deepEqual(f.ok("briefing").events, { count: 0, first: null });
  assert.equal(f.ok("wait", "--timeout", "0.01").timedOut, true);
  for (const args of [["wait", "--timeout", "-1"], ["wait", "--timeout", "NaN"], ["wait", "--timeout", "Infinity"], ["wait", "--timeout", ""], ["wait", "extra"], ["handled"], ["handled", first.event.id, "extra"], ["handled", first.event.id, "--timeout", "1"]]) {
    assert.equal(f.run(...args).code, 2);
  }
});

test("supervise wait without a timeout polls for an event written by another process", { timeout: 10000 }, async () => {
  const f = fixture();
  f.ok("task", "add", "work", "Work");
  let output = "";
  const child = execFile(process.execPath, [cli, "supervise", "wait", "--objective", "goal", "--config", f.configPath], { env: f.environment, timeout: 5000 });
  child.stdout!.on("data", data => { output += data; });
  const completed = new Promise<number | null>(resolve => child.on("close", resolve));
  try {
    await sleep(300);
    assert.equal(output, "", "No result is printed before an event arrives");
    assert.equal(child.exitCode, null);
    f.person("task", "hold", "work", "--reason", "A person intervened");
    assert.equal(await completed, 0);
    assert.equal(output.trim().split("\n").length, 1);
    const value = JSON.parse(output);
    assert.equal(value.event.kind, "person_intervention");
    assert.equal(value.event.details.action, "hold");
    assert.equal(value.timedOut, false);
    assert.equal(f.ok("wait", "--timeout", "0").event.id, value.event.id);
  } finally {
    if (child.exitCode === null) child.kill();
    await completed;
  }
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
  assert.equal(f.ok("task", "show", "work").task.id, "work", "Read-only inspection does not need a mutation permission");
  assert.equal(f.ok("task", "list").tasks.length, 1);
  const note = f.ok("note", "Continue from the records even with no task permissions").note;
  const briefing = f.ok("briefing");
  assert.deepEqual(briefing.notes, [note]);
  assert.deepEqual(briefing.tasks.map((task: { id: string }) => task.id), ["work"]);
  assert.ok(Object.values(briefing.objective.permissions).every(value => value === false));
  assert.equal(Object.hasOwn(briefing.objective.permissions, "recordAttempt"), false);
  const event = f.ok("wait", "--timeout", "0").event;
  assert.equal(event.kind, "person_intervention", "Waiting does not need a task mutation permission");
  f.ok("handled", event.id);
  assert.deepEqual(await f.rows("SELECT * FROM tasks WHERE id IN ('foreign','unlinked') ORDER BY id"), foreign);
});

test("unknown and closed objectives refuse all operations with one JSON object", () => {
  const f = fixture();
  for (const state of ["missing", "abandoned"]) {
    if (state === "abandoned") f.person("objective", "abandon", "goal");
    for (const args of [["briefing"], ["wait", "--timeout", "0"], ["handled", "unknown"], ["note", "Remember"], ["objective", "show"], ["task", "add", "no", "No"], ["task", "list"], ["dispatch", "--task", "foreign"], ["finish", "--task", "foreign"]]) {
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
  assert.equal(initial.code, 0);
  assert.equal(initial.value.reason, "dispatch_started");
  initial.value = await f.finished(initial.value.attempt.requestId);
  assert.equal(initial.value.reason, "held");
  const replay = f.run("dispatch", "--task", "work", "--request-id", "initial");
  assert.equal(replay.code, 1);
  assert.equal(replay.value.reason, "existing_request");
  f.ok("task", "release", "work");
  const note = join(f.dir, "note.txt");
  writeFileSync(note, "Repair from kept output");
  assert.equal(f.ok("dispatch", "--task", "work", "--from-attempt", "1", "--note-file", note, "--dry-run").reason, "dry_run");
  const continued = f.run("dispatch", "--task", "work", "--from-attempt", "1", "--note-file", note, "--request-id", "repair");
  assert.equal(continued.value.reason, "dispatch_started", JSON.stringify(continued));
  continued.value = await f.finished(continued.value.attempt.requestId);
  assert.equal(continued.value.reason, "held");
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
  const reviewing = f.ok("dispatch", "--task", review.task.id);
  assert.equal((await f.finished(reviewing.attempt.requestId)).reason, "held");
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
  const started = f.ok("dispatch", "--task", "work");
  assert.equal(started.reason, "dispatch_started");
  {
    let ready = false;
    for (let i = 0; i < 400; i++) {
      if (operation === "answer") ready = (await f.rows("SELECT * FROM question_files WHERE document IS NOT NULL")).length > 0;
      else ready = existsSync(f.log) && readFileSync(f.log, "utf8").includes('"type":"prompt"');
      if (ready) break;
      await sleep(25);
    }
    assert.ok(ready, "The synthetic worker must start");
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
    assert.equal((await f.finished(started.attempt.requestId)).reason, "held");
    if (operation === "answer") {
      assert.deepEqual((await f.rows("SELECT answered_by FROM question_answers")).map(row => row.answered_by), ["supervisor:goal"]);
    } else {
      const requests = (await f.rows("SELECT request FROM control_requests")).map(row => JSON.parse(String(row.request)));
      assert.equal(requests.length, 1);
      assert.equal(requests[0].sender, "supervisor:goal");
      assert.equal(requests[0].label, "operator:admin");
    }
  }
});

test("detached dispatch outlives its caller, replays without another process and holds keep-awake", async () => {
  const f = fixture();
  const marker = join(f.dir, "keep-awake.json");
  const starts = join(f.dir, "keep-awake-starts.txt");
  const script = "const fs = require('node:fs'); fs.appendFileSync(process.argv[3], JSON.stringify({ pid: process.pid, dispatcher: process.argv[2] }) + '\\n'); fs.writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, dispatcher: process.argv[2] })); setInterval(() => { try { process.kill(Number(process.argv[2]), 0); } catch { process.exit(0); } }, 100)";
  f.config.keepAwake = { command: [process.execPath, "-e", script, marker, "{pid}", starts] };
  const acquisition = join(f.dir, "awake-during-acquisition.json");
  if (process.platform !== "win32") {
    const bin = join(f.dir, "bin");
    mkdirSync(bin);
    const treehouse = onPath("treehouse");
    const probe = join(f.dir, "probe.cjs");
    writeFileSync(probe, `const fs = require('node:fs'); const end = Date.now() + 10000; while (!fs.existsSync(${JSON.stringify(marker)})) { if (Date.now() > end) process.exit(1); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } const assertion = JSON.parse(fs.readFileSync(${JSON.stringify(marker)}, 'utf8')); process.kill(assertion.pid, 0); fs.writeFileSync(${JSON.stringify(acquisition)}, JSON.stringify(assertion));`);
    writeFileSync(join(bin, "treehouse"), `#!/bin/sh\nif [ "$3" = get ]; then '${process.execPath}' '${probe}' || exit 1; fi\nexec '${treehouse}' "$@"\n`, { mode: 0o755 });
    Object.assign(f.environment, { PATH: `${bin}:${process.env.PATH}` });
  }
  f.scenario("await-release");
  f.ok("task", "add", "work", "Work");
  f.ok("task", "add", "another", "Another task");
  assert.equal(f.ok("dispatch", "--task", "work", "--dry-run", "--request-id", "survivor").reason, "dry_run");
  assert.deepEqual(await f.rows("SELECT * FROM supervisor_dispatches"), []);
  assert.equal(existsSync(marker), false, "A dry run starts no keep-awake command");

  // run uses spawnSync: the calling CLI has exited before any of these assertions run.
  const started = f.ok("dispatch", "--task", "work", "--request-id", "survivor");
  assert.equal(started.reason, "dispatch_started");
  assert.deepEqual(started.attempt, { contextId: f.config.contextId, taskId: "work", attempt: 1, requestId: "survivor" });
  const recorded = (await f.rows("SELECT * FROM supervisor_dispatches"))[0]!;
  const pid = Number(recorded.process_pid);
  assert.ok(alive(pid));
  assert.deepEqual(JSON.parse(String(recorded.caller)), { kind: "supervisor", objectiveId: "goal" });
  assert.equal(isAbsolute(String(recorded.output_path)), false);
  assert.equal(recorded.output_path, started.observed.outputPath);
  if (process.platform !== "win32") assert.equal(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim(), String(pid));
  await until(() => existsSync(marker) && existsSync(f.log) && readFileSync(f.log, "utf8").includes('"type":"prompt"'));
  const assertion = JSON.parse(readFileSync(marker, "utf8"));
  assert.equal(assertion.dispatcher, String(pid));
  assert.ok(alive(assertion.pid), "The detached process holds its own power assertion");
  if (process.platform !== "win32") assert.deepEqual(JSON.parse(readFileSync(acquisition, "utf8")), assertion, "Keep-awake is already held during treehouse get");
  assert.equal((await f.rows("SELECT result FROM supervisor_dispatches"))[0]!.result, null, "The worker is still running after the caller exits");
  const replay = f.run("dispatch", "--task", "work", "--request-id", "survivor");
  assert.equal(replay.value.reason, "existing_request");
  assert.deepEqual(replay.value.attempt.requestId, "survivor");
  assert.equal(replay.value.attempt.attempt, 1);
  assert.equal(f.run("dispatch", "--task", "another", "--request-id", "survivor").value.reason, "request_input_mismatch");
  assert.equal((await f.rows("SELECT process_pid FROM supervisor_dispatches"))[0]!.process_pid, pid);
  assert.equal((await f.rows("SELECT * FROM attempts")).length, 1);
  assert.equal((readFileSync(f.log, "utf8").match(/"type":"prompt"/g) ?? []).length, 1);

  // Even an explicit second internal invocation cannot claim the recorded launch again.
  const duplicate = spawnSync(process.execPath, [resolve("src/supervise/dispatch-process.ts"), join(f.config.runtimeRoot, "switchboard.db"), f.config.contextId, "survivor"], { env: f.environment, encoding: "utf8" });
  assert.equal(duplicate.status, 0, duplicate.stderr);
  writeFileSync(join(f.dir, "release"), "finish normally");
  const finished = await f.finished("survivor");
  assert.equal(finished.worker.status, "reported");
  assert.equal(finished.worker.outcome, "completed");
  assert.equal(finished.reason, "held", "Normal code completion retains the lease for review");
  await until(() => !alive(pid) && !alive(assertion.pid));
  const commands = readFileSync(starts, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(commands.filter(command => command.dispatcher === String(pid)), [assertion], "The detached worker shares one assertion");
  for (const command of commands) await until(() => !alive(command.pid));
  const entries = (await f.rows("SELECT entry FROM attempt_entries WHERE task = 'work'")).map(row => JSON.parse(String(row.entry)));
  assert.ok(entries.every(entry => entry.askedBy === "supervisor:goal"));
  assert.ok((await f.rows("SELECT kind FROM supervisor_events WHERE task = 'work'")).some(row => row.kind === "worker_finished"));
  assert.match(readFileSync(join(f.config.runtimeRoot, String(recorded.output_path)), "utf8"), /Task work, attempt 1/);
  assert.equal(f.run("dispatch", "--task", "work", "--request-id", "survivor").value.reason, "existing_request");
  assert.equal((await f.rows("SELECT process_pid FROM supervisor_dispatches"))[0]!.process_pid, pid);
});

test("concurrent calls with the same request ID start only one detached process and worker", async () => {
  const f = fixture();
  f.scenario("await-release");
  f.ok("task", "add", "work", "Work");
  const invoke = () => new Promise<{ code: number; value: any }>((resolve, reject) => {
    execFile(process.execPath, [cli, "supervise", "dispatch", "--task", "work", "--objective", "goal", "--request-id", "concurrent", "--config", f.configPath],
      { env: f.environment }, (error, stdout, stderr) => {
        if (error && error.code !== 1) { reject(new Error(stderr + stdout)); return; }
        resolve({ code: error ? 1 : 0, value: JSON.parse(stdout) });
      });
  });
  const calls = await Promise.all([invoke(), invoke()]);
  assert.deepEqual(calls.map(call => call.value.reason).sort(), ["dispatch_started", "existing_request"]);
  assert.deepEqual(calls.map(call => call.code).sort(), [0, 1]);
  assert.ok(calls.every(call => call.value.attempt.taskId === "work" && call.value.attempt.attempt === 1 && call.value.attempt.requestId === "concurrent"));
  assert.equal((await f.rows("SELECT * FROM supervisor_dispatches")).length, 1);
  assert.equal((await f.rows("SELECT * FROM attempts")).length, 1);
  await until(() => existsSync(f.log) && readFileSync(f.log, "utf8").includes('"type":"prompt"'));
  assert.equal((readFileSync(f.log, "utf8").match(/"type":"prompt"/g) ?? []).length, 1);
  writeFileSync(join(f.dir, "release"), "finish normally");
  assert.equal((await f.finished("concurrent")).worker.outcome, "completed");
});

test("a dispatcher exiting before reservation reports its relative output path and never restarts on replay", async () => {
  const f = fixture();
  f.ok("task", "add", "work", "Work");
  Object.assign(f.environment, { NODE_OPTIONS: `--import="${pathToFileURL(resolve("tests/fixtures/exit-detached.ts")).href}"` });
  const failed = f.run("dispatch", "--task", "work", "--request-id", "early-exit");
  assert.equal(failed.code, 1);
  assert.equal(failed.value.reason, "dispatch_start_failed");
  assert.match(failed.value.detail, /17/);
  assert.match(failed.value.summary, /ended before reserving an attempt/);
  const recorded = (await f.rows("SELECT * FROM supervisor_dispatches"))[0]!;
  const outputPath = String(recorded.output_path);
  assert.equal(isAbsolute(outputPath), false);
  assert.equal(failed.value.observed.outputPath, outputPath);
  assert.ok(failed.value.detail.includes(outputPath));
  const output = readFileSync(join(f.config.runtimeRoot, outputPath), "utf8");
  assert.match(output, /Synthetic dispatcher exit before reservation/);
  assert.deepEqual(await f.rows("SELECT * FROM attempts"), []);
  assert.equal(existsSync(f.log), false);
  Object.assign(f.environment, { NODE_OPTIONS: "" });
  assert.deepEqual(f.run("dispatch", "--task", "work", "--request-id", "early-exit"), failed);
  assert.equal(readFileSync(join(f.config.runtimeRoot, outputPath), "utf8"), output);
  assert.equal((await f.rows("SELECT * FROM supervisor_dispatches")).length, 1);
});

test("detached dispatch returns and retains the original pre-reservation refusal", async () => {
  const f = fixture();
  f.ok("task", "add", "work", "Work");
  f.ok("task", "hold", "work", "--reason", "Not ready yet");
  const refused = f.run("dispatch", "--task", "work", "--request-id", "not-ready");
  assert.equal(refused.code, 1);
  assert.equal(refused.value.reason, "refused");
  assert.match(refused.value.detail, /not ready/);
  f.ok("task", "release", "work");
  assert.deepEqual(f.run("dispatch", "--task", "work", "--request-id", "not-ready"), refused);
  assert.deepEqual(await f.rows("SELECT * FROM attempts"), []);
  assert.equal(existsSync(f.log), false);
});

test("a supervisor with three workers receives each event in the order it happens, including a stopped dispatch process", { timeout: 60000 }, async () => {
  const f = fixture();
  Object.assign(f.config, { maxAttempts: 3 });
  f.scenario("await-task-release");
  const files = f.dir;
  const started: Record<string, string> = {};
  for (const task of ["a", "b", "c"]) {
    f.ok("task", "add", task, `Task ${task}`);
    const value = f.ok("dispatch", "--task", task);
    assert.equal(value.reason, "dispatch_started", JSON.stringify(value));
    started[task] = value.attempt.requestId;
  }
  await until(async () => (await f.rows("SELECT 1 FROM launches WHERE kind = 'launch'")).length === 3);
  f.ok("task", "add", "d", "Task d");
  const full = f.run("dispatch", "--task", "d");
  assert.equal(full.code, 1);
  assert.equal(full.value.observed.reason, "capacity", JSON.stringify(full.value));
  const next = async () => {
    const value = f.ok("wait", "--timeout", "15").event;
    assert.ok(value, "An event must arrive");
    f.ok("handled", value.id);
    return `${value.kind} ${value.taskId}`;
  };

  writeFileSync(join(files, "release-b"), "");
  assert.equal((await f.finished(started.b!)).reason, "held");
  assert.deepEqual([await next(), await next()], ["worker_finished b", "attempt_held b"]);

  writeFileSync(join(files, "ask-a"), "");
  assert.equal(await next(), "question_asked a");

  const dispatcher = Number((await f.rows("SELECT process_pid FROM supervisor_dispatches WHERE request_id = ?", started.c!))[0]!.process_pid);
  process.kill(dispatcher, "SIGKILL");
  await until(() => !alive(dispatcher));
  assert.equal(f.ok("wait", "--timeout", "0").event, null, "A fresh heartbeat is not yet an event");
  // The killed process cannot refresh its heartbeat, so ageing it stands in for 30 seconds passing.
  const db = await Database.open(join(f.config.runtimeRoot, "switchboard.db"));
  try {
    await db.transaction(() => db.run("UPDATE worker_claims SET heartbeat_at = ? WHERE task = 'c'", new Date(Date.now() - 60_000).toISOString()));
  } finally { db.close(); }
  const stale = f.ok("wait", "--timeout", "15").event;
  assert.partialDeepStrictEqual(stale, { kind: "dispatcher_heartbeat_stale", taskId: "c", details: { claimReleased: false } });
  f.ok("handled", stale.id);
  assert.equal(f.ok("wait", "--timeout", "0").event, null, "A stale heartbeat is reported once, and the other workers' heartbeats stay fresh");

  writeFileSync(join(files, "release-a"), "");
  assert.equal((await f.finished(started.a!)).reason, "held");
  assert.deepEqual([await next(), await next()], ["worker_finished a", "attempt_held a"]);
  assert.equal(f.ok("wait", "--timeout", "0").event, null);
});
