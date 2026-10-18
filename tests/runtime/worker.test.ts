import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "../helpers.ts";

async function requests(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
}
async function waitForPrompt(path: string): Promise<void> {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    try { if ((await requests(path)).some(record => record.type === "prompt")) return; } catch { /* Await fixture readiness. */ }
    await sleep(10);
  }
  throw new Error("Fixture never received prompt");
}

test("RPC worker uses exact cwd/session and standard tools, retains result, and observes child exit", async () => {
  const f = fixture();
  const report = await f.worker.execute(f.input);
  assert.equal(report.status, "reported");
  assert.deepEqual(report.childExit, { started: true, code: 0, signal: null });
  assert.deepEqual(report.result?.identity, f.input.identity);
  assert.equal(report.result?.outcome, "completed");
  assert.equal(report.workerTermination, "unverified");
  const launch = JSON.parse(await readFile(join(report.directory, "fixture-launch.json"), "utf8"));
  assert.equal(launch.cwd, f.input.workspace);
  assert.ok(launch.argv.includes("--no-extensions"));
  assert.ok(launch.argv.includes("--no-mcp"));
  assert.ok(launch.argv.includes("--session-id"));
  assert.ok(launch.argv.includes(f.input.identity.sessionId));
  assert.ok(launch.argv.includes("read,edit,write,bash"));
  assert.equal((await requests(f.log)).filter(r => r.type === "prompt").length, 1);
  const prompt = (await requests(f.log)).find(r => r.type === "prompt");
  assert.ok(String(prompt?.message).includes(f.input.instructions));
  assert.ok(String(prompt?.message).includes(f.input.delivery.outputBranch));
  const discovered = await f.records.discover(f.input.identity.contextId);
  assert.equal(discovered[0]?.child.status, "exited");
});

for (const scenario of ["missing-result", "malformed-result", "stale-result", "missing-evidence", "wrong-branch", "large-result"]) {
  test(`worker refuses ${scenario} even after successful model settlement and child exit`, async () => {
    const f = fixture(scenario);
    const report = await f.worker.execute(f.input);
    assert.equal(report.status, "failed");
    assert.equal(report.reason, "invalid_result");
    assert.equal(report.result, undefined);
    assert.equal(report.childExit?.code, 0);
  });
}

test("worker refuses a symlinked result file", { skip: process.platform === "win32" }, async () => {
  const f = fixture("symlink-result");
  const report = await f.worker.execute(f.input);
  assert.equal(report.reason, "invalid_result");
});

for (const scenario of ["wrong-session", "wrong-model", "bad-json", "wrong-response", "handled", "model-error", "nonzero-exit", "trailing-json", "startup-exit"]) {
  test(`protocol/lifecycle failure ${scenario} cannot produce accepted worker evidence`, async () => {
    const f = fixture(scenario);
    const report = await f.worker.execute(f.input);
    assert.equal(report.status, "failed");
    assert.equal(report.result, undefined);
    assert.notEqual(report.childExit, undefined);
  });
}

for (const outcome of ["hold", "failed"] as const) {
  test(`a valid ${outcome} report is preserved as a worker outcome, not relabelled as success`, async () => {
    const f = fixture(outcome);
    const report = await f.worker.execute(f.input);
    assert.equal(report.status, "reported");
    assert.equal(report.result?.outcome, outcome);
    assert.equal(report.workerTermination, "unverified");
  });
}

test("run events can precede the prompt acknowledgement without being lost", async () => {
  const f = fixture("fast-events");
  assert.equal((await f.worker.execute(f.input)).status, "reported");
});

test("a lost prompt acknowledgement never causes a second prompt or launch", async () => {
  const f = fixture("no-ack", { requestMs: 1000 });
  const report = await f.worker.execute(f.input);
  assert.equal(report.reason, "rpc_timeout");
  assert.equal(report.result, undefined);
  assert.equal((await requests(f.log)).filter(r => r.type === "prompt").length, 1);
  await assert.rejects(f.worker.execute(f.input));
  assert.equal((await requests(f.log)).filter(r => r.type === "prompt").length, 1);
});

test("idleness without a current agent run cannot satisfy completion", async () => {
  const f = fixture("idle-only", { runMs: 100 });
  const report = await f.worker.execute(f.input);
  assert.equal(report.reason, "worker_timeout");
  assert.equal(report.result, undefined);
});

test("an idle startup event cannot complete or interfere with the later assigned run", async () => {
  const f = fixture("startup-settled");
  assert.equal((await f.worker.execute(f.input)).status, "reported");
});

test("agent settlement waits for actual child exit before reading the result", async () => {
  const f = fixture("delay-exit");
  const start = Date.now();
  const report = await f.worker.execute(f.input);
  assert.ok(Date.now() - start >= 140);
  assert.equal(report.status, "reported");
  assert.equal(report.childExit?.code, 0);
});

test("operator interruption requests queue clearing and abort; it ignores a completion file", async () => {
  const f = fixture("ignore-stop", { runMs: 5000 });
  const controller = new AbortController();
  const running = f.worker.execute(f.input, controller.signal);
  await waitForPrompt(f.log);
  controller.abort();
  const report = await running;
  const sent = await requests(f.log);
  assert.equal(sent.some(r => r.type === "clear_queue"), true);
  assert.equal(sent.some(r => r.type === "abort"), true);
  assert.equal(report.status, "interrupted");
  assert.equal(report.result, undefined);
  assert.equal(report.childExit?.signal, "SIGKILL");
  assert.equal(report.workerTermination, "unverified");
});

test("interruption during orderly child shutdown still prevents reporting completion", async () => {
  const f = fixture("delay-exit");
  const controller = new AbortController();
  const running = f.worker.execute(f.input, controller.signal);
  await waitForPrompt(f.log);
  const record = (await f.records.discover(f.input.identity.contextId))[0]!;
  const end = Date.now() + 3000;
  while (true) {
    try { await stat(join(record.directory, "fixture-eof")); break; }
    catch { if (Date.now() >= end) throw new Error("No EOF observed"); await sleep(5); }
  }
  controller.abort();
  const report = await running;
  assert.equal(report.status, "interrupted");
  assert.equal(report.result, undefined);
});

test("an interrupted invocation does not launch at all", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.worker.execute(f.input, controller.signal), /Interrupted/);
  await assert.rejects(stat(f.log));
  assert.deepEqual(await f.records.discover(f.input.identity.contextId), []);
});

test("an input too large for discovery is refused before starting a worker", async () => {
  const f = fixture();
  f.input.instructions = "x".repeat(1024 * 1024);
  await assert.rejects(f.worker.execute(f.input), /exceeds byte limit/);
  await assert.rejects(stat(f.log));
});

test("missing executable is a definite no-child failure with retained identity", async () => {
  const f = fixture("normal", { executable: join(import.meta.dirname, "does-not-exist") });
  const report = await f.worker.execute(f.input);
  assert.equal(report.status, "failed");
  assert.equal(report.childExit?.started, false);
  assert.equal(report.result, undefined);
  assert.equal((await f.records.discover(f.input.identity.contextId))[0]?.child.status, "exited");
});
