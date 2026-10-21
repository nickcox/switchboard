import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { fixture, task } from "./fixture.ts";

const run = promisify(execFile);

test("two dispatcher processes using one request ID launch only one attempt", async () => {
  const f = await fixture({ tasks: [task("race-a1")], scenario: "commit-result" });
  const invoke = async () => {
    try { return await run(process.execPath, [resolve("src/cli.ts"), "dispatch", "--once", "--request-id", "same", "--json", "--config", f.config]); }
    catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1, result.stderr);
      return result;
    }
  };
  const outcomes = (await Promise.all([invoke(), invoke()])).map(r => JSON.parse(r.stdout));
  assert.equal(outcomes.filter(r => r.reason === "held").length, 1);
  const attempts = f.deps.attempts.list();
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.entries.filter(e => e.kind === "task_started").length, 1);
  assert.equal(attempts[0]!.entries.filter(e => e.kind === "launched").length, 1);
  assert.equal((await f.runtime.discover(f.deps.contextId)).length, 1);
  assert.equal((await f.deps.workspaces.leases()).length, 1);
});

test("killing a dispatcher inside its reservation transaction rolls back all records and releases the lock", async () => {
  const f = await fixture({ tasks: [task("crash-a1")], scenario: "commit-result" });
  const child = spawn(process.execPath, [resolve("tests/fixtures/crash-reservation-dispatch.ts"), f.config], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    await Promise.race([
      once(child.stdout, "data").then(([chunk]) => assert.match(String(chunk), /locked/)),
      exited.then(() => { throw new Error(`Dispatcher exited before its transaction: ${stderr}`); }),
      sleep(10_000, undefined, { ref: false }).then(() => { throw new Error("Dispatcher did not reach its transaction"); }),
    ]);
  } finally { child.kill("SIGKILL"); await exited; }
  assert.deepEqual(f.deps.attempts.list(), []);
  for (const table of ["attempts", "attempt_numbers", "attempt_entries"]) assert.equal(Number(f.tasks.database.get(`SELECT count(*) AS n FROM ${table}`)!.n), 0);
  assert.equal((await f.tasks.read("crash-a1"))!.state, "queued");
  const next = await dispatchOnce(f.deps, { requestId: "crash-reservation" });
  assert.equal(next.reason, "held", next.detail ?? "");
  assert.equal(next.attempt!.attempt, 1);
});
