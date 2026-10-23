import assert from "node:assert/strict";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sampleRequest } from "../scenario/common-tests.ts";
import { FakeOwners } from "../scenario/owners.ts";
import { HostClient } from "./client.ts";

const root = fileURLToPath(new URL("../../../.investigation/durable-orchestration/", import.meta.url));
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error && !("code" in error && typeof error.code === "number")) reject(error);
      else resolve({ code: error?.code as number ?? 0, stdout, stderr });
    });
  });
}
async function start(directory: string): Promise<{ child: ChildProcess; exited: Promise<number | null>; output: () => string }> {
  const child = fork(cli, ["host", directory], { execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  child.stdout!.on("data", data => { output += data; });
  child.stderr!.on("data", data => { output += data; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Host startup timed out: ${output}`)), 10_000);
      const message = (value: unknown) => {
        if (value && typeof value === "object" && "status" in value && value.status === "ready") finish();
      };
      const exit = () => finish(new Error(`Host exited before ready: ${output}`));
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.off("message", message);
        child.off("exit", exit);
        child.off("error", finish);
        if (error) reject(error); else resolve();
      };
      child.on("message", message);
      child.once("exit", exit);
      child.once("error", finish);
    });
    return { child, exited, output: () => output };
  } catch (error) { child.kill("SIGKILL"); await exited; throw error; }
}
async function stop(process: Awaited<ReturnType<typeof start>>): Promise<void> {
  if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGKILL");
  await process.exited;
}
async function initialise(maximum = 1): Promise<string> {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "design-b-cli-"));
  const result = await run("init", directory);
  assert.equal(result.code, 0, result.stderr);
  await writeFile(join(directory, "config.json"), JSON.stringify({ maxAttempts: maximum }), { flush: true });
  return directory;
}

test("B: separate CLI clients share one host, transactional capacity and stable retries", async t => {
  const directory = await initialise(2);
  const startAt = performance.now();
  const host = await start(directory);
  const startupMs = performance.now() - startAt;
  t.after(async () => { await stop(host); await rm(directory, { recursive: true, force: true }); });
  const second = await run("host", directory);
  assert.equal(second.code, 2);
  assert.match(second.stderr, /Host ownership unavailable/);
  const files = await Promise.all(["one", "two", "three"].map(async id => {
    const path = join(directory, `${id}.json`);
    await writeFile(path, JSON.stringify(sampleRequest(id)));
    return path;
  }));
  const results = await Promise.all(files.map(path => run("submit", directory, path)));
  const outcomes = results.map(result => JSON.parse(result.stdout));
  assert.equal(outcomes.filter(outcome => outcome.status === "waiting").length, 2);
  assert.equal(outcomes.filter(outcome => outcome.code === "capacity").length, 1);
  const admitted = outcomes.findIndex(outcome => outcome.status === "waiting");
  const repeatAt = performance.now();
  const retry = await run("submit", directory, files[admitted]!);
  const retryMs = performance.now() - repeatAt;
  assert.deepEqual(JSON.parse(retry.stdout), outcomes[admitted]);
  const request = JSON.parse(await readFile(files[admitted]!, "utf8"));
  const client = new HostClient(directory);
  const snapshot = JSON.parse((await run("inspect", directory)).stdout);
  assert.equal(snapshot.active, 2);
  assert.equal(snapshot.attempts.length, 2);
  const owners = new FakeOwners(join(directory, "owners"), join(directory, "host"));
  for (const attempt of snapshot.attempts) {
    const counts = await owners.counters(attempt.id);
    assert.equal(counts.acquire, 1);
    assert.equal(counts.launch, 1);
    assert.equal(counts.prompt, 1);
  }
  const wait = await run("wait", directory, request.requestId, "300");
  assert.equal(JSON.parse(wait.stdout).status, "waiting", "An optional bounded client wait neither cancels nor owns execution");
  const status = await client.call("diagnostics") as { engine: { tasks: unknown[] } };
  assert.equal(status.engine.tasks.length, 2);
  const shutdownAt = performance.now();
  const shutdown = await run("shutdown", directory);
  assert.equal(JSON.parse(shutdown.stdout).workerTermination, "unverified");
  assert.equal(JSON.parse(shutdown.stdout).leases, "retained");
  assert.equal(await host.exited, 0, host.output());
  const shutdownMs = performance.now() - shutdownAt;
  assert.equal((await client.submit(request)).status, "refused");
  await assert.rejects(readFile(join(directory, "host", "owner", "claim.json")), /ENOENT/);
  t.diagnostic(JSON.stringify({ platform: process.platform, node: process.version, startupMs, retryCliMs: retryMs, shutdownMs }));
});

for (const state of ["empty", "returned", "unknown"] as const) {
  test(`B: shutdown reads the current ${state} owner lease listing`, async t => {
    const directory = await initialise();
    const owners = new FakeOwners(join(directory, "owners"), join(directory, "host"));
    if (state === "returned") {
      const identity = await owners.acquire("scenario", "task", "attempt");
      await owners.returnWorkspace(identity);
    }
    if (state === "unknown") await owners.setControls({ ...await owners.controls(), unknown: true });
    const host = await start(directory);
    t.after(async () => { await stop(host); await rm(directory, { recursive: true, force: true }); });
    const shutdown = await run("shutdown", directory);
    assert.equal(shutdown.code, 0, shutdown.stderr);
    assert.deepEqual(JSON.parse(shutdown.stdout), {
      status: "stopping", workerTermination: "unverified", leases: state === "unknown" ? "not checked" : "none",
    });
    assert.equal(await host.exited, 0, host.output());
  });
}

test("B: a killed host leaves exclusive ownership visible; confirmed fixture recovery never replaces its worker", async t => {
  const directory = await initialise(2);
  const host = await start(directory);
  let reopened: Awaited<ReturnType<typeof start>> | undefined;
  t.after(async () => { await stop(host); if (reopened) await stop(reopened); await rm(directory, { recursive: true, force: true }); });
  const client = new HostClient(directory);
  const request = sampleRequest();
  assert.equal((await client.submit(request)).status, "waiting");
  host.child.kill("SIGKILL");
  await host.exited;
  const claim = JSON.parse(await readFile(join(directory, "host", "owner", "claim.json"), "utf8"));
  assert.equal(claim.pid, host.child.pid);
  const refused = await run("host", directory);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /confirm host\/worker termination/);
  assert.equal((await client.advance(request.requestId)).status, "refused");
  // Test/operator action after joining the killed host. Only fake worker receipts exist in this
  // fixture; no process can still use its fake workspace. This is not automatic claim recovery.
  await rm(join(directory, "host", "owner"), { recursive: true });
  reopened = await start(directory);
  const retry = await client.submit(request);
  assert.equal(retry.status, "refused");
  if (retry.status === "refused") assert.equal(retry.code, "possibly_running");
  const snapshot = await client.inspect();
  assert.equal(snapshot.attempts.length, 1);
  const owners = new FakeOwners(join(directory, "owners"), join(directory, "host"));
  const counts = await owners.counters(snapshot.attempts[0]!.id);
  assert.equal(counts.launch, 1);
  assert.equal(counts.prompt, 1);
  assert.equal(counts.return, 0);
  await client.call("shutdown");
  assert.equal(await reopened.exited, 0, reopened.output());
});
