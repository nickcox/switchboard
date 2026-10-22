import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { HostClient } from "../design-b/client.ts";
import { assertRefused } from "../scenario/assertions.ts";
import { approve, recoverClaim, review, waitForWorker } from "./control.ts";
import { initialise, settingsAt } from "./fixture.ts";
import { RealOwners, environment } from "./owners.ts";

async function fixture(design: "A" | "B") {
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
      environment: { ...environment(), FAKE_PI_SCENARIO: "commit-result", FAKE_PI_LOG: join(parent, "rpc.jsonl") } },
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
      let host = await f.start();
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
      await review(f.directory, attempt.id, attempt.result.commit, "accepted");
      await review(f.directory, attempt.id, attempt.result.commit, "accepted");
      assertRefused(await f.client.advance(f.settings.request.requestId), "approval_required");
      assert.equal((await f.owners.counters(attempt.id)).return, 0);
      await approve(f.directory, { attemptId: attempt.id, leaseId: attempt.identity!.leaseId, commit: attempt.result.commit,
        accept: true, noProcesses: false, expiresMs: 60_000 });
      assertRefused(await f.client.advance(f.settings.request.requestId), "process_confirmation_required");
      await assert.rejects(() => f.owners.returnWorkspace(attempt.identity!), /scoped/);
      // Replace the acceptance-only scope rather than leaving two competing current approvals.
      const controls = await f.owners.controls();
      await f.owners.setControls({ ...controls, approvals: [] });
      await approve(f.directory, { attemptId: attempt.id, leaseId: attempt.identity!.leaseId, commit: attempt.result.commit,
        accept: true, noProcesses: true, expiresMs: 60_000 });
      assert.equal((await f.client.advance(f.settings.request.requestId)).status, "completed");
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
