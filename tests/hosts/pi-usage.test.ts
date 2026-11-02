import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { registerSupervisor, type SupervisorPi, type SupervisorBinding, type ExecuteCommand } from "../../src/hosts/pi/extension.ts";

type Handler = Parameters<SupervisorPi["on"]>[1];
class FakePi implements SupervisorPi {
  handlers = new Map<string, Handler>();
  registerTool() {}
  on(name: string, handler: Handler) { this.handlers.set(name, handler); }
  sendUserMessage() {}
  async emit(name: string, event: Parameters<Handler>[0] = {}, context?: Parameters<Handler>[1]) {
    await this.handlers.get(name)?.(event, context);
  }
}
const binding: SupervisorBinding = { objectiveId: "goal", sessionId: "session", configPath: "/config", cliPath: "/cli", privateDirectory: "/private" };
const reply = { exitCode: 0, stdout: '{"ok":true}' };
function fixture(fail?: (args: string[]) => void) {
  const pi = new FakePi();
  const snapshots: string[][] = [];
  const execute: ExecuteCommand = async (args, signal) => {
    if (args[1] === "wait") { await sleep(10000, undefined, { signal }); return reply; }
    assert.deepEqual(args.slice(0, 6), ["supervise", "usage", "--objective", "goal", "--config", "/config"]);
    snapshots.push(args.slice(6));
    fail?.(args);
    return reply;
  };
  registerSupervisor(pi, binding, execute);
  return { pi, snapshots };
}
const message = (cost?: number, totalTokens?: number) => ({ role: "assistant", content: "", usage: { ...(cost === undefined ? {} : { cost: { total: cost } }), ...(totalTokens === undefined ? {} : { totalTokens }) } });

test("usage registers before the first request and reports cumulative totals after each turn", async () => {
  const { pi, snapshots } = fixture();
  try {
    await pi.emit("session_start");
    assert.deepEqual(snapshots, [["--session", "session"]]);
    await pi.emit("before_provider_request");
    await pi.emit("turn_end", { message: message(0.25, 100), messageEntryId: "first" });
    await pi.emit("turn_end", { message: message(0.5, 200), messageEntryId: "second" });
    // The same recorded message cannot be charged twice; a provider-reported zero is known.
    await pi.emit("turn_end", { message: message(0.5, 200), messageEntryId: "second" });
    await pi.emit("turn_end", { message: message(0, 0), messageEntryId: "third" });
    assert.deepEqual(snapshots, [
      ["--session", "session"],
      ["--session", "session", "--cost", "0.25", "--tokens", "100"],
      ["--session", "session", "--cost", "0.75", "--tokens", "300"],
      ["--session", "session", "--cost", "0.75", "--tokens", "300"],
      ["--session", "session", "--cost", "0.75", "--tokens", "300"],
    ]);
  } finally { await pi.emit("session_shutdown"); }
});

test("missing and invalid usage remain unknown, not zero or a later partial total", async () => {
  const { pi, snapshots } = fixture();
  try {
    await pi.emit("session_start");
    await pi.emit("turn_end", { message: message(undefined, 10) });
    await pi.emit("turn_end", { message: message(0.1, 20) });
    await pi.emit("turn_end", { message: message(NaN, -1) });
    await pi.emit("turn_end", { message: { role: "assistant", content: "No usage" } });
    assert.deepEqual(snapshots.slice(1), [
      ["--session", "session", "--cost", "unknown", "--tokens", "10"],
      ["--session", "session", "--cost", "unknown", "--tokens", "30"],
      ["--session", "session", "--cost", "unknown", "--tokens", "unknown"],
      ["--session", "session", "--cost", "unknown", "--tokens", "unknown"],
    ]);
  } finally { await pi.emit("session_shutdown"); }
});

test("reload reconstructs total spending from all entries, including compacted messages and tool usage", async () => {
  const { pi, snapshots } = fixture();
  try {
    await pi.emit("session_start", {}, { sessionManager: {
      getSessionId: () => "actual-session",
      getEntries: () => [
        { id: "old", type: "message", message: message(1, 100) },
        { id: "user", type: "message", message: { role: "user", content: "Hello" } },
        { id: "compacted", type: "compaction", usage: message(0.5, 50).usage },
      ],
    } });
    await pi.emit("turn_end", { message: message(1, 100), messageEntryId: "old" });
    await pi.emit("turn_end", { message: message(0.25, 25), messageEntryId: "new", toolResults: [
      { role: "toolResult", content: "No nested request" },
      { ...message(0.125, 10), role: "toolResult" },
    ], toolResultEntryIds: ["tool-1", "tool-2"] });
    await pi.emit("session_compact", { compactionEntry: { id: "compact-2", usage: message(0.125, 15).usage } });
    assert.deepEqual(snapshots, [
      ["--session", "actual-session"],
      ["--session", "actual-session", "--cost", "1.5", "--tokens", "150"],
      ["--session", "actual-session", "--cost", "1.875", "--tokens", "185"],
      ["--session", "actual-session", "--cost", "2", "--tokens", "200"],
    ]);
  } finally { await pi.emit("session_shutdown"); }
});

test("registration failure is retried before a provider request; failed reports retain accumulated usage", async () => {
  let calls = 0;
  const { pi, snapshots } = fixture(() => {
    if (++calls === 1 || calls === 3) throw new Error("Unavailable");
  });
  try {
    await assert.rejects(pi.emit("session_start"), /Unavailable/);
    await pi.emit("before_provider_request");
    await assert.rejects(pi.emit("turn_end", { message: message(0.25, 100) }), /Unavailable/);
    await pi.emit("turn_end", { message: message(0.5, 200) });
    assert.deepEqual(snapshots.at(-1), ["--session", "session", "--cost", "0.75", "--tokens", "300"]);
  } finally { await pi.emit("session_shutdown"); }
});
