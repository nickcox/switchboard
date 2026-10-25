import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ContextView, HarnessInspection, SettledSubmissionRecord } from "@earendil-works/pi-durable";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { ApplicationStore } from "../design-a/store.ts";
import { fullSettings } from "../failures/configured-storage.ts";
import type { Snapshot } from "../scenario/contract.ts";
import { FakeOwners } from "../scenario/owners.ts";
import type { Config } from "./host-child.ts";
import { json, lines, start, stop, type Host } from "./process-fixture.ts";

const root = fileURLToPath(new URL("../../../.investigation/durable-orchestration/", import.meta.url));
const hostFile = fileURLToPath(new URL("./host-child.ts", import.meta.url));
const report = join(root, "supervisor-results.jsonl");
type Evidence = { conversationId: number; submissionId: number; settled: SettledSubmissionRecord;
  before: { engine: HarnessInspection; transcript: ContextView }; engine: HarnessInspection; transcript: ContextView; snapshot: Snapshot };
type Boundary = Pick<Evidence, "conversationId" | "engine" | "transcript" | "snapshot"> & {
  taskId: number; result: { output: { type: string; text: string }[] };
};
function toolResults(transcript: ContextView): ToolResultMessage[] {
  return transcript.entries.flatMap(entry => entry.model ?? []).filter(message => message.role === "toolResult");
}

for (const replay of ["safe", "unsafe"] as const) for (let repeat = 1; repeat <= 3; repeat++) {
  test(`supervisor dispatch result lost: ${replay}, repeat ${repeat}`, { timeout: 25_000 }, async t => {
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "supervisor-recovery-"));
    const hosts: Host[] = [];
    t.after(async () => { for (const host of hosts) await stop(host); await rm(directory, { recursive: true, force: true }); });
    const config: Config = { objectiveId: randomUUID(), replay };
    await writeFile(join(directory, "config.json"), JSON.stringify(config), { flag: "wx", flush: true });
    const owners = new FakeOwners(join(directory, "owners"), join(directory, "host"));
    await owners.initialise();
    const store = await ApplicationStore.open(join(directory, "host"));
    try { await store.seed(["supervisor-fixture-task"]); } finally { store.close(); }
    const launch = (mode: string) => { const host = start(hostFile, directory, mode); hosts.push(host); return host; };
    const first = launch("pause");
    await first.boundary;
    const boundary = await json<Boundary>(join(directory, "boundary.json"));
    assert.equal(boundary.snapshot.attempts.length, 1);
    const original = boundary.snapshot.attempts[0]!;
    assert.ok(original.identity);
    assert.equal(original.prompted, true);
    assert.deepEqual(JSON.parse(boundary.result.output[0]!.text), { status: "waiting", attemptId: original.id, waitingFor: "worker" });
    assert.equal(toolResults(boundary.transcript).length, 0, "No tool result was committed at the kill boundary");
    const tool = boundary.engine.tasks.find(item => item.record.id === boundary.taskId)!;
    assert.equal(tool.record.kind, "pi.tool");
    assert.equal(tool.record.state.status, "running");
    if (tool.record.state.status !== "running") throw new Error("Expected executing tool");
    assert.deepEqual(tool.record.state.checkpoint, { phase: "execute", arguments: {}, replay });
    assert.equal(boundary.engine.submissions.length, 1);
    const submissionId = boundary.engine.submissions[0]!.id;
    assert.equal(boundary.engine.submissions[0]!.status, "placed");
    const expectedCounts = { acquire: 1, launch: 1, prompt: 1, worker_exit: 0, review: 0, merge: 0, return: 0, cancel: 0 };
    assert.deepEqual(await owners.counters(original.id), expectedCounts);

    // Both live and stale owners must refuse a second opener before either database is touched.
    const competitor = launch("resume");
    assert.equal((await competitor.exited).code, 2, competitor.output());
    assert.match(competitor.output(), /owner_claim_exists/);
    await stop(first);
    assert.equal(first.child.signalCode, "SIGKILL");
    const stale = launch("resume");
    assert.equal((await stale.exited).code, 2, stale.output());
    assert.match(stale.output(), /owner_claim_exists/);
    // Explicit fixture-only recovery after joining the old host. Owners are files, not processes.
    await rm(join(directory, "host", "owner"), { recursive: true });
    const resumed = launch("resume");
    assert.equal((await resumed.exited).code, 0, resumed.output());
    const recovered = await json<Evidence>(join(directory, "resume.json"));
    assert.equal(recovered.conversationId, boundary.conversationId);
    assert.equal(recovered.submissionId, submissionId, "Stable input ID must find the admitted submission");
    assert.equal(recovered.settled.status, "done", "The conversation answers; the worker/objective is not complete");
    assert.equal(recovered.engine.tasks.length, 0);
    assert.equal(recovered.before.engine.scheduling, "paused");
    assert.equal(toolResults(recovered.before.transcript).length, 0);
    const pending = recovered.before.engine.tasks.find(item => item.record.id === boundary.taskId)!;
    assert.equal(pending.record.state.status, "pending");
    if (pending.record.state.status !== "pending") throw new Error("Expected recovered intent");
    assert.deepEqual(pending.record.state.checkpoint, tool.record.state.checkpoint);
    assert.deepEqual(recovered.snapshot.attempts, boundary.snapshot.attempts, "Conversation recovery changes no attempt identity or outcome");
    assert.equal(recovered.snapshot.active, 1);
    assert.deepEqual(await owners.counters(original.id), expectedCounts);
    assert.equal((await owners.records()).length, 3, "Count globally so a new orphan attempt cannot hide duplicate effects");

    const calls = await lines<{ tool?: string; taskId?: number; requestId?: string; pid: number; snapshot?: Snapshot;
      modelRequest?: boolean; results?: ToolResultMessage[] }>(join(directory, "calls.jsonl"));
    const dispatches = calls.filter(call => call.tool === "dispatch");
    assert.equal(dispatches.length, replay === "safe" ? 2 : 1);
    for (const call of dispatches) {
      assert.equal(call.taskId, boundary.taskId);
      assert.equal(call.requestId, original.request.requestId);
      assert.equal(call.requestId, `${config.objectiveId}:dispatch:${boundary.taskId}`);
    }
    if (replay === "safe") assert.notEqual(dispatches[0]!.pid, dispatches[1]!.pid);
    const inspections = calls.filter(call => call.tool === "inspect_attempt");
    assert.equal(inspections.length, 1);
    assert.equal(inspections[0]!.pid, resumed.child.pid);
    assert.deepEqual(inspections[0]!.snapshot, recovered.snapshot);
    const results = toolResults(recovered.transcript);
    assert.deepEqual(results.map(result => result.toolName), ["dispatch", "inspect_attempt"]);
    if (replay === "safe") {
      assert.equal(results[0]!.isError, false);
      assert.match(JSON.stringify(results[0]!.content), /possibly_running/);
    } else {
      assert.equal(results[0]!.isError, true);
      const entry = recovered.transcript.entries.find(entry => entry.kind === "pi.tool-result")!;
      assert.match(JSON.stringify(entry.data), /interrupted/);
    }
    assert.equal(recovered.transcript.entries.filter(entry => entry.kind === "pi.user").length, 1);
    const requests = calls.filter(call => call.modelRequest);
    assert.equal(requests.length, 3, "One dispatch request before the kill, then inspection and answer requests after reopen");
    const observed = requests.at(-1)!.results!.find(result => result.toolName === "inspect_attempt")!;
    const text = observed.content.find(item => item.type === "text");
    assert.ok(text && text.type === "text");
    assert.deepEqual(JSON.parse(text.text).snapshot, recovered.snapshot, "The resumed model receives fresh application inspection");
    const settings = await lines<{ pid: number; settings: unknown }>(join(directory, "storage.jsonl"));
    assert.deepEqual(new Set(settings.map(row => row.pid)), new Set([first.child.pid, resumed.child.pid]));
    for (const row of settings) assert.deepEqual(row.settings, fullSettings);
    const summary = { experiment: "supervisor-dispatch-result-loss", replay, repeat, submissionId,
      toolTaskId: boundary.taskId, requestId: original.request.requestId, attemptId: original.id,
      dispatchInvocations: dispatches.length, counts: await owners.counters(original.id),
      outcome: replay === "safe" ? "same-request-refused-possibly-running-then-inspected" : "interrupted-then-inspected",
      fixtureClaimRecoveries: 1 };
    await appendFile(report, `${JSON.stringify(summary)}\n`, { flush: true });
    console.log(JSON.stringify(summary));
  });
}
