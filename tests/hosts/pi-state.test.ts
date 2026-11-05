import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { eventText, registerSupervisor, type SupervisorPi, type SupervisorTool, type SupervisorEvent } from "../../src/hosts/pi/extension.ts";

type Handler = Parameters<SupervisorPi["on"]>[1];
class FakePi implements SupervisorPi {
  handlers = new Map<string, Handler[]>();
  tools: string[] = [];
  messages: string[] = [];
  deliveryOptions: { deliverAs: "followUp" }[] = [];
  registerTool(tool: SupervisorTool) { this.tools.push(tool.name); }
  on(name: string, handler: Handler) { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); }
  sendUserMessage(text: string, options: { deliverAs: "followUp" }) { this.messages.push(text); this.deliveryOptions.push(options); }
  async emit(name: string, event: Parameters<Handler>[0] = {}, context?: Parameters<Handler>[1]) {
    let result: Awaited<ReturnType<Handler>> = undefined;
    for (const handler of this.handlers.get(name) ?? []) result = await handler(event, context) ?? result;
    return result;
  }
}
const error = { role: "assistant", content: [], stopReason: "error", errorMessage: "Codex error: The usage limit has been reached" };
const success = { role: "assistant", content: "Done", stopReason: "stop" };
const event = (id: string): SupervisorEvent => ({ id, kind: "worker_finished", taskId: "work", attempt: 1 });
const reply = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value) });
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await sleep(2); }
  assert.fail("Timed out waiting for extension");
}
function fixture(events: SupervisorEvent[] = [], resumeFailure?: "refusal" | "throw", delaysMs?: number[]) {
  const pi = new FakePi();
  const states: string[][] = [];
  const handled: string[] = [];
  let closed = false;
  let checkObjective: (() => Promise<void>) | undefined;
  registerSupervisor(pi, { objectiveId: "goal", sessionId: "session", configPath: "/config", cliPath: "/cli", privateDirectory: "/private",
    ...(delaysMs === undefined ? {} : { providerRetries: { delaysMs } }) }, async (args, signal) => {
    if (args[1] === "wait") {
      if (events.length) return reply({ ok: true, event: events.shift() });
      await sleep(10000, undefined, { signal });
    }
    if (args[1] === "objective") {
      await checkObjective?.();
      return closed ? { exitCode: 1, stdout: JSON.stringify({ ok: false, code: "objective_not_open", state: "abandoned" }) }
        : reply({ ok: true, objective: { state: "open" } });
    }
    if (args[1] === "handled") handled.push(args.at(-1)!);
    if (args[1] === "session-state") {
      states.push(args.slice(6));
      if (args.includes("resumed") && resumeFailure) {
        const failure = resumeFailure;
        resumeFailure = undefined;
        if (failure === "throw") throw new Error("Command failed");
        return { exitCode: 1, stdout: JSON.stringify({ ok: false }) };
      }
    }
    return reply({ ok: true });
  }, 5);
  return { pi, states, handled, close: () => { closed = true; }, beforeObjectiveCheck: (check: () => Promise<void>) => { checkObjective = check; } };
}

test("provider errors are recorded only after Pi settles, retaining all delivered events despite acknowledgement", async () => {
  const { pi, states, handled } = fixture([event("first"), event("second"), event("third")]);
  try {
    await pi.emit("session_start");
    assert.equal(pi.tools.includes("sb_session_state"), false);
    for (let i = 0; i < 3; i++) {
      await until(() => pi.messages.length === i + 1);
      await pi.emit("message_start", { message: { role: "user", content: pi.messages[i]! } });
      await until(() => handled.length === i + 1);
      await pi.emit("message_end", { message: { ...error } });
      await pi.emit("agent_end", { messages: [error] });
      await pi.emit("agent_before_settle");
      assert.deepEqual(states, [], "Pi may still retry or process queued follow-ups");
    }
    await pi.emit("agent_settled");
    assert.deepEqual(handled, ["first", "second", "third"]);
    assert.deepEqual(states, [["--session", "session", "--state", "stopped", "--error", error.errorMessage,
      "--event", "first", "--event", "second", "--event", "third"]]);
    await pi.emit("message_end", { message: success });
    assert.deepEqual(states.at(-1), ["--session", "session", "--state", "resumed"]);
    await pi.emit("message_end", { message: { ...success } });
    await pi.emit("agent_settled");
    assert.equal(states.length, 2);
  } finally { await pi.emit("session_shutdown"); }
});

test("a successful automatic retry does not record a stop, and a queued but undelivered event is excluded", async () => {
  const { pi, states } = fixture([event("queued")]);
  try {
    await pi.emit("session_start");
    await until(() => pi.messages.length === 1);
    await pi.emit("message_end", { message: error });
    await pi.emit("agent_end");
    await pi.emit("message_end", { message: success });
    await pi.emit("agent_settled");
    assert.equal(states.some(args => args.includes("stopped")), false);
    await pi.emit("message_end", { message: { ...error, errorMessage: "" } });
    await pi.emit("agent_settled");
    assert.equal(states.at(-1)!.includes("--event"), false);
    assert.match(states.at(-1)!.at(-1)!, /no error message reported/);
  } finally { await pi.emit("session_shutdown"); }
});

test("reload reconstructs delivered work since the last successful response and resumes the actual Pi session", async () => {
  const { pi, states } = fixture();
  try {
    await pi.emit("session_start", {}, { sessionManager: {
      getSessionId: () => "actual-session",
      getEntries: () => [
        { id: "old-event", type: "message", message: { role: "user", content: eventText(event("acted-on")) } },
        { id: "success", type: "message", message: success },
        { id: "event", type: "message", message: { role: "user", content: eventText(event("unanswered")) } },
        { id: "failure", type: "message", message: error },
      ],
    } });
    await pi.emit("agent_settled");
    assert.deepEqual(states[0], ["--session", "actual-session", "--state", "stopped", "--error", error.errorMessage, "--event", "unanswered"]);
    await pi.emit("message_end", { message: { ...success, stopReason: "toolUse" } });
    assert.deepEqual(states.at(-1), ["--session", "actual-session", "--state", "resumed"]);
    await pi.emit("message_end", { message: { ...success } });
    assert.equal(states.length, 2);
    await pi.emit("message_end", { message: error });
    await pi.emit("agent_settled");
    assert.equal(states.at(-1)!.includes("--event"), false, "success clears the delivered-work window");
  } finally { await pi.emit("session_shutdown"); }
});

test("healthy responses report resumed once per session, then once after each new error", async () => {
  const { pi, states } = fixture();
  try {
    await pi.emit("session_start");
    for (const stopReason of ["stop", "toolUse", "lengthLimit"]) {
      await pi.emit("message_end", { message: { ...success, stopReason } });
    }
    assert.deepEqual(states, [["--session", "session", "--state", "resumed"]]);
    for (let i = 0; i < 2; i++) {
      await pi.emit("message_end", { message: { ...error } });
      await pi.emit("agent_settled");
      await pi.emit("message_end", { message: { ...success } });
      await pi.emit("message_end", { message: { ...success } });
      assert.equal(states.length, 3 + i * 2);
      assert.deepEqual(states.at(-1), ["--session", "session", "--state", "resumed"]);
    }
    await pi.emit("session_shutdown");
    await pi.emit("session_start", {}, { sessionManager: { getSessionId: () => "next-session", getEntries: () => [] } });
    await pi.emit("message_end", { message: { ...success } });
    await pi.emit("message_end", { message: { ...success } });
    assert.equal(states.length, 6);
    assert.deepEqual(states.at(-1), ["--session", "next-session", "--state", "resumed"]);
  } finally { await pi.emit("session_shutdown"); }
});

for (const failure of ["refusal", "throw"] as const) test(`a resumed report retries after a ${failure}, then stops reporting`, async () => {
  const { pi, states } = fixture([], failure);
  try {
    await pi.emit("session_start");
    await assert.rejects(pi.emit("message_end", { message: { ...success } }));
    assert.equal(states.length, 1);
    await pi.emit("message_end", { message: { ...success } });
    await pi.emit("message_end", { message: { ...success } });
    assert.deepEqual(states, Array.from({ length: 2 }, () => ["--session", "session", "--state", "resumed"]));
  } finally { await pi.emit("session_shutdown"); }
});

test("configured retries retain delivered events, send one follow-up per delay and stop on exhaustion", async () => {
  const { pi, states, handled } = fixture([event("delivered")], undefined, [10, 20]);
  try {
    await pi.emit("session_start");
    await until(() => pi.messages.length === 1);
    await pi.emit("message_start", { message: { role: "user", content: pi.messages[0]! } });
    await until(() => handled.length === 1);
    for (let number = 1; number <= 2; number++) {
      await pi.emit("message_end", { message: { ...error } });
      const before = Date.now();
      await pi.emit("agent_end");
      assert.equal(states.length, number - 1);
      await pi.emit("agent_settled");
      const args = states.at(-1)!;
      assert.deepEqual(args.slice(0, 8), ["--session", "session", "--state", "retrying", "--error", error.errorMessage, "--event", "delivered"]);
      assert.deepEqual(args.slice(8, 12), ["--retry-number", String(number), "--retry-total", "2"]);
      assert.equal(args[12], "--next-retry-at");
      assert.ok(Date.parse(args[13]!) >= before + (number === 1 ? 10 : 20));
      assert.equal(pi.messages.length, number);
      await until(() => pi.messages.length === number + 1);
      assert.ok(Date.now() >= Date.parse(args[13]!));
      assert.ok(pi.messages[number]!.includes(error.errorMessage));
      assert.match(pi.messages[number]!, /sb_briefing and continue/);
      assert.deepEqual(pi.deliveryOptions[number], { deliverAs: "followUp" });
      await sleep(25);
      assert.equal(pi.messages.length, number + 1, "one message per configured retry");
    }
    await pi.emit("message_end", { message: { ...error } });
    await pi.emit("agent_settled");
    assert.deepEqual(states.at(-1), ["--session", "session", "--state", "stopped", "--error", error.errorMessage, "--event", "delivered"]);
    await sleep(30);
    assert.equal(pi.messages.length, 3);
  } finally { await pi.emit("session_shutdown"); }
});

test("a person's successful response cancels a pending retry and resets the retry count", async () => {
  const { pi, states } = fixture([], undefined, [30, 10]);
  try {
    await pi.emit("session_start");
    await pi.emit("message_end", { message: { ...error } });
    await pi.emit("agent_settled");
    await pi.emit("message_end", { message: { ...success } });
    assert.deepEqual(states.at(-1), ["--session", "session", "--state", "resumed"]);
    await sleep(50);
    assert.deepEqual(pi.messages, []);
    await pi.emit("message_end", { message: { ...error } });
    await pi.emit("agent_settled");
    assert.equal(states.at(-1)![7], "1");
    await until(() => pi.messages.length === 1);
    await pi.emit("message_end", { message: { ...success } });
    await pi.emit("message_end", { message: { ...error } });
    await pi.emit("agent_settled");
    assert.equal(states.at(-1)![7], "1", "retry success also resets the count");
  } finally { await pi.emit("session_shutdown"); }
});

for (const reason of ["shutdown", "closed", "aborted response", "aborted run"] as const) test(`${reason} cancels a configured pending provider retry`, async () => {
  const f = fixture([], undefined, [20]);
  try {
    await f.pi.emit("session_start");
    await f.pi.emit("message_end", { message: { ...error } });
    await f.pi.emit("agent_settled");
    if (reason === "shutdown") await f.pi.emit("session_shutdown");
    if (reason === "closed") f.close();
    if (reason === "aborted response") await f.pi.emit("message_end", { message: { ...error, stopReason: "aborted" } });
    if (reason === "aborted run") await f.pi.emit("agent_settled", { aborted: true });
    await sleep(50);
    assert.deepEqual(f.pi.messages, []);
    assert.equal(f.states.length, 1);
  } finally { await f.pi.emit("session_shutdown"); }
});

test("success during the objective check cancels the retry before sending", async () => {
  const f = fixture([], undefined, [5]);
  let release!: () => void;
  let checking = false;
  f.beforeObjectiveCheck(() => new Promise<void>(resolve => { checking = true; release = resolve; }));
  try {
    await f.pi.emit("session_start");
    await f.pi.emit("message_end", { message: { ...error } });
    await f.pi.emit("agent_settled");
    await until(() => checking);
    await f.pi.emit("message_end", { message: { ...success } });
    release();
    await sleep(20);
    assert.deepEqual(f.pi.messages, []);
  } finally { release?.(); await f.pi.emit("session_shutdown"); }
});

for (const reason of ["success", "closed", "aborted response", "aborted run"] as const) test(`${reason} hides an already queued provider retry at the model boundary`, async () => {
  const f = fixture([], undefined, [5]);
  try {
    await f.pi.emit("session_start");
    await f.pi.emit("message_end", { message: { ...error } });
    await f.pi.emit("agent_settled");
    await until(() => f.pi.messages.length === 1);
    const retry = { role: "user", content: f.pi.messages[0]! };
    const person = { role: "user", content: "Please continue" };
    if (reason === "success") await f.pi.emit("message_end", { message: { ...success } });
    if (reason === "closed") f.close();
    if (reason === "aborted response") await f.pi.emit("message_end", { message: { ...error, stopReason: "aborted" } });
    if (reason === "aborted run") await f.pi.emit("agent_settled", { aborted: true });
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await f.pi.emit("context", { messages: [person, retry] }), { messages: [person] });
    }
    await sleep(20);
    assert.equal(f.pi.messages.length, 1, "cancellation never sends another follow-up");
  } finally { await f.pi.emit("session_shutdown"); }
});

for (const delaysMs of [undefined, [5]]) test(`an aborted assistant response does not start a retry (${delaysMs ? "configured" : "default"})`, async () => {
  const { pi, states } = fixture([], undefined, delaysMs);
  try {
    await pi.emit("session_start");
    await pi.emit("message_end", { message: { ...error, stopReason: "aborted" } });
    await pi.emit("agent_settled");
    assert.deepEqual(states, []);
    await sleep(20);
    assert.deepEqual(pi.messages, []);
  } finally { await pi.emit("session_shutdown"); }
});
