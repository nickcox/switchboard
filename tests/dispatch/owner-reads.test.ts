import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyFailure, readDiagnostics } from "../../src/dispatch/failure.ts";
import { dispatchOnce, type Dependencies } from "../../src/dispatch/dispatch.ts";
import { discard, finish } from "../../src/dispatch/finish.ts";
import { describeStatus, status } from "../../src/dispatch/status.ts";
import { describeCommand, runCommand } from "../../src/infra/command.ts";
import { onPath } from "../../src/infra/executables.ts";
import { WorkspaceError, type WorkspaceProvider } from "../../src/workspaces/provider.ts";
import { fixture, task } from "./fixture.ts";

test("failure classification requires the operation's evidence", () => {
  assert.equal(classifyFailure({ step: "read", effectAttempted: false }), "owner_read");
  assert.equal(classifyFailure({ step: "read", effectAttempted: true }), "effect_uncertain");
  assert.equal(classifyFailure({ step: "approval" }), "approval_required");
  assert.equal(classifyFailure({ step: "effect" }), "effect_uncertain");
  assert.equal(classifyFailure({ step: "rejection" }), "rejected");
});

async function failedCommand() {
  return runCommand(process.execPath, ["-e", "process.stdout.write('read output'); process.stderr.write('read error'); process.exit(23)"],
    { cwd: process.cwd(), env: {}, timeoutMs: 5000 });
}

test("read diagnostics keep bounded command output, not arbitrary error fields or credentials", async () => {
  const command = { ...await failedCommand(), stdout: `${"x".repeat(3000)}output end`,
    stderr: "https://user:password@example.invalid/repo?token=private Authorization: Bearer hidden" };
  const error = Object.assign(new WorkspaceError("unreadable", "Read failed", describeCommand(command)), {
    environment: { API_KEY: "private environment" }, credentials: "private credentials",
  });
  const diagnostics = readDiagnostics(error);
  assert.equal(diagnostics.command?.stdout.length, 2000);
  assert.ok(diagnostics.command?.stdout.endsWith("output end"));
  assert.equal(diagnostics.command?.exitCode, 23);
  assert.deepEqual(diagnostics.command?.command, command.command);
  assert.doesNotMatch(JSON.stringify(diagnostics), /user:password|private|hidden|environment|credentials/);
});

async function reviewed() {
  const f = await fixture({ tasks: [task("owner-a1")], scenario: "commit-result" });
  const outcome = await dispatchOnce(f.deps);
  assert.equal(outcome.reason, "held");
  return { f, leaseId: outcome.attempt!.leaseId! };
}

const run = (operation: "finish" | "discard", deps: Dependencies, leaseId: string) => operation === "finish"
  ? finish(deps, { leaseId, noProcesses: true }) : discard(deps, { leaseId, noProcesses: true, confirm: true });

type Owner = "leases" | "pool" | "runtime" | "retention";
const ownerName: Record<Owner, string> = { leases: "Treehouse leases", pool: "Git workspace pool", runtime: "Runtime records", retention: "Git retention" };

function inject(deps: Dependencies, owner: Owner, fail: () => Promise<void>) {
  const workspaces: WorkspaceProvider = Object.assign(Object.create(Object.getPrototypeOf(deps.workspaces)), deps.workspaces);
  const runtime: Dependencies["runtime"] = Object.assign(Object.create(Object.getPrototypeOf(deps.runtime)), deps.runtime);
  if (owner === "leases") workspaces.leases = async () => { await fail(); return deps.workspaces.leases(); };
  if (owner === "pool") workspaces.pool = async () => { await fail(); return deps.workspaces.pool(); };
  if (owner === "runtime") runtime.discover = async (...args) => { await fail(); return deps.runtime.discover(...args); };
  let returns = 0;
  workspaces.returnLease = async (...args) => { returns++; return deps.workspaces.returnLease(...args); };
  return { deps: { ...deps, workspaces, runtime,
    retention: async (...args: Parameters<Dependencies["retention"]>) => { if (owner === "retention") await fail(); return deps.retention(...args); } },
  returns: () => returns };
}

for (const operation of ["finish", "discard"] as const) {
  const owners: Owner[] = operation === "finish" ? ["leases", "pool", "runtime", "retention"] : ["leases", "pool", "runtime"];
  for (const owner of owners) {
    test(`${operation}: ${owner} read before effects is retryable, retained and read again`, async () => {
      const { f, leaseId } = await reviewed();
      const command = await failedCommand();
      let failed = false;
      const injected = inject(f.deps, owner, async () => {
        if (!failed) { failed = true; throw new WorkspaceError("unreadable", "Injected owner read", describeCommand(command)); }
      });
      const first = await run(operation, injected.deps, leaseId);
      assert.equal(first.reason, "owner_read_retryable", first.detail ?? "");
      assert.equal(first.nextAction.code, "retry_owner_read");
      assert.match(first.detail!, /can be tried again/);
      assert.ok(first.detail!.includes(ownerName[owner]));
      assert.equal(injected.returns(), 0);
      const record = (await f.deps.attempts.findByLease(leaseId))!;
      const facts = record.entries.filter(e => e.kind === "owner_read_failed");
      assert.equal(facts.length, 1);
      assert.equal(facts[0]!.data.classification, "owner_read");
      assert.equal(facts[0]!.data.owner, ownerName[owner]);
      assert.equal(facts[0]!.data.operation, operation);
      assert.ok(Number.isFinite(Date.parse(facts[0]!.data.failedAt as string)));
      assert.deepEqual((facts[0]!.data.diagnostics as ReturnType<typeof readDiagnostics>).command,
        { ...JSON.parse(describeCommand(command)), truncated: false });
      const view = await status(f.deps, { activity: false, transcript: false });
      assert.equal(view.attempts[0]!.latestReadFailure?.owner, ownerName[owner]);
      assert.match(describeStatus(view), /Latest read failure:/);
      assert.match(describeStatus(view), /read error/);
      const second = await run(operation, injected.deps, leaseId);
      assert.equal(second.reason, operation === "finish" ? "finished" : "discarded", second.detail ?? "");
      assert.equal(injected.returns(), 1);
      const completed = (await f.deps.attempts.findByLease(leaseId))!;
      assert.deepEqual(completed.entries.filter(e => e.kind === "owner_read_failed"), facts);
      assert.equal(completed.entries.filter(e => e.kind === "lease_returned").length, 1);
      assert.equal(completed.entries.filter(e => e.kind === "lease_return_started").length, 1);
      assert.equal(completed.entries.filter(e => operation === "finish" ? e.kind === "task_recorded" && e.data.outcome === "done" : e.kind === "discarded").length, 1);
    });

    test(`${operation}: ${owner} read after return intent requires reconciliation, including on rerun`, async () => {
      const { f, leaseId } = await reviewed();
      const command = await failedCommand();
      let failed = false;
      const injected = inject(f.deps, owner, async () => {
        const record = (await f.deps.attempts.findByLease(leaseId))!;
        if (!failed && record.entries.some(e => e.kind === "lease_return_started")) {
          failed = true;
          throw new WorkspaceError("unreadable", "Injected after return intent", describeCommand(command));
        }
      });
      const first = await run(operation, injected.deps, leaseId);
      assert.equal(first.reason, "reconciliation_required", first.detail ?? "");
      assert.equal(first.nextAction.code, "reconcile_owner");
      assert.equal(injected.returns(), 0);
      const second = await run(operation, injected.deps, leaseId);
      assert.equal(second.reason, "reconciliation_required", second.detail ?? "");
      assert.equal(injected.returns(), 0);
      const record = (await f.deps.attempts.findByLease(leaseId))!;
      assert.equal(record.entries.filter(e => e.kind === "lease_return_started").length, 1);
      assert.equal(record.entries.find(e => e.kind === "owner_read_failed")!.data.classification, "effect_uncertain");
      const view = await status(f.deps, { activity: false, transcript: false });
      assert.equal(view.attempts[0]!.nextAction.code, "reconcile_owner");
      assert.equal(view.attempts[0]!.changeable, false);
    });
  }

  for (const owner of ["leases", "pool", "runtime"] as const) {
    test(`${operation}: ${owner} read after the return refuses reconciliation without a second return`, async () => {
      const { f, leaseId } = await reviewed();
      const command = await failedCommand();
      let returned = false, failed = false;
      const injected = inject(f.deps, owner, async () => {
        if (returned && !failed) { failed = true; throw new WorkspaceError("unreadable", "Injected after return", describeCommand(command)); }
      });
      injected.deps.workspaces.returnLease = async (...args) => {
        await f.deps.workspaces.returnLease(...args);
        returned = true;
        // A return adapter must report a failed read-back rather than claim the effect failed.
        try {
          if (owner === "runtime") await injected.deps.runtime.discover(f.deps.contextId, { leaseId });
          else await injected.deps.workspaces[owner]();
        } catch (error) { throw new WorkspaceError("outcome_unknown", "Return read-back failed", undefined, { owner: ownerName[owner], error }); }
      };
      const first = await run(operation, injected.deps, leaseId);
      assert.equal(first.reason, "reconciliation_required", first.detail ?? "");
      assert.equal((await f.deps.workspaces.leases()).length, 0);
      injected.deps.workspaces.returnLease = async () => { assert.fail("The return must never be repeated"); };
      const second = await run(operation, injected.deps, leaseId);
      assert.equal(second.reason, operation === "finish" ? "finished" : "discarded", second.detail ?? "");
      const record = (await f.deps.attempts.findByLease(leaseId))!;
      assert.equal(record.entries.filter(e => e.kind === "lease_return_started").length, 1);
      assert.equal(record.entries.filter(e => e.kind === "lease_returned").length, 1);
      assert.equal(record.entries.find(e => e.kind === "owner_read_failed")!.data.classification, "effect_uncertain");
      const view = await status(f.deps, { activity: false, transcript: false });
      assert.notEqual(view.attempts[0]!.nextAction.code, "reconcile_owner");
      assert.equal(view.attempts[0]!.latestReadFailure?.classification, "effect_uncertain");
    });
  }
}

test("finish records retention's returned command failures, not only thrown errors", async () => {
  const { f, leaseId } = await reviewed();
  const command = await failedCommand();
  let failed = false;
  const deps = { ...f.deps, retention: async (...args: Parameters<Dependencies["retention"]>) => {
    if (failed) return f.deps.retention(...args);
    failed = true;
    return { retained: false, findings: [`Could not read Git: ${describeCommand(command)}`], notes: [],
      readFailures: [{ message: "Could not read Git", detail: describeCommand(command) }] };
  } };
  assert.equal((await run("finish", deps, leaseId)).reason, "owner_read_retryable");
  assert.equal((await run("finish", deps, leaseId)).reason, "finished");
});

for (const intent of [false, true]) {
  test(`finish: target branch failure ${intent ? "after return intent" : "before effects"} keeps actual Git diagnostics`, { skip: process.platform === "win32" }, async () => {
    const { f, leaseId } = await reviewed();
    f.run(["branch", "target", "main"]);
    const marker = join(f.dir, "target-failed");
    const git = join(f.dir, "git-fail-once");
    writeFileSync(git, `#!/bin/sh\nif [ "$1" = rev-parse ] && [ "$4" = 'refs/heads/target^{commit}' ] && [ ! -f '${marker}' ]; then touch '${marker}'; echo 'target output'; echo 'target error' >&2; exit 23; fi\nexec '${onPath("git")}' "$@"\n`, { mode: 0o755 });
    if (intent) {
      const record = (await f.deps.attempts.findByLease(leaseId))!;
      const returnId = randomUUID();
      await f.deps.attempts.appendConfirmed(record, "lease_return_started", { leaseId, by: "finish", returnId },
        { fact: "no_processes", scope: { leaseId, returnId } }, "operator:fixture");
    }
    const deps = { ...f.deps, policy: { git, environment: f.environment, repository: f.deps.repository, baseRef: "main",
      globalFile: join(f.dir, "no-global-policy"), context: { kind: "local-merge" as const, targetBranch: "target" } } };
    const first = await run("finish", deps, leaseId);
    assert.equal(first.reason, intent ? "reconciliation_required" : "owner_read_retryable", first.detail ?? "");
    const view = await status(f.deps, { activity: false, transcript: false });
    const failure = view.attempts[0]!.latestReadFailure!;
    assert.equal(failure.owner, "Git");
    assert.equal(failure.step, "read branch target");
    assert.equal(failure.diagnostics.command?.exitCode, 23);
    assert.equal(failure.diagnostics.command?.stdout, "target output\n");
    assert.equal(failure.diagnostics.command?.stderr, "target error\n");
    assert.ok(failure.diagnostics.command?.command?.args.includes("refs/heads/target^{commit}"));
    if (!intent) {
      assert.equal((await run("finish", deps, leaseId)).reason, "finished");
      assert.equal(f.run(["rev-parse", "target"]), view.attempts[0]!.attempt.resultCommit);
      const record = (await f.deps.attempts.findByLease(leaseId))!;
      assert.equal(record.entries.filter(e => e.kind === "integrated").length, 1);
      assert.equal(record.entries.filter(e => e.kind === "lease_returned").length, 1);
    } else {
      assert.equal((await run("finish", deps, leaseId)).reason, "reconciliation_required");
      assert.equal(f.run(["rev-parse", "target"]), f.run(["rev-parse", "main"]));
    }
  });
}

for (const operation of ["finish", "discard"] as const) {
  test(`${operation}: classification reads a return intent recorded while the owner read was in progress`, async () => {
    const { f, leaseId } = await reviewed();
    const command = await failedCommand();
    let failed = false;
    const injected = inject(f.deps, "leases", async () => {
      if (failed) return;
      failed = true;
      const record = (await f.deps.attempts.findByLease(leaseId))!;
      const returnId = randomUUID();
      await f.deps.attempts.appendConfirmed(record, "lease_return_started", { leaseId, by: operation, returnId },
        { fact: "no_processes", scope: { leaseId, returnId } }, "operator:fixture");
      throw new WorkspaceError("unreadable", "Read failed after another command's intent", describeCommand(command));
    });
    assert.equal((await run(operation, injected.deps, leaseId)).reason, "reconciliation_required");
    assert.equal((await run(operation, injected.deps, leaseId)).reason, "reconciliation_required");
    assert.equal(injected.returns(), 0);
    const record = (await f.deps.attempts.findByLease(leaseId))!;
    assert.equal(record.entries.find(e => e.kind === "owner_read_failed")!.data.classification, "effect_uncertain");
  });
}
