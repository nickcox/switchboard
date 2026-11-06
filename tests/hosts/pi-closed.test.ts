import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { commandLineCaller } from "../../src/caller.ts";
import { configSchema } from "../../src/config.ts";
import { AttemptStore } from "../../src/attempts/store.ts";
import { ObjectiveStore } from "../../src/objectives/store.ts";
import { objectiveBudget } from "../../src/objectives/budget.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";
import { commandExecutor, registerSupervisor, type SupervisorPi, type SupervisorTool, type ExecuteCommand } from "../../src/hosts/pi/extension.ts";
import { specificationFor } from "../helpers.ts";

type Handler = Parameters<SupervisorPi["on"]>[1];
class FakePi implements SupervisorPi {
  registerCommand() {}
  tools = new Map<string, SupervisorTool>();
  handlers = new Map<string, Handler>();
  messages: string[] = [];
  registerTool(tool: SupervisorTool) { this.tools.set(tool.name, tool); }
  on(name: string, handler: Handler) { this.handlers.set(name, handler); }
  sendUserMessage(text: string) { this.messages.push(text); }
  async emit(name: string, event: Parameters<Handler>[0] = {}) { return this.handlers.get(name)?.(event); }
}
const event = { id: "review-1", kind: "review_recorded", taskId: "work", attempt: 1 };
const reply = (value: unknown, exitCode = 0) => ({ exitCode, stdout: JSON.stringify(value) });
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await sleep(2); }
  assert.fail("Timed out waiting for extension");
}
async function fixture() {
  const root = resolve(".investigation/pi-closed");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "case-"));
  const config = configSchema.parse({ contextId: "fixture", runtimeRoot: join(dir, "runtime"), tasks: { repo: "fixture" },
    workspaces: { repository: join(dir, "repository"), poolRoot: join(dir, "pool") }, delivery: { baseRef: "main" },
    worker: { piEntrypoint: resolve("tests/fixtures/pi-supervisor.ts"), provider: "fixture", model: "fixture" } });
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const person = commandLineCaller();
  const tasks = await SqliteTaskStore.open({ caller: person, path: join(config.runtimeRoot, "switchboard.db"), repo: "fixture" });
  const objectives = new ObjectiveStore(tasks.database, person);
  await objectives.add({ id: "goal", request: "Useful work", acceptanceCriteria: ["Met"] });
  await tasks.add({ id: "work", title: "Work", objectiveId: "goal" });
  const attempts = new AttemptStore(tasks.database, "fixture", person);
  const { ref } = await attempts.reserveAttempt({ taskId: "work", requested: {}, maximum: 1, specification: specificationFor });
  const commit = "a".repeat(40);
  await attempts.appendConfirmed(ref, "output_accepted", { commit }, { fact: "output_accepted", scope: { commit } });
  const statements = [{ position: 1, statement: "Met", references: objectives.show("goal").availableReferences }];
  const binding = { sessionKind: "restricted" as const, objectiveId: "goal", configPath, cliPath: resolve("src/cli.ts"), privateDirectory: dir, sessionId: "session" };
  return { tasks, objectives, statements, binding };
}
const message = (cost: number, tokens: number) => ({ role: "assistant", content: "Reply", usage: { cost: { total: cost }, totalTokens: tokens } });

for (const state of ["completed", "abandoned"] as const) test(`a queued event is hidden after ${state}, waits stop and real usage reports keep succeeding`, async () => {
  const f = await fixture();
  const pi = new FakePi();
  const calls: string[] = [];
  const real = commandExecutor(f.binding);
  registerSupervisor(pi, f.binding, async (args, signal) => {
    calls.push(args[1]!);
    // Hold the review follow-up in Pi's queue while the objective closes.
    if (args[1] === "wait") return reply({ ok: true, event });
    return real(args, signal);
  }, 5);
  try {
    await pi.emit("session_start");
    await until(() => pi.messages.length === 1);
    const response = message(1, 100);
    await pi.emit("message_end", { message: response });
    if (state === "completed") {
      const result = await pi.tools.get("sb_objective_complete")!.execute("complete", { statements: f.statements });
      assert.equal((result.details as { ok: boolean }).ok, true);
    } else await f.objectives.abandon("goal");
    const user = { role: "user", content: "Person's message" };
    const queued = { role: "user", content: [{ type: "text", text: pi.messages[0]! }] };
    const context = await pi.emit("context", { messages: [user, queued] });
    assert.deepEqual(context, { messages: [user] }, "The queued review must not reach the model");
    await pi.emit("message_start", { message: queued });
    await pi.emit("before_agent_start", { prompt: pi.messages[0]! });
    await pi.emit("turn_end", { message: response, messageEntryId: "complete-response" });
    const later = message(0.07, 20);
    await pi.emit("message_end", { message: later });
    await pi.emit("turn_end", { message: later, messageEntryId: "later-response" });
    await pi.emit("session_compact", { compactionEntry: { id: "compact", usage: message(0.01, 5).usage } });
    await pi.emit("before_provider_request");
    await sleep(25);
    assert.equal(calls.filter(call => call === "wait").length, 1);
    assert.equal(calls.includes("handled"), false);
    assert.equal(pi.messages.length, 1);
    const spending = objectiveBudget(f.tasks.database, "goal").spending;
    assert.equal(spending.supervisors.cost, 1.08);
    assert.equal(spending.supervisors.tokens, 125);
    assert.equal(spending.observedCost, 1.08);
    assert.equal(f.tasks.database.all("SELECT * FROM supervisor_usage").length, 6);
    assert.equal(f.objectives.read("goal")!.state, state);
  } finally { await pi.emit("session_shutdown"); f.tasks.close(); }
});

test("completion cancels an in-flight wait even when its reply already contains an event", async () => {
  const f = await fixture();
  const pi = new FakePi();
  let waiting = false;
  let cancelled = false;
  let waits = 0;
  const real = commandExecutor(f.binding);
  registerSupervisor(pi, f.binding, async (args, signal) => {
    if (args[1] !== "wait") return real(args, signal);
    waiting = true;
    waits++;
    return new Promise(resolve => signal!.addEventListener("abort", () => {
      cancelled = true;
      resolve(reply({ ok: true, event }));
    }, { once: true }));
  }, 5);
  try {
    await pi.emit("session_start");
    await until(() => waiting);
    await pi.tools.get("sb_objective_complete")!.execute("complete", { statements: f.statements });
    await until(() => cancelled);
    await pi.emit("before_provider_request");
    await pi.emit("turn_end", { message: message(0.07, 10) });
    assert.equal(waits, 1);
    assert.deepEqual(pi.messages, []);
    assert.equal(objectiveBudget(f.tasks.database, "goal").spending.supervisors.cost, 0.07);
  } finally { await pi.emit("session_shutdown"); f.tasks.close(); }
});

for (const state of ["completed", "abandoned"]) {
  test(`a coded ${state} wait refusal ends polling regardless of its detail`, async () => {
    const pi = new FakePi();
    let waits = 0;
    let usage = 0;
    const execute: ExecuteCommand = async args => {
      if (args[1] === "usage") { usage++; return reply({ ok: true }); }
      assert.equal(args[1], "wait");
      waits++;
      return reply({ ok: false, reason: "rejected", code: "objective_not_open", state, detail: "The objective has closed – supervision is unavailable" }, 1);
    };
    registerSupervisor(pi, { sessionKind: "restricted", objectiveId: "goal", configPath: "/config", cliPath: "/cli", privateDirectory: "/private", sessionId: "session" }, execute, 5);
    try {
      await pi.emit("session_start");
      await until(() => waits === 1);
      await sleep(25);
      await pi.emit("before_provider_request");
      await pi.emit("turn_end", { message: message(0.07, 10) });
      assert.equal(waits, 1);
      assert.equal(usage, 2);
      assert.deepEqual(pi.messages, []);
    } finally { await pi.emit("session_shutdown"); }
  });
}

for (const refusal of [
  { detail: "Objective goal is abandoned; reopen it explicitly before supervising it" },
  { detail: "Objective goal must be open before supervising its events" },
  { code: "another_refusal", state: "abandoned" },
  { code: "objective_not_open", state: "open" },
  { code: "objective_not_open" },
]) test(`other wait refusals keep polling: ${JSON.stringify(refusal)}`, async () => {
  const pi = new FakePi();
  let waits = 0;
  const execute: ExecuteCommand = async args => {
    if (args[1] === "usage") return reply({ ok: true });
    assert.equal(args[1], "wait");
    waits++;
    return reply({ ok: false, reason: "rejected", ...refusal }, 1);
  };
  registerSupervisor(pi, { sessionKind: "restricted", objectiveId: "goal", configPath: "/config", cliPath: "/cli", privateDirectory: "/private", sessionId: "session" }, execute, 5);
  try {
    await pi.emit("session_start");
    await until(() => waits >= 2);
    assert.deepEqual(pi.messages, []);
  } finally { await pi.emit("session_shutdown"); }
});
