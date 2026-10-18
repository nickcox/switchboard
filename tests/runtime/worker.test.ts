import { expect, test } from "bun:test";
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
    await Bun.sleep(10);
  }
  throw new Error("Fixture never received prompt");
}

test("RPC worker uses exact cwd/session and standard tools, retains result, and observes child exit", async () => {
  const f = fixture();
  const report = await f.worker.execute(f.input);
  expect(report.status).toBe("reported");
  expect(report.childExit).toEqual({ started: true, code: 0, signal: null });
  expect(report.result?.identity).toEqual(f.input.identity);
  expect(report.result?.outcome).toBe("completed");
  expect(report.workerTermination).toBe("unverified");
  const launch = JSON.parse(await readFile(join(report.directory, "fixture-launch.json"), "utf8"));
  expect(launch.cwd).toBe(f.input.workspace);
  expect(launch.argv).toContain("--no-extensions");
  expect(launch.argv).toContain("--no-mcp");
  expect(launch.argv).toContain("--session-id");
  expect(launch.argv).toContain(f.input.identity.sessionId);
  expect(launch.argv).toContain("read,edit,write,bash");
  expect((await requests(f.log)).filter(r => r.type === "prompt")).toHaveLength(1);
  const prompt = (await requests(f.log)).find(r => r.type === "prompt");
  expect(String(prompt?.message)).toContain(f.input.instructions);
  expect(String(prompt?.message)).toContain(f.input.delivery.outputBranch);
  const discovered = await f.records.discover(f.input.identity.contextId);
  expect(discovered[0]?.child.status).toBe("exited");
});

for (const scenario of ["missing-result", "malformed-result", "stale-result", "missing-evidence", "wrong-branch", "large-result"]) {
  test(`worker refuses ${scenario} even after successful model settlement and child exit`, async () => {
    const f = fixture(scenario);
    const report = await f.worker.execute(f.input);
    expect(report.status).toBe("failed");
    expect(report.reason).toBe("invalid_result");
    expect(report.result).toBeUndefined();
    expect(report.childExit?.code).toBe(0);
  });
}

test.skipIf(process.platform === "win32")("worker refuses a symlinked result file", async () => {
  const f = fixture("symlink-result");
  const report = await f.worker.execute(f.input);
  expect(report.reason).toBe("invalid_result");
});

for (const scenario of ["wrong-session", "wrong-model", "bad-json", "wrong-response", "handled", "model-error", "nonzero-exit", "trailing-json", "startup-exit"]) {
  test(`protocol/lifecycle failure ${scenario} cannot produce accepted worker evidence`, async () => {
    const f = fixture(scenario);
    const report = await f.worker.execute(f.input);
    expect(report.status).toBe("failed");
    expect(report.result).toBeUndefined();
    expect(report.childExit).toBeDefined();
  });
}

for (const outcome of ["hold", "failed"] as const) {
  test(`a valid ${outcome} report is preserved as a worker outcome, not relabelled as success`, async () => {
    const f = fixture(outcome);
    const report = await f.worker.execute(f.input);
    expect(report.status).toBe("reported");
    expect(report.result?.outcome).toBe(outcome);
    expect(report.workerTermination).toBe("unverified");
  });
}

test("run events can precede the prompt acknowledgement without being lost", async () => {
  const f = fixture("fast-events");
  expect((await f.worker.execute(f.input)).status).toBe("reported");
});

test("a lost prompt acknowledgement never causes a second prompt or launch", async () => {
  const f = fixture("no-ack", { requestMs: 1000 });
  const report = await f.worker.execute(f.input);
  expect(report.reason).toBe("rpc_timeout");
  expect(report.result).toBeUndefined();
  expect((await requests(f.log)).filter(r => r.type === "prompt")).toHaveLength(1);
  await expect(f.worker.execute(f.input)).rejects.toThrow();
  expect((await requests(f.log)).filter(r => r.type === "prompt")).toHaveLength(1);
});

test("idleness without a current agent run cannot satisfy completion", async () => {
  const f = fixture("idle-only", { runMs: 100 });
  const report = await f.worker.execute(f.input);
  expect(report.reason).toBe("worker_timeout");
  expect(report.result).toBeUndefined();
});

test("an idle startup event cannot complete or interfere with the later assigned run", async () => {
  const f = fixture("startup-settled");
  expect((await f.worker.execute(f.input)).status).toBe("reported");
});

test("agent settlement waits for actual child exit before reading the result", async () => {
  const f = fixture("delay-exit");
  const start = Date.now();
  const report = await f.worker.execute(f.input);
  expect(Date.now() - start).toBeGreaterThanOrEqual(140);
  expect(report.status).toBe("reported");
  expect(report.childExit?.code).toBe(0);
});

test("operator interruption requests queue clearing and abort; it ignores a completion file", async () => {
  const f = fixture("ignore-stop", { runMs: 5000 });
  const controller = new AbortController();
  const running = f.worker.execute(f.input, controller.signal);
  await waitForPrompt(f.log);
  controller.abort();
  const report = await running;
  const sent = await requests(f.log);
  expect(sent.some(r => r.type === "clear_queue")).toBe(true);
  expect(sent.some(r => r.type === "abort")).toBe(true);
  expect(report.status).toBe("interrupted");
  expect(report.result).toBeUndefined();
  expect(report.childExit?.signal).toBe("SIGKILL");
  expect(report.workerTermination).toBe("unverified");
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
    catch { if (Date.now() >= end) throw new Error("No EOF observed"); await Bun.sleep(5); }
  }
  controller.abort();
  const report = await running;
  expect(report.status).toBe("interrupted");
  expect(report.result).toBeUndefined();
});

test("an interrupted invocation does not launch at all", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(f.worker.execute(f.input, controller.signal)).rejects.toThrow("Interrupted");
  await expect(stat(f.log)).rejects.toThrow();
  expect(await f.records.discover(f.input.identity.contextId)).toEqual([]);
});

test("an input too large for discovery is refused before starting a worker", async () => {
  const f = fixture();
  f.input.instructions = "x".repeat(1024 * 1024);
  await expect(f.worker.execute(f.input)).rejects.toThrow("exceeds byte limit");
  await expect(stat(f.log)).rejects.toThrow();
});

test("missing executable is a definite no-child failure with retained identity", async () => {
  const f = fixture("normal", { executable: join(import.meta.dir, "does-not-exist") });
  const report = await f.worker.execute(f.input);
  expect(report.status).toBe("failed");
  expect(report.childExit?.started).toBe(false);
  expect(report.result).toBeUndefined();
  expect((await f.records.discover(f.input.identity.contextId))[0]?.child.status).toBe("exited");
});
