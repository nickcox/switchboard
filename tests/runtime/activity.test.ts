import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { activityFile, ActivityWriter, describeEntry, readActivity, shorten, type ActivityEntry } from "../../src/runtime/activity.ts";
import { summariseActivity } from "../../src/dispatch/watch.ts";

const evidence = resolve(import.meta.dirname, "../../.investigation/activity-unit");
mkdirSync(evidence, { recursive: true });
const directory = () => mkdtempSync(join(evidence, "case-"));

test("entries are written in order, passed to the listener, and read back", async () => {
  const dir = directory();
  const seen: ActivityEntry[] = [];
  const writer = new ActivityWriter(dir, entry => seen.push(entry));
  writer.write({ kind: "tool_start", tool: "bash", id: "1", args: shorten('{"command":"npm test"}') });
  writer.write({ kind: "tool_end", tool: "bash", id: "1", ms: 1500, error: false });
  writer.write({ kind: "stats", tokens: 900, cost: 0.12 });
  await writer.close();
  const read = await readActivity(dir);
  assert.deepEqual(read.map(e => e.kind), ["tool_start", "tool_end", "stats"]);
  assert.deepEqual(seen, read);
  assert.match(describeEntry(read[1]!), /bash done \(1\.5s\)/);
});

test("an oversized entry is replaced by a note, and partial or foreign lines are skipped when reading", async () => {
  const dir = directory();
  const writer = new ActivityWriter(dir);
  writer.write({ kind: "note", text: "x".repeat(5000) });
  await writer.close();
  appendFileSync(join(dir, activityFile), 'not json\n{"v":1,"kind":"tool_st');
  const read = await readActivity(dir);
  assert.equal(read.length, 1);
  assert.match((read[0] as Extract<ActivityEntry, { kind: "note" }>).text, /too large/);
  assert.ok(readFileSync(join(dir, activityFile), "utf8").length < 5000);
});

test("a missing log reads as no activity", async () => {
  assert.deepEqual(await readActivity(join(directory(), "absent")), []);
});

test("the summary reports the last activity, an unfinished tool and the latest usage", () => {
  const ts = (n: number) => `2026-10-19T00:00:0${n}.000Z`;
  const summary = summariseActivity([
    { v: 1, ts: ts(1), kind: "tool_start", tool: "read", id: "a", args: "{}" },
    { v: 1, ts: ts(2), kind: "tool_end", tool: "read", id: "a", ms: 5, error: false },
    { v: 1, ts: ts(3), kind: "stats", tokens: 10, cost: 0.5 },
    { v: 1, ts: ts(4), kind: "tool_start", tool: "bash", id: "b", args: "{}" },
  ]);
  assert.deepEqual(summary, { lastActivity: ts(4), currentTool: "bash", tokens: 10, cost: 0.5 });
});

test("shorten keeps text on one line within its limit", () => {
  assert.equal(shorten("a\n  b\tc"), "a b c");
  assert.equal(shorten("x".repeat(300)).length, 200);
});
