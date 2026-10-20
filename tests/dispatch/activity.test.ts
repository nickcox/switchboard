import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { describeStatus, status } from "../../src/dispatch/status.ts";
import { watch } from "../../src/dispatch/watch.ts";
import type { ActivityEntry } from "../../src/runtime/activity.ts";
import { fixture, task } from "./fixture.ts";

test("an attempt that exceeds its usage limit is held as over budget", async () => {
  const f = await fixture({ tasks: [task("budget-a1")], scenario: "expensive", worker: { maxCost: 1 } });
  const outcome = await dispatchOnce(f.deps);
  assert.equal(outcome.reason, "held");
  assert.equal((await f.tasks.read("budget-a1"))?.holdReason, "Switchboard attempt 1 over budget");
});

test("watch prints a finished attempt's activity and stops; an unknown lease is reported", async () => {
  const f = await fixture({ tasks: [task("watch-a1")], scenario: "commit-result" });
  const outcome = await dispatchOnce(f.deps);
  const printed: ActivityEntry[] = [];
  const result = await watch(f.deps, { leaseId: outcome.attempt!.leaseId!, follow: true, print: entry => printed.push(entry), pollMs: 10 });
  assert.deepEqual(result, { found: true, finished: true });
  assert.ok(printed.some(e => e.kind === "tool_start"));
  assert.ok(printed.some(e => e.kind === "note" && e.text.startsWith("Worker finished")));
  assert.deepEqual(await watch(f.deps, { leaseId: "no-such-lease", follow: false, print: () => {} }), { found: false, finished: false });
});

test("status shows a finished attempt's activity, usage and how to take over by hand", async () => {
  const f = await fixture({ tasks: [task("view-a1")], scenario: "commit-result" });
  await dispatchOnce(f.deps);
  const view = await status(f.deps);
  const attempt = view.attempts[0]!;
  assert.equal(attempt.thinkingLevel, "medium");
  assert.match(describeStatus(view), /1200 tokens, \$0\.01; thinking medium/);
  assert.ok(attempt.activity?.lastActivity);
  assert.equal(attempt.activity?.tokens, 1200);
  assert.equal(attempt.activity?.stale, false);
  assert.match(attempt.takeover ?? "", /pi --session-id .* --session-dir /);
});

test("a possibly running worker with no recent activity is flagged as stale, with no takeover offered", async () => {
  const f = await fixture();
  const workspace = join(f.dir, "orphan-workspace");
  mkdirSync(workspace);
  await f.runtime.reserve({
    identity: { contextId: "fixture-context", taskId: "quiet-a1", leaseId: "lease-quiet", sessionId: randomUUID() }, workspace,
    instructions: "Quiet", acceptanceCriteria: [],
    delivery: { baseRef: "main", startingCommit: "a".repeat(40), outputBranch: "o", kind: "code", acceptance: "review_or_integration", requiredEvidence: [], requiredDeliverables: [] },
  });
  const quiet = (await status({ ...f.deps, staleMs: 1 })).attempts.find(a => a.attempt.leaseId === "lease-quiet")!;
  assert.equal(quiet.activity?.stale, true);
  assert.equal(quiet.takeover, undefined);
  assert.equal(quiet.thinkingLevel, undefined);
  assert.match(describeStatus(await status(f.deps)), /thinking unknown/);
});
