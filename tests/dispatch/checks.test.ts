import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configSchema, loadConfig } from "../../src/config.ts";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { finish } from "../../src/dispatch/finish.ts";
import { describe } from "../../src/dispatch/result.ts";
import { describeStatus, status } from "../../src/dispatch/status.ts";
import { fixture, task } from "./fixture.ts";

async function output() {
  const f = await fixture({ tasks: [task("checks-a1")], scenario: "commit-result" });
  const dispatched = await dispatchOnce(f.deps);
  assert.equal(dispatched.reason, "held", dispatched.detail ?? "");
  const { leaseId, workspace, outputBranch } = dispatched.attempt!;
  const commit = f.run(["rev-parse", outputBranch!]);
  f.deps.checkEnvironment = f.environment;
  return { f, leaseId: leaseId!, workspace: workspace!, branch: outputBranch!, commit };
}

const command = (name: string, script: string, timeoutMs = 5000) => ({ name, command: [process.execPath, "-e", script] as [string, ...string[]], timeoutMs });
const facts = async (f: Awaited<ReturnType<typeof fixture>>) =>
  (await f.deps.attempts.forTask("checks-a1"))[0]!.entries.filter(entry => entry.kind === "check_finished");

test("check configuration defaults to none and validates commands, limits and unique names on load", async () => {
  const f = await fixture();
  const raw = JSON.parse(readFileSync(f.config, "utf8"));
  assert.deepEqual((await loadConfig(f.config)).checks, []);
  const good = command("types", "process.exit(0)");
  assert.deepEqual(configSchema.parse({ ...raw, checks: [good] }).checks, [good]);
  for (const checks of [
    [{ ...good, name: " " }], [{ ...good, command: [] }], [{ ...good, command: [""] }],
    [{ ...good, command: ["node", 1] }], [{ ...good, timeoutMs: 0 }], [{ ...good, timeoutMs: 1.5 }],
    [{ ...good, timeoutMs: 2147483648 }], [good, good], [{ ...good, shell: true }],
  ]) {
    writeFileSync(f.config, JSON.stringify({ ...raw, checks }));
    await assert.rejects(loadConfig(f.config));
  }
  f.tasks.close();
});

test("passing checks run without a shell at the exact commit and are reused; a new commit runs again", async () => {
  const { f, leaseId, workspace, branch, commit } = await output();
  const marker = join(f.dir, "runs.txt");
  f.deps.checks = [command("pass", `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.cwd() + '\\n')`)];
  const first = await finish(f.deps, { leaseId, noProcesses: false });
  assert.equal(first.reason, "finished", first.detail ?? "");
  assert.equal(first.checks?.[0]?.status, "passed");
  assert.equal(first.checks?.[0]?.commit, commit);
  assert.equal(first.checks?.[0]?.exitCode, 0);
  assert.equal(readFileSync(marker, "utf8"), workspace + "\n");
  assert.equal((await finish(f.deps, { leaseId, noProcesses: false })).reason, "finished");
  assert.equal((await facts(f)).length, 1);
  f.run(["commit", "--allow-empty", "--no-gpg-sign", "-qm", "Later output"], workspace);
  const later = f.run(["rev-parse", branch]);
  assert.notEqual(later, commit);
  const again = await finish(f.deps, { leaseId, noProcesses: false, acceptOutput: true });
  assert.equal(again.reason, "finished", again.detail ?? "");
  assert.equal(again.checks?.[0]?.commit, later);
  assert.equal((await facts(f)).length, 2);
  assert.equal(readFileSync(marker, "utf8"), (workspace + "\n").repeat(2));
  const view = await status(f.deps);
  assert.equal(view.attempts[0]?.checks?.[0]?.commit, later);
  assert.match(describeStatus(view), /Check pass: passed/);
  f.tasks.close();
});

test("failed checks report redacted output but do not refuse operator acceptance or local integration", async () => {
  const { f, leaseId, commit } = await output();
  const marker = join(f.dir, "literal;not-a-shell");
  f.deps.checks = [
    { name: "literal", command: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ok')", marker], timeoutMs: 5000 },
    command("fail", "console.log('token=private https://user:password@example.invalid'); console.error('Authorization: Bearer private'); process.exit(7)"),
  ];
  f.deps.policy = {
    git: "git", environment: f.environment, repository: f.deps.repository, baseRef: "main",
    globalFile: join(f.dir, "absent-policy.json"), context: { kind: "local-merge", targetBranch: "main" },
  };
  const result = await finish(f.deps, { leaseId, noProcesses: false, acceptOutput: true });
  assert.equal(result.reason, "finished", result.detail ?? "");
  assert.equal(result.acceptanceEvidence!.commit, commit);
  assert.equal(result.acceptanceEvidence!.permission.allowed, false);
  assert.match(describe(result), /Acceptance evidence for .*: NOT sufficient.*Check fail has not passed/);
  assert.equal(f.run(["rev-parse", "main"]), commit);
  assert.equal((await f.tasks.read("checks-a1"))?.state, "done");
  assert.ok(existsSync(marker));
  const failed = result.checks!.find(check => check.name === "fail")!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.timedOut, false);
  assert.ok(failed.durationMs >= 0);
  assert.match(describe(result), /Check fail: FAILED/);
  assert.match(describe(result), /stdout:.*\[redacted\]/);
  assert.match(describe(result), /stderr:.*\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(await facts(f)), /private|user:password/);
  const view = await status(f.deps);
  assert.match(describeStatus(view), /Check fail: FAILED/);
  assert.equal(view.attempts[0]?.checks?.find(check => check.name === "fail")?.commit, commit);
  assert.equal((await finish(f.deps, { leaseId, noProcesses: false })).reason, "finished");
  assert.equal((await facts(f)).length, 3); // Only the failed command is retried.
  f.tasks.close();
});

for (const fault of ["different HEAD", "untracked", "tracked"] as const) {
  test(`finish refuses ${fault} before running any checks`, async () => {
    const { f, leaseId, workspace } = await output();
    const marker = join(f.dir, "should-not-run");
    f.deps.checks = [command("marker", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`)];
    if (fault === "different HEAD") f.run(["checkout", "--detach", "main"], workspace);
    if (fault === "untracked") writeFileSync(join(workspace, "untracked"), "changed");
    if (fault === "tracked") writeFileSync(join(workspace, "tracked.txt"), "changed");
    const result = await finish(f.deps, { leaseId, noProcesses: false });
    assert.equal(result.reason, "refused", result.detail ?? "");
    assert.equal(existsSync(marker), false);
    assert.equal((await facts(f)).length, 0);
    assert.notEqual((await f.tasks.read("checks-a1"))?.state, "done");
    f.tasks.close();
  });
}

test("a time limit is recorded as a failed advisory check", async () => {
  const { f, leaseId } = await output();
  f.deps.checks = [command("timeout", "console.error('waiting'); setInterval(() => {}, 1000)", 200)];
  const result = await finish(f.deps, { leaseId, noProcesses: false });
  assert.equal(result.reason, "finished", result.detail ?? "");
  assert.equal(result.checks?.[0]?.status, "failed");
  assert.equal(result.checks?.[0]?.timedOut, true);
  assert.equal(result.checks?.[0]?.exitCode, null);
  assert.match(result.checks![0]!.stderr, /waiting/);
  assert.match(describe(result), /time limit reached/);
  f.tasks.close();
});

test("an unstartable check is not run, has redacted owner-read diagnostics, and is retried", async () => {
  const { f, leaseId } = await output();
  const executable = join(f.dir, "missing-token=private");
  f.deps.checks = [{ name: "missing", command: [executable], timeoutMs: 1000 }];
  const first = await finish(f.deps, { leaseId, noProcesses: false });
  assert.equal(first.reason, "finished", first.detail ?? "");
  assert.equal(first.checks?.[0]?.status, "not_run");
  assert.match(describe(first), /Check missing: NOT RUN/);
  assert.match(describe(first), /Diagnostics:/);
  assert.doesNotMatch(JSON.stringify(first.checks), /private/);
  assert.equal((await finish(f.deps, { leaseId, noProcesses: false })).reason, "finished");
  assert.equal((await facts(f)).length, 2);
  assert.equal((await status(f.deps)).attempts[0]?.unsettledReadFailures, undefined);
  f.tasks.close();
});

test("dry run runs no commands and a check that dirties the input prevents acceptance", async () => {
  const { f, leaseId, workspace } = await output();
  f.deps.checks = [command("dirty", "require('node:fs').writeFileSync('untracked', 'changed')"), command("next", "console.log('not reached')")];
  const plan = await finish(f.deps, { leaseId, noProcesses: false, dryRun: true });
  assert.equal(plan.reason, "planned", plan.detail ?? "");
  assert.equal(existsSync(join(workspace, "untracked")), false);
  assert.equal((await facts(f)).length, 0);
  const result = await finish(f.deps, { leaseId, noProcesses: false });
  assert.equal(result.reason, "refused", result.detail ?? "");
  assert.equal((await facts(f)).length, 1);
  assert.notEqual((await f.tasks.read("checks-a1"))?.state, "done");
  f.tasks.close();
});
