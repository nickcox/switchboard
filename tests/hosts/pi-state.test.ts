import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { eventText, registerSupervisor, type SupervisorPi, type SupervisorTool, type SupervisorEvent } from "../../src/hosts/pi/extension.ts";

type Handler = Parameters<SupervisorPi["on"]>[1];
class FakePi implements SupervisorPi {
  handlers = new Map<string, Handler[]>();
  tools: string[] = [];
  messages: string[] = [];
  registerTool(tool: SupervisorTool) { this.tools.push(tool.name); }
  on(name: string, handler: Handler) { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); }
  sendUserMessage(text: string) { this.messages.push(text); }
  async emit(name: string, event: Parameters<Handler>[0] = {}, context?: Parameters<Handler>[1]) {
    for (const handler of this.handlers.get(name) ?? []) await handler(event, context);
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
function fixture(events: SupervisorEvent[] = [], resumeFailure?: "refusal" | "throw") {
  const pi = new FakePi();
  const states: string[][] = [];
  const handled: string[] = [];
  registerSupervisor(pi, { objectiveId: "goal", sessionId: "session", configPath: "/config", cliPath: "/cli", privateDirectory: "/private" }, async (args, signal) => {
    if (args[1] === "wait") {
      if (events.length) return reply({ ok: true, event: events.shift() });
      await sleep(10000, undefined, { signal });
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
  return { pi, states, handled };
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

test("an aborted assistant response is not reported as a provider error or a successful resumption", async () => {
  const { pi, states } = fixture();
  try {
    await pi.emit("session_start");
    await pi.emit("message_end", { message: { ...error, stopReason: "aborted" } });
    await pi.emit("agent_settled");
    assert.deepEqual(states, []);
  } finally { await pi.emit("session_shutdown"); }
});
