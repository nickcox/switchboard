import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { key } from "../../../src/runtime/records.ts";
import { HostClient } from "../design-b/client.ts";
import { assertRefused } from "../scenario/assertions.ts";
import type { Outcome } from "../scenario/contract.ts";
import { approve, recoverClaim, review, waitForWorker } from "./control.ts";
import { initialise, settingsAt } from "./fixture.ts";
import { RealOwners, environment } from "./owners.ts";

const execute = promisify(execFile);
async function command(directory: string, method: string, ...args: string[]): Promise<unknown> {
  const result = await execute(process.execPath, [fileURLToPath(new URL("./cli.ts", import.meta.url)), method, directory, ...args], { timeout: 10_000 });
  return JSON.parse(result.stdout);
}

async function advanceTo(client: HostClient, requestId: string, expected: string): Promise<Outcome> {
  const deadline = Date.now() + 5000;
  let outcome: Outcome;
  do {
    outcome = await client.advance(requestId);
    if ((outcome.status === "refused" ? outcome.code : outcome.status) === expected) return outcome;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return outcome;
}

async function fixture(design: "A" | "B", scenario = "commit-result") {
  const temporary = resolve(import.meta.dirname, "../../../.investigation/durable-orchestration");
  await mkdir(temporary, { recursive: true });
  const parent = await mkdtemp(join(temporary, `real-${design}-`));
  const directory = join(parent, "run");
  const config = join(parent, "source-config.json");
  const instructions = join(parent, "instructions.md");
  await writeFile(instructions, "Create worker-output.txt, check it and commit on the supplied output branch. Report tests and code.\n");
  await writeFile(config, JSON.stringify({ contextId: "must-not-open", runtimeRoot: join(parent, "forbidden-runtime"),
    databasePath: join(parent, "forbidden.db"), tasks: { repo: "must-not-open" },
    workspaces: { repository: join(parent, "forbidden-repository"), poolRoot: join(parent, "forbidden-pool") },
    delivery: { baseRef: "main", requiredEvidence: ["tests"], requiredDeliverables: ["code"] }, keepAwake: false,
    worker: { piEntrypoint: resolve(import.meta.dirname, "../../../tests/fixtures/pi-rpc.ts"), provider: "fixture", model: "fixture", thinking: "high",
      runMs: 5000, statsMs: 100, maxCost: 1, maxTokens: 10000,
      environment: { ...environment(), FAKE_PI_SCENARIO: scenario, FAKE_PI_LOG: join(parent, "rpc.jsonl") } },
  }));
  await initialise(directory, design, config, instructions);
  const settings = await settingsAt(directory);
  const owners = await RealOwners.open(directory, settings);
  const children: { child: ChildProcess; exit: Promise<{ code: number | null; signal: string | null }> }[] = [];
  const start = async (args: string[] = []) => {
    const child = fork(new URL("./cli.ts", import.meta.url), [args.length ? "run" : "host", directory, ...args], {
      execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "";
    child.stdout!.on("data", data => { output += data; });
    child.stderr!.on("data", data => { output += data; });
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    children.push({ child, exit });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Host startup timed out: ${output}`)), 10_000);
      const message = (value: unknown) => {
        if (value && typeof value === "object" && "type" in value && value.type === "ready") finish();
      };
      const ended = () => finish(new Error(`Host exited before readiness: ${output}`));
      const finish = (error?: Error) => {
        clearTimeout(timer); child.off("message", message); child.off("exit", ended);
        if (error) reject(error); else resolve();
      };
      child.on("message", message); child.once("exit", ended);
    });
    return { child, exit, output: () => output };
  };
  return { directory, parent, settings, owners, start, client: new HostClient(directory),
    close: async () => {
      for (const { child, exit } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exit;
      }
      await owners.close();
      await rm(parent, { recursive: true, force: true });
    } };
}

for (const design of ["A", "B"] as const) {
  test(`${design}: real Treehouse and fake Pi complete once, restart at review and require scoped return approval`, async () => {
    const f = await fixture(design);
    try {
      let host = await f.start(["--wait-ms", "10000"]);
      const submitted = await f.client.submit(f.settings.request);
      assert.equal(submitted.status, "waiting");
      assert.equal((await f.client.submit(f.settings.request)).attemptId, submitted.attemptId);
      const waiting = await waitForWorker(f.directory, 10_000);
      assert.equal(waiting.status, "waiting", host.output());
      if (waiting.status === "waiting") assert.equal(waiting.waitingFor, "review");
      const attempt = (await f.client.inspect()).attempts[0]!;
      assert.ok(attempt.result);
      const allocation = await f.owners.allocation(attempt.id);
      assert.equal(allocation.leaseId, attempt.identity!.leaseId);
      assert.equal(allocation.holder, `durable-${design}:${attempt.id}`);
      assert.ok(allocation.path.startsWith(join(f.directory, "pool")));
      assert.equal((await f.owners.provider.leases()).length, 1);
      const report = await f.owners.report(attempt.id);
      assert.equal(report.status, "reported");
      assert.deepEqual(report.childExit, { started: true, code: 0, signal: null });
      assert.equal(report.binding.input.instructions, f.settings.instructions);
      assert.equal(report.binding.input.workspace, allocation.path);
      assert.equal(report.binding.input.delivery.startingCommit, allocation.startingCommit);
      assert.ok(report.directory.startsWith(join(f.directory, "owners", "runtime")));
      assert.equal(report.workerTermination, "unverified");
      for (const path of ["forbidden-runtime", "forbidden.db", "forbidden-repository", "forbidden-pool"]) {
        await assert.rejects(() => stat(join(f.parent, path)), { code: "ENOENT" });
      }
      const rpc = (await readFile(join(f.parent, "rpc.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(rpc.filter(record => record.type === "prompt").length, 1);
      const launch = JSON.parse(await readFile(join(report.directory, "fixture-launch.json"), "utf8"));
      assert.equal(launch.cwd, allocation.path);
      assert.ok(launch.argv.includes("high"));
      assert.equal((await f.owners.controls()).retainedCommit, attempt.result.commit);
      assert.equal((await f.owners.counters(attempt.id)).return, 0);
      await assert.rejects(() => f.owners.returnWorkspace(attempt.identity!), /scoped/);
      await f.client.call("shutdown");
      assert.deepEqual(await host.exit, { code: 0, signal: null }, host.output());
      // A genuinely new process reopens both application and (for B) execution stores.
      host = await f.start();
      assert.equal((await waitForWorker(f.directory, 3000)).status, "waiting");
      await command(f.directory, "review", "--attempt", attempt.id, "--commit", attempt.result.commit, "--decision", "accepted");
      await review(f.directory, attempt.id, attempt.result.commit, "accepted");
      assertRefused(await advanceTo(f.client, f.settings.request.requestId, "approval_required"), "approval_required");
      assert.equal((await f.owners.counters(attempt.id)).return, 0);
      await command(f.directory, "approve", "--attempt", attempt.id, "--lease", attempt.identity!.leaseId,
        "--commit", attempt.result.commit, "--accept", "--expires-ms", "60000");
      assertRefused(await advanceTo(f.client, f.settings.request.requestId, "process_confirmation_required"), "process_confirmation_required");
      await assert.rejects(() => f.owners.returnWorkspace(attempt.identity!), /scoped/);
      const controls = await f.owners.controls();
      assert.equal(controls.approvals.length, 1);
      await approve(f.directory, { attemptId: attempt.id, leaseId: attempt.identity!.leaseId, commit: attempt.result.commit,
        accept: true, noProcesses: true, expiresMs: 60_000 });
      assert.equal((await f.owners.controls()).approvals.length, 1, "a new grant replaces the same scope");
      assert.equal((await advanceTo(f.client, f.settings.request.requestId, "completed")).status, "completed");
      assert.equal((await f.owners.provider.leases()).length, 0);
      assert.deepEqual(await f.owners.counters(attempt.id), {
        acquire: 1, launch: 1, prompt: 1, worker_exit: 1, review: 2, merge: 0, return: 1, cancel: 0,
      });
      assert.equal((await f.client.inspect()).attempts[0]!.done, true);
      await f.client.call("shutdown");
      assert.deepEqual(await host.exit, { code: 0, signal: null }, host.output());
    } finally { await f.close(); }
  });

  test(`${design}: lost real acquisition acknowledgement retains lease and refuses acquisition_uncertain on retry`, async () => {
    const f = await fixture(design);
    try {
      const host = await f.start(["--stop-after-acquire"]);
      assert.equal((await host.exit).signal, "SIGKILL", host.output());
      const receipts = await f.owners.records();
      assert.equal(receipts.length, 1);
      const acquisition = receipts[0]!;
      assert.equal(acquisition.effect, "acquire");
      const leases = await f.owners.provider.leases();
      assert.equal(leases.length, 1);
      assert.equal(leases[0]!.leaseId, acquisition.identity!.leaseId);
      assert.equal(leases[0]!.holder, `durable-${design}:${acquisition.attemptId}`);
      await assert.rejects(() => recoverClaim(f.directory, true, false), /confirm/);
      await recoverClaim(f.directory, true, true);
      const restarted = await f.start();
      assertRefused(await f.client.submit(f.settings.request), "acquisition_uncertain");
      assert.equal((await f.client.inspect()).attempts.length, 1);
      assert.equal((await f.client.inspect()).attempts[0]!.identity, null);
      const counters = await f.owners.counters(acquisition.attemptId);
      assert.equal(counters.acquire, 1);
      assert.equal(counters.launch, 0);
      assert.equal(counters.prompt, 0);
      assert.equal(counters.return, 0);
      assert.equal((await f.owners.provider.leases()).length, 1);
      await f.client.call("shutdown");
      assert.deepEqual(await restarted.exit, { code: 0, signal: null }, restarted.output());
    } finally { await f.close(); }
  });
}

test("RealOwners records a prompt on started, but never an exit from result-file presence alone", async () => {
  const f = await fixture("A", "delay-exit");
  try {
    const identity = await f.owners.acquire("scenario", f.settings.request.taskId, randomUUID());
    await f.owners.launch(identity);
    assert.equal((await f.owners.counters(identity.attemptId)).launch, 1);
    assert.equal((await f.owners.counters(identity.attemptId)).prompt, 0);
    await f.owners.prompt(identity);
    assert.equal((await f.owners.counters(identity.attemptId)).prompt, 1);
    const runtime = join(f.directory, "owners", "runtime", key(identity.contextId), key(identity.leaseId));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { await stat(join(runtime, "fixture-eof")); break; } catch { await new Promise(resolve => setTimeout(resolve, 5)); }
    }
    await stat(join(runtime, "fixture-eof"));
    await stat(join(runtime, "result.json"));
    assert.equal((await f.owners.counters(identity.attemptId)).worker_exit, 0);
    await f.owners.waitForWorker();
    assert.equal((await f.owners.counters(identity.attemptId)).worker_exit, 1);
    assert.deepEqual((await f.owners.report(identity.attemptId)).childExit, { started: true, code: 0, signal: null });
    // This fake scenario reports a non-existent commit, which actual Git retention rejects.
    const result = (await f.owners.forAttempt(identity.attemptId)).find(receipt => receipt.effect === "worker_exit")!.result!;
    await approve(f.directory, { attemptId: identity.attemptId, leaseId: identity.leaseId, commit: result.commit,
      accept: true, noProcesses: true, expiresMs: 60_000 });
    assert.equal((await f.owners.controls()).retainedCommit, null);
    await assert.rejects(() => f.owners.returnWorkspace(identity), /retained output/);
    assert.equal((await f.owners.provider.leases()).length, 1);
  } finally { await f.close(); }
});

test("RealOwners rejects wrong and expired scopes even when called outside a design", async () => {
  const f = await fixture("A");
  try {
    const identity = await f.owners.acquire("scenario", f.settings.request.taskId, randomUUID());
    await f.owners.launch(identity);
    await f.owners.prompt(identity);
    await f.owners.waitForWorker();
    const result = (await f.owners.forAttempt(identity.attemptId)).find(receipt => receipt.effect === "worker_exit")!.result!;
    await assert.rejects(() => approve(f.directory, { attemptId: identity.attemptId, leaseId: "wrong-lease", commit: result.commit,
      accept: true, noProcesses: true, expiresMs: 60_000 }), /scope differs/);
    await approve(f.directory, { attemptId: identity.attemptId, leaseId: identity.leaseId, commit: result.commit,
      accept: true, noProcesses: true, expiresMs: 60_000 });
    const controls = await f.owners.controls();
    for (const changes of [{ leaseId: "wrong-lease" }, { attemptId: "wrong-attempt" }, { commit: "0".repeat(40) },
      { expiresAt: Date.now() - 1 }, { by: "model" }, { accept: false }, { noProcesses: false }]) {
      await f.owners.setControls({ ...controls, approvals: [{ ...controls.approvals[0]!, ...changes } as typeof controls.approvals[number]] });
      await assert.rejects(() => f.owners.returnWorkspace(identity), /scoped/);
    }
    assert.equal((await f.owners.counters(identity.attemptId)).return, 0);
    assert.equal((await f.owners.provider.leases()).length, 1);
    await f.owners.setControls(controls);
    const interrupted = await RealOwners.open(f.directory, f.settings, async point => {
      if (point === "return:effect:before") await f.owners.setControls({ ...controls, approvals: [] });
    });
    try { await assert.rejects(() => interrupted.returnWorkspace(identity), /scoped/); }
    finally { await interrupted.close(); }
    assert.equal((await f.owners.counters(identity.attemptId)).return, 0);
  } finally { await f.close(); }
});
