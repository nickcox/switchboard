import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { command, fixture, node, object, runDir } from "./helpers.ts";

async function firstRecord(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!buffer.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Process exited before readiness acknowledgement");
      buffer += decoder.decode(value, { stream: true });
    }
    return object(JSON.parse(buffer.split("\n")[0]!));
  } finally {
    reader.releaseLock();
  }
}
function record(event: Record<string, unknown>) {
  appendFileSync(join(runDir, "process-results.jsonl"), `${JSON.stringify(event)}\n`);
}
function kill(pid: number) {
  try { process.kill(pid, "SIGKILL"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
const lockScript = join(import.meta.dir, "fixtures/lock-owner.ts");
const workerScript = join(import.meta.dir, "fixtures/process-worker.ts");

test("macOS flock via Bun FFI rejects contenders and releases after graceful process exit", async () => {
  const f = fixture("lock-exit");
  const lock = join(f.dir, "context.lock");
  const owner = Bun.spawn([process.execPath, lockScript, lock, "hold"], { env: f.env, cwd: f.dir, stdout: "pipe", stderr: "inherit" });
  try {
    const identity = await firstRecord(owner.stdout);
    expect(identity.locked).toBe(true);
    expect(identity.closeOnExec).toBe(true);
    const contender = await command(f, [process.execPath, lockScript, lock], { allowFailure: true });
    expect(contender.code).toBe(73);
    owner.kill("SIGTERM");
    expect(await owner.exited).toBe(0);
    expect((await command(f, [process.execPath, lockScript, lock])).code).toBe(0);
    record({ test: "flock graceful exit", identity, contenderCode: contender.code });
  } finally { if (owner.exitCode === null) kill(owner.pid); await owner.exited; }
});

test("SIGKILL releases flock even while a spawned child remains alive", async () => {
  const f = fixture("lock-crash");
  const lock = join(f.dir, "context.lock");
  const owner = Bun.spawn([process.execPath, lockScript, lock, "with-child"], { env: f.env, cwd: f.dir, stdout: "pipe", stderr: "inherit" });
  let childPid: number | undefined;
  try {
    const identity = await firstRecord(owner.stdout);
    childPid = Number(identity.childPid);
    expect(Number.isSafeInteger(childPid)).toBe(true);
    expect(identity.locked).toBe(true);
    expect(identity.closeOnExec).toBe(true);
    kill(owner.pid);
    await owner.exited;
    expect(() => process.kill(childPid!, 0)).not.toThrow();
    expect((await command(f, [process.execPath, lockScript, lock])).code).toBe(0);
    record({ test: "flock owner crash with live child", identity, ownerExit: owner.exitCode, childStillAlive: true });
  } finally {
    if (owner.exitCode === null) kill(owner.pid);
    if (childPid) kill(childPid);
    await owner.exited;
  }
});

for (const executable of [process.execPath, node!]) {
  test(`Bun launches ${executable} in an exact cwd with metadata, and stop requires observing actual exit`, async () => {
    const f = fixture("process-stop");
    const child = Bun.spawn([executable, workerScript, "cooperative"], {
      cwd: f.dir, env: { ...f.env, PROBE_TASK_ID: "task-a1", PROBE_LEASE_ID: "lease-1" }, stdout: "pipe", stderr: "inherit",
    });
    try {
      const identity = await firstRecord(child.stdout);
      expect(identity.cwd).toBe(f.dir);
      expect(identity.taskId).toBe("task-a1");
      expect(identity.leaseId).toBe("lease-1");
      child.kill("SIGTERM");
      const immediate = await Promise.race([child.exited.then(() => "exited"), Bun.sleep(20).then(() => "not-yet-exited")]);
      expect(immediate).toBe("not-yet-exited");
      expect(await child.exited).toBe(0);
      record({ test: "cooperative worker", executable, identity, immediate, exit: child.exitCode });
    } finally { if (child.exitCode === null) kill(child.pid); await child.exited; }
  });
}

test("a worker ignoring SIGTERM remains live until escalation is confirmed", async () => {
  const f = fixture("process-stubborn");
  const child = Bun.spawn([process.execPath, workerScript, "stubborn"], { cwd: f.dir, env: f.env, stdout: "pipe", stderr: "inherit" });
  try {
    await firstRecord(child.stdout);
    child.kill("SIGTERM");
    const observation = await Promise.race([child.exited.then(() => "exited"), Bun.sleep(100).then(() => "deadline")]);
    expect(observation).toBe("deadline");
    expect(() => process.kill(child.pid, 0)).not.toThrow();
    child.kill("SIGKILL");
    expect(await child.exited).not.toBe(0);
    record({ test: "stubborn worker", observation, finalExit: child.exitCode, signal: child.signalCode });
  } finally { if (child.exitCode === null) kill(child.pid); await child.exited; }
});
