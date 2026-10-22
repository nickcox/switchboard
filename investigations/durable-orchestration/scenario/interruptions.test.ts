import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Effect, Point } from "./contract.ts";
import { effects, interruptionPoints } from "./contract.ts";
import { FakeOwners } from "./owners.ts";

const root = fileURLToPath(new URL("../../../.investigation/durable-orchestration/", import.meta.url));
const childProgram = fileURLToPath(new URL("./interruption-child.ts", import.meta.url));

// Expected owner receipts, independent of the reference runner's state or return value.
function expectedEffects(point: Point): Effect[] {
  const [name, kind, side] = point.split(":");
  const cancellation = name === "cancel" || name === "cancelled";
  const path: Effect[] = cancellation ? ["acquire", "launch", "prompt", "cancel"] :
    ["acquire", "launch", "prompt", "worker_exit", name === "merge" ? "merge" : "review", "return"];
  if (kind === "effect") {
    const index = path.indexOf(name as Effect);
    assert.ok(index >= 0);
    return path.slice(0, index + (side === "after" ? 1 : 0));
  }
  const acknowledged: Record<string, number> = {
    reserved: 0, workspace: 1, started: 1, launched: 2, prompted: 3,
    result: 4, review: 5, accepted: 5, done: 5, returned: 6, cancelled: 4,
  };
  assert.ok(name && name in acknowledged);
  return path.slice(0, acknowledged[name]);
}

for (const point of interruptionPoints) {
  test(`SIGKILL at ${point} preserves independent owner receipts`, async t => {
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "kill-"));
    const owners = new FakeOwners(join(directory, "owners"), join(directory, "host"));
    await owners.initialise();
    const child = fork(childProgram, [directory, point], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = "";
    child.stderr!.on("data", data => { stderr += String(data); });
    child.stdout!.resume();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await rm(directory, { recursive: true, force: true });
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out reaching ${point}: ${stderr}`)), 10_000);
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error(`Child exited before ${point}: ${stderr}`)); });
      child.on("message", message => {
        if (typeof message !== "object" || message === null || !("point" in message) || message.point !== point) return;
        clearTimeout(timeout);
        resolve();
      });
    });
    const beforeKill = await owners.records();
    assert.ok(child.kill("SIGKILL"), "The parent kills a process paused at the exact boundary");
    const termination = await exited;
    assert.equal(termination.signal, "SIGKILL", stderr);
    assert.equal(termination.code, null, stderr);
    await rm(join(directory, "host"), { recursive: true, force: true });
    const freshReader = new FakeOwners(join(directory, "owners"), join(directory, "replacement-host"));
    assert.deepEqual(await freshReader.records(), beforeKill, "Deleting all host storage cannot erase owner effects");
    const expected = expectedEffects(point);
    const records = await freshReader.records();
    for (const effect of effects) assert.equal(records.filter(record => record.effect === effect).length,
      expected.includes(effect) ? 1 : 0, `${point}: independent ${effect} count`);
  });
}
