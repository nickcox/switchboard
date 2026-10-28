import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dispatchOnce, type Dependencies } from "../../src/dispatch/dispatch.ts";
import { finish } from "../../src/dispatch/finish.ts";
import { prune } from "../../src/dispatch/prune.ts";
import { attemptsWith, fixture, task } from "./fixture.ts";

for (const automatic of [false, true]) test(`request inputs and the selected attempt survive pruning (${automatic ? "automatic" : "explicit"})`, async () => {
  const f = await fixture({ tasks: [task("first"), task("second")], scenario: "commit-result" });
  let acquisitions = 0;
  let launches = 0;
  const acquire = f.deps.workspaces.acquire.bind(f.deps.workspaces);
  f.deps.workspaces.acquire = async request => { acquisitions++; return acquire(request); };
  const deps: Dependencies = { ...f.deps, launch: (...args) => { launches++; return f.deps.launch(...args); } };
  const inputs = { requestId: "stable", ...(automatic ? {} : { taskId: "first" }) };
  const original = await dispatchOnce(deps, inputs);
  assert.equal(original.reason, "held", original.detail ?? "");
  assert.equal(original.attempt?.taskId, "first");
  const mismatch = automatic ? { requestId: "stable", taskId: "first" } : { requestId: "stable" };
  const promptLog = await readFile(join(f.dir, "requests.jsonl"), "utf8");
  assert.match(promptLog, /prompt/);
  for (const options of [mismatch, { requestId: "stable", taskId: "second" }]) {
    assert.equal((await dispatchOnce(deps, options)).reason, "request_input_mismatch");
  }
  assert.equal((await dispatchOnce(deps, inputs)).reason, "existing_request");
  assert.equal((await finish(deps, { leaseId: original.attempt!.leaseId!, noProcesses: true })).reason, "finished");
  const pruned = await prune(deps, { olderThan: 0.000000001 });
  assert.equal(pruned.reason, "pruned", pruned.detail ?? "");
  assert.deepEqual(deps.attempts.list(), []);
  const replay = await dispatchOnce(deps, inputs);
  assert.equal(replay.reason, "existing_request");
  assert.equal(replay.attempt?.taskId, "first");
  assert.equal(replay.attempt?.attempt, original.attempt?.attempt);
  assert.equal(replay.observed.archived, true);
  for (const options of [mismatch, { requestId: "stable", taskId: "second" }]) {
    assert.equal((await dispatchOnce(deps, options)).reason, "request_input_mismatch");
  }
  assert.equal(acquisitions, 1);
  assert.equal(launches, 1);
  assert.equal(await readFile(join(f.dir, "requests.jsonl"), "utf8"), promptLog);
  assert.deepEqual(await f.tasks.ready(), ["second"]);
  assert.equal(Number(f.tasks.database.get("SELECT count(*) AS n FROM attempt_numbers")!.n), 1);
});

test("a request-record read failure refuses before selection or any effect", async () => {
  const f = await fixture({ tasks: [task("ready")] });
  let acquired = false;
  f.deps.workspaces.acquire = async () => { acquired = true; throw new Error("must not acquire"); };
  const deps = { ...f.deps, attempts: attemptsWith(f, { findByRequest: async () => { throw new Error("request read failed"); } }) };
  const outcome = await dispatchOnce(deps, { requestId: "unreadable" });
  assert.equal(outcome.reason, "owner_read_retryable");
  assert.equal(outcome.stage, "preflight");
  assert.match(outcome.detail ?? "", /request read failed/);
  assert.equal((outcome.observed.readFailure as { diagnostics: { message: string } }).diagnostics.message, "request read failed");
  assert.equal(acquired, false);
  assert.deepEqual(f.deps.attempts.list(), []);
});

test("concurrent identical automatic requests reserve one attempt and launch one worker", async () => {
  const f = await fixture({ tasks: [task("first"), task("second")], scenario: "commit-result" });
  let lookups = 0;
  let release!: () => void;
  const together = new Promise<void>(resolve => { release = resolve; });
  let acquisitions = 0;
  let launches = 0;
  const acquire = f.deps.workspaces.acquire.bind(f.deps.workspaces);
  f.deps.workspaces.acquire = async request => { acquisitions++; return acquire(request); };
  const deps: Dependencies = { ...f.deps,
    attempts: attemptsWith(f, { findByRequest: async (...args) => {
      const found = await f.deps.attempts.findByRequest(...args);
      if (++lookups === 2) release();
      await together;
      return found;
    } }),
    launch: (...args) => { launches++; return f.deps.launch(...args); },
  };
  const outcomes = await Promise.all([dispatchOnce(deps, { requestId: "same" }), dispatchOnce(deps, { requestId: "same" })]);
  assert.equal(outcomes.filter(outcome => outcome.reason === "held").length, 1);
  assert.equal(acquisitions, 1);
  assert.equal(launches, 1);
  assert.equal(f.deps.attempts.list().length, 1);
  assert.equal((await dispatchOnce(deps, { requestId: "same" })).attempt?.taskId, "first");
});
