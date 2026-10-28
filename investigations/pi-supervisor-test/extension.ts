// Throwaway extension for the Phase 3 supervisor investigation. It checks three things about Pi 1.4.0:
// which tools a session started with `--tools` declares to the model, how pi.sendUserMessage() behaves when Pi is
// idle and in the middle of a turn, and whether background code in an extension keeps running across turns.
// Everything it observes is appended as JSON lines to the file named by PI_TEST_LOG.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const log = (event: string, data: Record<string, unknown> = {}) =>
  appendFileSync(process.env.PI_TEST_LOG!, `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`);
const noParameters = { type: "object", properties: {}, additionalProperties: false } as never;

export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let beats = 0;
  let idleEventSent = false;

  // Sends a message the way a Switchboard extension would have to, and records what happened.
  // sendUserMessage returns a promise in the extension API, so a refusal arrives as a rejection, not an exception.
  // "followup" always passes deliverAs, idle or not, to test whether that alone is safe.
  const deliver = async (label: string, text: string, mode: "plain" | "checked" | "followup") => {
    const idle = ctx?.isIdle();
    try {
      if (mode === "followup") await pi.sendUserMessage(text, { deliverAs: "followUp" });
      else if (mode === "plain" || idle) await pi.sendUserMessage(text);
      else await pi.sendUserMessage(text, { deliverAs: "followUp" });
      log("deliver", { label, mode, idle, outcome: "accepted" });
    } catch (error) {
      log("deliver", { label, mode, idle, outcome: "rejected", error: error instanceof Error ? error.message : String(error) });
    }
  };

  pi.registerTool({
    name: "sb_status", label: "Objective status", description: "Report the objective's current status.",
    parameters: noParameters,
    async execute() { log("tool", { name: "sb_status" }); return { content: [{ type: "text", text: "Objective status: one task done, none running." }], details: undefined }; },
  });
  pi.registerTool({
    name: "sb_slow", label: "Slow operation", description: "A slow operation that takes about ten seconds.",
    parameters: noParameters,
    async execute() {
      log("tool", { name: "sb_slow", phase: "start" });
      // While the tool runs, Pi is mid-turn: try a plain message (expected to throw), then the checked form.
      setTimeout(() => {
        void deliver("mid-turn plain", "EVENT-2: ignore this plain message.", "plain");
        void deliver("mid-turn checked", "EVENT-2: a worker asked a question. When you reach this message, reply exactly DONE-2.", "checked");
      }, 2000);
      await new Promise(resolve => setTimeout(resolve, 10_000));
      log("tool", { name: "sb_slow", phase: "end" });
      return { content: [{ type: "text", text: "Slow operation finished." }], details: undefined };
    },
  });

  pi.on("session_start", (_event, context) => {
    ctx = context;
    log("session_start", { activeTools: pi.getActiveTools(), allTools: pi.getAllTools().map(t => t.name) });
    heartbeat = setInterval(() => { beats++; log("heartbeat", { beats, idle: ctx?.isIdle() }); }, 2000);
  });
  pi.on("before_agent_start", (event) => {
    log("before_agent_start", { messageType: event.messageType, prompt: "prompt" in event ? String(event.prompt).slice(0, 80) : undefined, activeTools: pi.getActiveTools() });
  });
  pi.on("turn_start", () => log("turn_start"));
  pi.on("turn_end", () => log("turn_end"));
  pi.on("agent_end", () => {
    log("agent_end", { idle: ctx?.isIdle() });
    // After the run that handled EVENT-2 settles, send one event while idle, from background code.
    if (!idleEventSent) {
      idleEventSent = true;
      setTimeout(() => void deliver("idle", "EVENT-1: a worker finished. Call sb_status once, then reply exactly DONE-1.", process.env.PI_TEST_IDLE_MODE === "followup" ? "followup" : "checked"), 5000);
    }
  });
  pi.on("session_shutdown", () => { if (heartbeat) clearInterval(heartbeat); log("session_shutdown", { beats }); });
}
