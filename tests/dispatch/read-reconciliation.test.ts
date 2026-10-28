import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { dispatchOnce, type Dependencies } from "../../src/dispatch/dispatch.ts";
import { finish } from "../../src/dispatch/finish.ts";
import { OwnerReads, unsettledReads } from "../../src/dispatch/owner-reads.ts";
import { resolveLeaseReturned, resolveReadFailure } from "../../src/dispatch/resolve.ts";
import { status } from "../../src/dispatch/status.ts";
import { describeCommand } from "../../src/infra/command.ts";
import { onPath } from "../../src/infra/executables.ts";
import { WorkspaceError } from "../../src/workspaces/provider.ts";
import { attemptsWith, fixture, task } from "./fixture.ts";

const failure = () => new WorkspaceError("unreadable", "Injected reconciliation read", describeCommand({
  exitCode: 23, stdout: "read output", stderr: "read error", timedOut: false, truncated: false,
}));
const clone = <T extends object>(value: T): T => Object.assign(Object.create(Object.getPrototypeOf(value)), value);

async function uncertainReturn(afterEffect = false) {
  const f = await fixture({ tasks: [task("reconcile-a1")], scenario: "commit-result" });
  const leaseId = (await dispatchOnce(f.deps)).attempt!.leaseId!;
  let returns = 0;
  const workspaces = clone(f.deps.workspaces);
  workspaces.returnLease = async (...args) => {
    returns++;
    await f.deps.workspaces.returnLease(...args);
    throw new WorkspaceError("outcome_unknown", "Return read-back failed", undefined, { owner: "Treehouse leases", error: failure() });
  };
  const retention: Dependencies["retention"] = async request => {
    const record = (await f.deps.attempts.findByLease(leaseId))!;
    if (!afterEffect && record.entries.some(e => e.kind === "lease_return_started")) throw failure();
    return f.deps.retention(request);
  };
  const first = await finish({ ...f.deps, workspaces, retention }, { leaseId, noProcesses: true });
  assert.equal(first.reason, "reconciliation_required", first.detail ?? "");
  assert.equal(returns, afterEffect ? 1 : 0);
  const record = (await f.deps.attempts.findByLease(leaseId))!;
  const failed = unsettledReads(record)[0]!;
  return { ...f, leaseId, record, failed };
}

test("an operator reconciles a return that did not happen, scoped to exactly one failure", async () => {
  const f = await uncertainReturn();
  const reads = new OwnerReads(f.deps, "finish", f.leaseId);
  await reads.failure("Treehouse leases", "second failed read of uncertain return", failure());
  const before = (await f.deps.attempts.findByLease(f.leaseId))!;
  const failures = unsettledReads(before);
  assert.equal(failures.length, 2);
  const options = { leaseId: f.leaseId, failureSequence: f.failed.sequence, outcome: "not_happened" as const, note: "Inspected Treehouse: the lease is still held and no return was attempted" };
  assert.equal((await resolveReadFailure(f.deps, { ...options, failureSequence: 0 })).reason, "refused");
  assert.equal((await resolveReadFailure(f.deps, { ...options, failureSequence: 1000 })).reason, "refused");
  assert.equal((await resolveReadFailure(f.deps, { ...options, note: " " })).reason, "refused");
  assert.equal((await resolveReadFailure(f.deps, options)).reason, "resolved");
  assert.equal((await f.deps.workspaces.leases()).length, 1, "reconciliation never returns a lease");
  const confirmed = (await f.deps.attempts.findByLease(f.leaseId))!;
  const confirmation = confirmed.confirmations!.find(c => c.fact === "owner_read_reconciled")!;
  assert.equal(confirmation.fact, "owner_read_reconciled");
  assert.equal(confirmation.scope.failureSequence, f.failed.sequence);
  assert.equal(confirmation.scope.outcome, "not_happened");
  assert.equal(confirmation.scope.returnId, before.entries.find(e => e.kind === "lease_return_started")!.data.returnId);
  assert.match(confirmation.confirmedBy, /^operator:/);
  assert.equal(unsettledReads(confirmed).length, 1);
  assert.equal((await finish(f.deps, { leaseId: f.leaseId, noProcesses: true })).reason, "reconciliation_required");
  const view = await status(f.deps, { activity: false, transcript: false });
  assert.deepEqual(view.attempts[0]!.unsettledReadFailures!.map(f => f.sequence), [failures[1]!.sequence]);
  assert.equal((await resolveReadFailure(f.deps, options)).reason, "refused", "a settled sequence is not a new approval");
  assert.equal((await resolveReadFailure(f.deps, { ...options, failureSequence: failures[1]!.sequence })).reason, "resolved");
  const last = await finish(f.deps, { leaseId: f.leaseId, noProcesses: true });
  assert.equal(last.reason, "finished", last.detail ?? "");
  const completed = (await f.deps.attempts.findByLease(f.leaseId))!;
  assert.equal(completed.entries.filter(e => e.kind === "lease_returned").length, 1);
  assert.equal(completed.entries.filter(e => e.kind === "lease_return_started").length, 2, "only the operator-established non-return allows a fresh return");
});

test("a claimed return cannot overrule Treehouse listing the lease, or an unlisted pool", async () => {
  const f = await uncertainReturn();
  const options = { leaseId: f.leaseId, failureSequence: f.failed.sequence, outcome: "happened" as const, note: "Claimed return" };
  assert.equal((await resolveReadFailure(f.deps, options)).reason, "refused");
  const workspaces = clone(f.deps.workspaces);
  workspaces.pool = async () => "another-pool";
  workspaces.leases = async () => [];
  assert.equal((await resolveReadFailure({ ...f.deps, workspaces }, options)).reason, "refused");
  assert.equal((await f.deps.attempts.findByLease(f.leaseId))!.confirmations!.filter(c => c.fact === "owner_read_reconciled").length, 0);
});

test("Treehouse's absent lease settles an uncertain return without ever returning it again", async () => {
  const f = await uncertainReturn(true);
  const workspaces = clone(f.deps.workspaces);
  workspaces.returnLease = async () => assert.fail("An uncertain return must not be repeated");
  const options = { leaseId: f.leaseId, failureSequence: f.failed.sequence, outcome: "happened" as const, note: "Treehouse confirms the lease is absent" };
  assert.equal((await resolveReadFailure({ ...f.deps, workspaces }, options)).reason, "resolved");
  assert.equal((await finish({ ...f.deps, workspaces }, { leaseId: f.leaseId, noProcesses: true })).reason, "finished");
  const record = (await f.deps.attempts.findByLease(f.leaseId))!;
  assert.equal(record.entries.filter(e => e.kind === "lease_return_started").length, 1);
  assert.equal(record.entries.filter(e => e.kind === "lease_returned").length, 1);
});

test("read reconciliation refuses while the worker may be running, including a fresh recheck", async () => {
  const f = await uncertainReturn();
  const options = { leaseId: f.leaseId, failureSequence: f.failed.sequence, outcome: "not_happened" as const, note: "Inspected the owner" };
  for (const startsRunning of [1, 2]) {
    let calls = 0;
    const runtime = clone(f.deps.runtime);
    runtime.discover = async (...args) => {
      const records = await f.deps.runtime.discover(...args);
      return ++calls >= startsRunning ? records.map(record => ({ ...record, child: { status: "unknown" as const } })) : records;
    };
    const refused = await resolveReadFailure({ ...f.deps, runtime }, options);
    assert.equal(refused.reason, "refused", refused.detail ?? "");
    assert.match(refused.detail!, /worker|lease changed/);
  }
  assert.equal((await f.deps.attempts.findByLease(f.leaseId))!.confirmations!.filter(c => c.fact === "owner_read_reconciled").length, 0);
});

test("a failed diagnostic write does not hide the failed owner's command output", async () => {
  const f = await fixture({ tasks: [task("reconcile-a1")], scenario: "commit-result" });
  const leaseId = (await dispatchOnce(f.deps)).attempt!.leaseId!;
  const workspaces = clone(f.deps.workspaces);
  workspaces.leases = async () => { throw failure(); };
  const attempts = attemptsWith(f, { append: async () => { throw new Error("Ledger temporarily unavailable"); } });
  const first = await finish({ ...f.deps, workspaces, attempts }, { leaseId, noProcesses: true });
  assert.equal(first.reason, "owner_read_retryable");
  const recorded = first.observed.readFailure as { diagnostics: { message: string; command: { stdout: string } } };
  assert.equal(recorded.diagnostics.command.stdout, "read output");
  assert.match(recorded.diagnostics.message, /Ledger temporarily unavailable/);
  assert.equal((await f.deps.workspaces.leases()).length, 1);
});

test("a failed owner read during operator reconciliation refuses again and keeps the new failure", async () => {
  const f = await uncertainReturn();
  const workspaces = clone(f.deps.workspaces);
  workspaces.leases = async () => { throw failure(); };
  const options = { leaseId: f.leaseId, failureSequence: f.failed.sequence, outcome: "not_happened" as const, note: "Inspected the owner" };
  const first = await resolveReadFailure({ ...f.deps, workspaces }, options);
  assert.equal(first.reason, "reconciliation_required", first.detail ?? "");
  const record = (await f.deps.attempts.findByLease(f.leaseId))!;
  assert.equal(unsettledReads(record).length, 2);
  assert.equal(record.entries.at(-1)!.data.operation, "resolve");
  assert.equal(record.confirmations!.filter(c => c.fact === "owner_read_reconciled").length, 0);
});

test("resolve CLI records failure-scoped operator reconciliation and rejects incomplete inputs", async () => {
  const f = await uncertainReturn();
  const args = [resolve("src/cli.ts"), "resolve", "--task", f.record.taskId, "--attempt", String(f.record.attempt), "--read-failure", String(f.failed.sequence),
    "--effect-outcome", "not_happened", "--note", "Confirmed the lease was not returned", "--json", "--config", f.config];
  const result = JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
  assert.equal(result.reason, "resolved");
  assert.equal((await f.deps.workspaces.leases()).length, 1);
  for (const extra of [["--worker-stopped"], ["--lease-returned"]]) {
    assert.throws(() => execFileSync(process.execPath, [...args, ...extra], { stdio: "pipe" }), { status: 2 });
  }
  const withoutNote = args.filter((_, i) => i !== args.indexOf("--note") && i !== args.indexOf("--note") + 1);
  assert.throws(() => execFileSync(process.execPath, withoutNote, { stdio: "pipe" }), { status: 2 });
});

test("finish reconciles a failed fast-forward read-back by reading the exact target commit on rerun", { skip: process.platform === "win32" }, async () => {
  const f = await fixture({ tasks: [task("reconcile-a1")], scenario: "commit-result" });
  const dispatched = await dispatchOnce(f.deps);
  const leaseId = dispatched.attempt!.leaseId!;
  const commit = dispatched.attempt!.resultCommit!;
  f.run(["branch", "target", "main"]);
  const blocked = join(f.dir, "target-read-blocked"), effects = join(f.dir, "integration-effects"), git = join(f.dir, "git-fault");
  await writeFile(git, `#!/bin/sh
if [ "$1" = rev-parse ] && [ "$4" = 'refs/heads/target^{commit}' ] && [ -f '${blocked}' ]; then echo 'target output'; echo 'target unavailable' >&2; exit 23; fi
if [ "$1" = update-ref ] && [ "$2" = refs/heads/target ]; then
  '${onPath("git")}' "$@" || exit $?
  echo integrated >> '${effects}'
  touch '${blocked}'
  exit 0
fi
exec '${onPath("git")}' "$@"
`, { mode: 0o755 });
  const deps = { ...f.deps, policy: { git, repository: f.deps.repository, environment: f.environment, baseRef: "main", globalFile: join(f.dir, "no-global-policy"),
    context: { kind: "local-merge" as const, targetBranch: "target" } } };
  const first = await finish(deps, { leaseId, noProcesses: true });
  assert.equal(first.reason, "reconciliation_required", first.detail ?? "");
  assert.equal(f.run(["rev-parse", "target"]), commit);
  assert.equal((await f.deps.attempts.findByLease(leaseId))!.entries.filter(e => e.kind === "integrated").length, 0);
  const second = await finish(deps, { leaseId, noProcesses: true });
  assert.equal(second.reason, "reconciliation_required", second.detail ?? "");
  const failures = unsettledReads((await f.deps.attempts.findByLease(leaseId))!);
  assert.equal(failures.length, 2);
  assert.equal((await readFile(effects, "utf8")).trim(), "integrated");
  await unlink(blocked);
  const third = await finish(deps, { leaseId, noProcesses: true });
  assert.equal(third.reason, "finished", third.detail ?? "");
  const completed = (await f.deps.attempts.findByLease(leaseId))!;
  assert.deepEqual(completed.entries.filter(e => e.kind === "owner_read_reconciled").map(e => e.data.failureSequence), failures.map(e => e.sequence));
  assert.equal(completed.entries.filter(e => e.kind === "integration_started").length, 1);
  assert.equal(completed.entries.filter(e => e.kind === "integrated").length, 1);
  assert.equal(completed.entries.filter(e => e.kind === "lease_returned").length, 1);
  assert.equal((await f.tasks.read("reconcile-a1"))!.state, "done");
  assert.equal((await readFile(effects, "utf8")).trim(), "integrated");
  assert.notEqual((await status(deps)).attempts[0]!.nextAction.code, "reconcile_owner");
});

test("a changed pool cannot settle an uncertain return through finish or legacy resolve", async () => {
  const f = await uncertainReturn();
  f.run(["remote", "add", "origin", "https://example.invalid/changed.git"]);
  assert.equal((await f.deps.workspaces.leases()).length, 0);
  assert.equal((await finish(f.deps, { leaseId: f.leaseId, noProcesses: true })).reason, "reconciliation_required");
  assert.equal((await resolveLeaseReturned(f.deps, { leaseId: f.leaseId })).reason, "reconciliation_required");
  const record = (await f.deps.attempts.findByLease(f.leaseId))!;
  assert.equal(record.entries.some(e => e.kind === "lease_returned"), false);
  assert.equal(record.confirmations!.some(c => c.fact === "lease_returned"), false);
  f.run(["remote", "remove", "origin"]);
  assert.equal((await f.deps.workspaces.leases()).length, 1);
});

test("neither a successful read of an unrelated commit nor a claimed integration authorises repeating it", async () => {
  const f = await fixture({ tasks: [task("reconcile-a1")], scenario: "commit-result" });
  const dispatched = await dispatchOnce(f.deps);
  const leaseId = dispatched.attempt!.leaseId!, commit = dispatched.attempt!.resultCommit!;
  const from = f.run(["rev-parse", "main"]);
  f.run(["branch", "target", "main"]);
  const record = (await f.deps.attempts.findByLease(leaseId))!;
  await f.deps.attempts.append(record, "integration_started", { targetBranch: "target", from, commit });
  f.run(["update-ref", "refs/heads/target", commit, from]);
  const reads = new OwnerReads(f.deps, "finish", leaseId);
  reads.effectAttempted = true;
  await reads.failure("Git", "read branch target", failure());
  // A later external rewind means reading the branch no longer proves the earlier integration.
  f.run(["update-ref", "refs/heads/target", from, commit]);
  const deps = { ...f.deps, policy: { git: onPath("git"), repository: f.deps.repository, environment: f.environment, baseRef: "main",
    globalFile: join(f.dir, "no-global-policy"), context: { kind: "local-merge" as const, targetBranch: "target" } } };
  assert.equal((await finish(deps, { leaseId, noProcesses: false })).reason, "reconciliation_required");
  const failed = unsettledReads((await f.deps.attempts.findByLease(leaseId))!)[0]!;
  assert.equal((await resolveReadFailure(deps, { leaseId, failureSequence: failed.sequence, outcome: "happened", note: "Integration happened before the external rewind" })).reason, "resolved");
  assert.equal((await finish(deps, { leaseId, noProcesses: false })).reason, "reconciliation_required");
  assert.equal(f.run(["rev-parse", "target"]), from, "no repeated fast-forward after a claimed integration");
  f.run(["update-ref", "refs/heads/target", commit, from]);
  assert.equal((await finish(deps, { leaseId, noProcesses: false })).reason, "finished");
  assert.equal((await f.deps.attempts.findByLease(leaseId))!.entries.filter(e => e.kind === "integrated").length, 1);
});
