import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { eventText, registerSupervisor, type SupervisorPi, type SupervisorTool, type SupervisorEvent } from "../../src/hosts/pi/extension.ts";

type Handler = Parameters<SupervisorPi["on"]>[1];
type Context = NonNullable<Parameters<Handler>[1]>;
class FakePi implements SupervisorPi {
  handlers = new Map<string, Handler[]>();
  messages: string[] = [];
  registerTool(_tool: SupervisorTool) {}
  on(name: string, handler: Handler) { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); }
  sendUserMessage(text: string) { this.messages.push(text); }
  async emit(name: string, event: Parameters<Handler>[0] = {}, context?: Context) {
    for (const handler of this.handlers.get(name) ?? []) await handler(event, context);
  }
}
const success = { role: "assistant", content: "Waiting for work", stopReason: "stop", usage: { cost: { total: 0.1 }, totalTokens: 10 } };
const error = { ...success, stopReason: "error", errorMessage: "Provider unavailable" };
const event: SupervisorEvent = { id: "finished", kind: "worker_finished", taskId: "work", attempt: 2 };
const reply = (value: unknown, exitCode = 0) => ({ exitCode, stdout: JSON.stringify(value) });
const localTime = (date: Date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await sleep(2); }
  assert.fail("Timed out waiting for extension");
}
function fixture(events: SupervisorEvent[] = [], delaysMs?: number[], successfulClosure = false) {
  const pi = new FakePi();
  const statuses: (string | undefined)[] = [];
  const calls: string[][] = [];
  let closed: "completed" | "abandoned" | undefined;
  let failState = false;
  const context: Context = {
    hasUI: true,
    ui: { setStatus(key, text) { assert.equal(key, "switchboard"); statuses.push(text); } },
    sessionManager: { getSessionId: () => "session", getEntries: () => [] },
  };
  registerSupervisor(pi, { objectiveId: "goal", sessionId: "session", configPath: "/config", cliPath: "/cli", privateDirectory: "/private",
    ...(delaysMs === undefined ? {} : { providerRetries: { delaysMs } }) }, async (args, signal) => {
    calls.push(args);
    if (closed && args[1] === "objective" && successfulClosure) return reply({ ok: true, objective: { state: closed } });
    if (closed && (args[1] === "wait" || args[1] === "objective")) return reply({ ok: false, code: "objective_not_open", state: closed }, 1);
    if (args[1] === "wait") {
      if (events.length) return reply({ ok: true, event: events.shift() });
      await sleep(10000, undefined, { signal });
    }
    if (args[1] === "session-state" && failState) throw new Error("State unavailable");
    return reply({ ok: true });
  }, 5);
  return { pi, context, statuses, calls, close: (state: typeof closed) => { closed = state; }, failState: () => { failState = true; } };
}

test("Pi's event contexts show working until settled, then a stable local waiting start time", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 0, 2, 3, 4).getTime() });
  const f = fixture();
  const { pi, context, statuses } = f;
  try {
    await pi.emit("session_start", {}, context);
    await pi.emit("before_agent_start", { prompt: "Begin" }, context);
    await pi.emit("agent_start", {}, context);
    assert.equal(statuses.at(-1), "Switchboard: working");
    await pi.emit("message_end", { message: success }, context);
    await pi.emit("agent_end", {}, context);
    await pi.emit("agent_before_settle", {}, context);
    assert.equal(statuses.at(-1), "Switchboard: working");
    await pi.emit("agent_settled", {}, context);
    assert.equal(statuses.at(-1), "Switchboard: waiting for events since 03:04");
    t.mock.timers.tick(120000);
    await pi.emit("agent_settled", {}, context);
    assert.equal(statuses.at(-1), "Switchboard: waiting for events since 03:04");
    const nextStatuses: (string | undefined)[] = [];
    const nextContext = { ...context, ui: { setStatus: (_key: string, text: string | undefined) => { nextStatuses.push(text); } } };
    await pi.emit("before_agent_start", { prompt: "Continue" }, nextContext);
    await pi.emit("agent_start", {}, nextContext);
    assert.equal(nextStatuses.at(-1), "Switchboard: working", "use the context passed to the current handler");
    await pi.emit("agent_settled", {}, nextContext);
    assert.equal(nextStatuses.at(-1), "Switchboard: waiting for events since 03:06");
    await pi.emit("session_shutdown", {}, nextContext);
    assert.equal(nextStatuses.at(-1), undefined);
  } finally { await pi.emit("session_shutdown", {}, context); }
});

for (const hook of ["before_agent_start", "message_start"]) {
  for (const delivered of [event, { ...event, taskId: null, attempt: null }, { ...event, attempt: null }]) {
    test(`${hook} displays only the delivered event's kind, task and attempt: ${delivered.taskId}/${delivered.attempt}`, async () => {
      const { pi, context, statuses, calls } = fixture([delivered]);
      try {
        await pi.emit("session_start", {}, context);
        await until(() => pi.messages.length === 1);
        await pi.emit("before_agent_start", { prompt: hook === "before_agent_start" ? pi.messages[0]! : "Begin" }, context);
        await pi.emit("agent_start", {}, context);
        if (hook === "message_start") {
          assert.equal(statuses.at(-1), "Switchboard: working", "queueing alone does not label the run");
          await pi.emit("message_start", { message: { role: "user", content: pi.messages[0]! } }, context);
        }
        const suffix = delivered.taskId === null ? "" : ` for work${delivered.attempt === null ? "" : " attempt 2"}`;
        assert.equal(statuses.at(-1), `Switchboard: handling worker_finished event${suffix}`);
        await until(() => calls.some(args => args[1] === "handled"));
        await pi.emit("message_end", { message: success }, context);
        await pi.emit("agent_settled", {}, context);
        await pi.emit("before_agent_start", { prompt: "Person's message" }, context);
        await pi.emit("agent_start", {}, context);
        assert.equal(statuses.at(-1), "Switchboard: working", "the previous event must not label a person's run");
      } finally { await pi.emit("session_shutdown", {}, context); }
    });
  }
}

test("pending provider retries show their number, total and local time, then exhaustion shows stopped", async () => {
  const { pi, context, statuses, calls } = fixture([], [10, 10]);
  try {
    await pi.emit("session_start", {}, context);
    for (let number = 1; number <= 2; number++) {
      await pi.emit("agent_start", {}, context);
      await pi.emit("message_end", { message: { ...error } }, context);
      await pi.emit("agent_settled", {}, context);
      const report = calls.filter(args => args[1] === "session-state").at(-1)!;
      const at = new Date(report[report.indexOf("--next-retry-at") + 1]!);
      assert.equal(statuses.at(-1), `Switchboard: provider error, retry ${number}/2 at ${localTime(at)}`);
      await until(() => pi.messages.length === number);
      await sleep(5);
    }
    await pi.emit("agent_start", {}, context);
    await pi.emit("message_end", { message: { ...error } }, context);
    await pi.emit("agent_settled", {}, context);
    assert.equal(statuses.at(-1), "Switchboard: stopped after a provider error – see switchboard status");
    await pi.emit("before_agent_start", { prompt: "Try again" }, context);
    await pi.emit("agent_start", {}, context);
    assert.equal(statuses.at(-1), "Switchboard: working");
    await pi.emit("message_end", { message: success }, context);
    await pi.emit("agent_settled", {}, context);
    assert.match(statuses.at(-1)!, /^Switchboard: waiting for events since \d\d:\d\d$/);
  } finally { await pi.emit("session_shutdown", {}, context); }
});

test("a new failed run restores the pending retry footer, and success cancels it before waiting", async () => {
  const { pi, context, statuses, calls } = fixture([], [60000]);
  try {
    await pi.emit("session_start", {}, context);
    await pi.emit("agent_start", {}, context);
    await pi.emit("message_end", { message: error }, context);
    await pi.emit("agent_settled", {}, context);
    const retryStatus = statuses.at(-1);
    assert.match(retryStatus!, /^Switchboard: provider error, retry 1\/1 at \d\d:\d\d$/);
    await pi.emit("before_agent_start", { prompt: "Try again now" }, context);
    await pi.emit("agent_start", {}, context);
    assert.equal(statuses.at(-1), "Switchboard: working");
    await pi.emit("message_end", { message: { ...error } }, context);
    await pi.emit("agent_settled", {}, context);
    assert.equal(statuses.at(-1), retryStatus);
    assert.equal(calls.filter(args => args[1] === "session-state").length, 1, "displaying the pending retry must not reschedule it");
    await pi.emit("agent_start", {}, context);
    await pi.emit("message_end", { message: success }, context);
    await pi.emit("agent_settled", {}, context);
    assert.match(statuses.at(-1)!, /^Switchboard: waiting for events since \d\d:\d\d$/);
  } finally { await pi.emit("session_shutdown", {}, context); }
});

test("a default provider failure shows stopped rather than waiting", async () => {
  const { pi, context, statuses } = fixture();
  try {
    await pi.emit("session_start", {}, context);
    await pi.emit("agent_start", {}, context);
    await pi.emit("message_end", { message: error }, context);
    await pi.emit("agent_settled", {}, context);
    assert.equal(statuses.at(-1), "Switchboard: stopped after a provider error – see switchboard status");
  } finally { await pi.emit("session_shutdown", {}, context); }
});

test("a stopped footer requires a successfully recorded stop", async () => {
  const f = fixture();
  try {
    await f.pi.emit("session_start", {}, f.context);
    await f.pi.emit("agent_start", {}, f.context);
    await f.pi.emit("message_end", { message: error }, f.context);
    f.failState();
    await assert.rejects(f.pi.emit("agent_settled", {}, f.context));
    assert.equal(f.statuses.some(text => text?.includes("stopped after")), false);
  } finally { await f.pi.emit("session_shutdown", {}, f.context); }
});

for (const successfulClosure of [true, false]) for (const state of ["completed", "abandoned"] as const) test(`a closed objective overrides working, waiting and error footers: ${state}, successful result=${successfulClosure}`, async () => {
  const f = fixture([event], [10], successfulClosure);
  try {
    await f.pi.emit("session_start", {}, f.context);
    await until(() => f.pi.messages.length === 1);
    await f.pi.emit("agent_start", {}, f.context);
    await f.pi.emit("message_end", { message: error }, f.context);
    await f.pi.emit("agent_settled", {}, f.context);
    f.close(state);
    await until(() => f.statuses.at(-1) === `Switchboard: objective ${state}`);
    await f.pi.emit("before_agent_start", { prompt: "Continue" }, f.context);
    await f.pi.emit("agent_start", {}, f.context);
    await f.pi.emit("message_end", { message: success }, f.context);
    await f.pi.emit("agent_settled", {}, f.context);
    assert.equal(f.statuses.at(-1), `Switchboard: objective ${state}`);
    assert.equal(f.pi.messages.length, 1, "the closed objective receives no retry");
  } finally { await f.pi.emit("session_shutdown", {}, f.context); }
  assert.equal(f.statuses.at(-1), undefined);
});

for (const hasUI of [true, false]) test(`footer failures cannot interrupt delivery, usage, session-state reporting or shutdown (hasUI=${hasUI})`, async () => {
  const f = fixture([event]);
  let statusCalls = 0;
  const context = { ...f.context, hasUI, ui: { setStatus() { statusCalls++; throw new Error("UI unavailable"); } } };
  try {
    await f.pi.emit("session_start", {}, context);
    await until(() => f.pi.messages.length === 1);
    await f.pi.emit("before_agent_start", { prompt: eventText(event) }, context);
    await f.pi.emit("agent_start", {}, context);
    await until(() => f.calls.some(args => args[1] === "handled"));
    await f.pi.emit("message_end", { message: error }, context);
    await f.pi.emit("turn_end", { message: error, messageEntryId: "error" }, context);
    await f.pi.emit("agent_settled", {}, context);
    assert.ok(f.calls.some(args => args[1] === "session-state" && args.includes("stopped") && args.includes(event.id)));
    await f.pi.emit("message_end", { message: success }, context);
    await f.pi.emit("agent_settled", {}, context);
    assert.ok(f.calls.some(args => args[1] === "session-state" && args.includes("resumed")));
    assert.ok(f.calls.some(args => args[1] === "usage" && args.includes("--tokens")));
  } finally { await f.pi.emit("session_shutdown", {}, context); }
  assert.equal(statusCalls > 0, hasUI, "headless sessions must never call setStatus, even to clear it");
});
