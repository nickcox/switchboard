import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { supervisorTools } from "./tools.ts";
import { providerRetriesSchema } from "../../supervise/provider-retries.ts";

export const bindingSchema = z.strictObject({
  objectiveId: z.string().min(1), configPath: z.string().min(1), cliPath: z.string().min(1),
  privateDirectory: z.string().min(1), sessionId: z.string().min(1),
  providerRetries: providerRetriesSchema.optional(),
});
export type SupervisorBinding = z.infer<typeof bindingSchema>;
export type CommandReply = { exitCode: number; stdout: string };
export type ExecuteCommand = (args: string[], signal?: AbortSignal) => Promise<CommandReply>;
type ToolResult = { content: { type: "text"; text: string }[]; details: unknown };
export type SupervisorTool = {
  name: string; label: string; description: string; parameters: Record<string, unknown>;
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<ToolResult>;
};
type PiUsage = { totalTokens?: number; cost?: { total?: number } };
type PiMessage = { role: string; content: string | { type: string; text?: string }[]; usage?: PiUsage; stopReason?: string; errorMessage?: string };
type PiEvent = { aborted?: boolean; prompt?: string; message?: PiMessage; messages?: PiMessage[]; messageEntryId?: string; toolResults?: PiMessage[]; toolResultEntryIds?: string[]; compactionEntry?: { id: string; usage?: PiUsage } };
type PiContext = { hasUI?: boolean; ui?: { setStatus(key: string, text: string | undefined): void }; signal?: AbortSignal; sessionManager: { getSessionId(): string; getEntries(): { id: string; type: string; message?: PiMessage; usage?: PiUsage }[] } };
/** The small part of Pi's extension API used here; Pi loads the extension, not Switchboard. */
export interface SupervisorPi {
  registerTool(tool: SupervisorTool): void;
  on(event: string, handler: (event: PiEvent, context?: PiContext) => void | { messages: PiMessage[] } | Promise<void | { messages: PiMessage[] }>): void;
  sendUserMessage(text: string, options: { deliverAs: "followUp" }): void | Promise<void>;
}

export function commandExecutor(binding: SupervisorBinding): ExecuteCommand {
  return (args, signal) => new Promise((resolve, reject) => {
    execFile(process.execPath, [binding.cliPath, ...args], { signal, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (signal?.aborted || error && typeof error.code !== "number") { reject(error ?? signal?.reason); return; }
      resolve({ exitCode: error ? Number(error.code) : 0, stdout });
    });
  });
}

export function registerSupervisor(pi: SupervisorPi, binding: SupervisorBinding, execute = commandExecutor(binding), retryMs = 1000) {
  const fixed = ["--objective", binding.objectiveId, "--config", binding.configPath];
  let controller: AbortController | undefined;
  let eventsStopped = false;
  const queued = new Set<string>();
  const retryQueued = new Set<string>();
  const cancelledRetries = new Set<string>();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelivery: Promise<void> | undefined;
  let retryGeneration = 0;
  let retryCount = 0;
  let shuttingDown = false;
  let context: PiContext | undefined;
  let objectiveState: string | undefined;
  let running = false;
  let runEvent: SupervisorEvent | undefined;
  let waitingSince: Date | undefined;
  let providerRetry: { number: number; total: number; at: string } | undefined;
  let stopped = false;
  const localTime = (date: Date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const setStatus = (text: string | undefined, ctx = context) => {
    if (!ctx?.hasUI) return;
    try { ctx.ui?.setStatus("switchboard", text); }
    catch { /* Footer failures must not interrupt supervision. */ }
  };
  const updateStatus = () => {
    if (shuttingDown) return;
    if (objectiveState) setStatus(`Switchboard: objective ${objectiveState}`);
    else if (running) setStatus(runEvent ? `Switchboard: handling ${runEvent.kind} event${runEvent.taskId === null ? "" : ` for ${runEvent.taskId}`}${runEvent.attempt === null ? "" : ` attempt ${runEvent.attempt}`}` : "Switchboard: working");
    else if (providerRetry) setStatus(`Switchboard: provider error, retry ${providerRetry.number}/${providerRetry.total} at ${localTime(new Date(providerRetry.at))}`);
    else if (stopped) setStatus("Switchboard: stopped after a provider error – see switchboard status");
    else if (waitingSince) setStatus(`Switchboard: waiting for events since ${localTime(waitingSince)}`);
  };
  const cancelRetry = () => {
    providerRetry = undefined;
    retryGeneration++;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    for (const text of retryQueued) cancelledRetries.add(text);
    retryQueued.clear();
  };
  const stopEvents = () => { eventsStopped = true; controller?.abort(); cancelRetry(); };
  const command = async (operation: string[], args: string[], signal?: AbortSignal) => {
    const reply = await execute(["supervise", ...operation, ...fixed, ...args], signal);
    const value = JSON.parse(reply.stdout);
    // Completion gives an immediate signal; refusals also catch a person closing the objective.
    // Keep this separate from usage reporting, which must continue until session shutdown.
    if (value.ok === true && ["completed", "abandoned"].includes(value.objective?.state)
      || value.ok === false && value.code === "objective_not_open" && ["completed", "abandoned"].includes(value.state)) {
      objectiveState = value.ok ? value.objective.state : value.state;
      stopEvents();
      updateStatus();
    }
    return reply;
  };
  for (const [name, tool] of Object.entries(supervisorTools)) {
    pi.registerTool({
      name, label: tool.command, description: `Run Switchboard supervise ${tool.command} for this session's objective. Returns its JSON result.`,
      parameters: z.toJSONSchema(tool.schema),
      async execute(toolCallId, input, signal) {
        const params = tool.schema.parse(input) as Record<string, unknown>;
        const directory = await mkdtemp(join(binding.privateDirectory, "call-"));
        try {
          const args: string[] = [];
          const file = async (flag: string, value: string) => {
            const path = join(directory, flag);
            await writeFile(path, value, { mode: 0o600 });
            args.push(`--${flag}`, path);
          };
          const positional: string[] = [];
          for (const [key, value] of Object.entries(params)) {
            if (key === "id" || key === "text") positional.push(String(value));
            else if (key === "body") await file("body-file", String(value));
            else if (key === "criteria") await file("criteria-file", (value as string[]).join("\n"));
            else if (key === "statements") await file("statements-file", JSON.stringify(value));
            else if (key === "note" && tool.command === "dispatch") await file("note-file", String(value));
            else if (key === "choices") for (const choice of value as string[]) args.push("--choice", choice);
            else {
              const flag = { fromAttempt: "from-attempt", dryRun: "dry-run", acceptOutput: "accept-output", label: "as" }[key] ?? key;
              if (typeof value === "boolean") { if (value) args.push(`--${flag}`); }
              else args.push(`--${flag}`, String(value));
            }
          }
          if (tool.command === "ask" || tool.command === "dispatch") {
            const requestId = createHash("sha256").update(JSON.stringify([binding.sessionId, name, toolCallId])).digest("hex");
            args.push("--request-id", `pi-${requestId}`);
          }
          const reply = await command(tool.command.split(" "), [...args, "--", ...positional], signal);
          const details: unknown = JSON.parse(reply.stdout);
          return { content: [{ type: "text", text: reply.stdout }], details };
        } finally { await rm(directory, { recursive: true, force: true }); }
      },
    });
  }

  let loop: Promise<void> | undefined;
  let pending: { text: string; event: SupervisorEvent; delivered(): void } | undefined;
  let sessionId = binding.sessionId;
  let registered = false;
  let registration: Promise<void> | undefined;
  let reporting = Promise.resolve();
  let stateReporting = Promise.resolve();
  let lastAssistant: PiMessage | undefined;
  let resumeNeeded = true;
  const deliveredSinceSuccess = new Set<string>();
  const successful = (message: PiMessage) => ["stop", "toolUse", "lengthLimit"].includes(message.stopReason ?? "");
  const observeResponse = (message: PiMessage) => {
    lastAssistant = message;
    if (message.stopReason === "error") resumeNeeded = true;
    if (successful(message)) {
      stopped = false;
      cancelRetry();
      retryCount = 0;
      deliveredSinceSuccess.clear();
    } else if (message.stopReason === "aborted") cancelRetry();
  };
  const errorText = (message?: PiMessage) => message?.errorMessage?.trim() ? message.errorMessage : "Pi model provider error (no error message reported)";
  const reportState = (state: "stopped" | "resumed" | "retrying", message?: PiMessage, retry?: { number: number; total: number; at: string }) => {
    const args = ["--session", sessionId, "--state", state];
    if (state !== "resumed") {
      args.push("--error", errorText(message));
      for (const id of deliveredSinceSuccess) args.push("--event", id);
    }
    if (retry) args.push("--retry-number", String(retry.number), "--retry-total", String(retry.total), "--next-retry-at", retry.at);
    stateReporting = stateReporting.catch(() => {}).then(async () => {
      await registerUsage();
      const reply = await command(["session-state"], args);
      if (reply.exitCode !== 0 || JSON.parse(reply.stdout).ok !== true) throw new Error("Supervisor session state reporting failed");
      stopped = state === "stopped";
      providerRetry = state === "retrying" ? retry : undefined;
      updateStatus();
    });
    return stateReporting;
  };
  const seen = new Set<string>();
  let seenMessages = new WeakSet<PiMessage>();
  let cost = 0;
  let tokens = 0;
  let observed = false;
  let unknownCost = false;
  let unknownTokens = false;
  const valid = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const addUsage = (usage: PiUsage | undefined, id?: string) => {
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
    observed = true;
    if (valid(usage?.cost?.total) && Number.isFinite(cost + usage.cost.total)) cost += usage.cost.total;
    else unknownCost = true;
    if (valid(usage?.totalTokens) && Number.isFinite(tokens + usage.totalTokens)) tokens += usage.totalTokens;
    else unknownTokens = true;
  };
  const addMessage = (message: PiMessage | undefined, id?: string) => {
    if (!message || message.role !== "assistant" && !message.usage) return;
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
    if (seenMessages.has(message)) return;
    seenMessages.add(message);
    addUsage(message.usage);
  };
  async function registerUsage() {
    if (registered) return;
    registration ??= command(["usage"], ["--session", sessionId]).then(reply => {
      if (reply.exitCode !== 0 || JSON.parse(reply.stdout).ok !== true) throw new Error("Supervisor usage registration failed");
      registered = true;
    }).finally(() => { registration = undefined; });
    await registration;
  }
  const reportUsage = () => {
    // Missing usage leaves the cumulative value unknown, even if later turns report it.
    const args = ["--session", sessionId, "--cost", observed && !unknownCost ? String(cost) : "unknown",
      "--tokens", observed && !unknownTokens ? String(tokens) : "unknown"];
    reporting = reporting.catch(() => {}).then(async () => {
      await registerUsage();
      const reply = await command(["usage"], args);
      if (reply.exitCode !== 0 || JSON.parse(reply.stdout).ok !== true) throw new Error("Supervisor usage reporting failed");
    });
    return reporting;
  };
  // Book the model response before its tools can close the objective or start more work.
  pi.on("message_end", async event => {
    if (event.message?.role !== "assistant") return;
    observeResponse(event.message);
    // The first success can recover an earlier session's stop; later reports need a new error.
    if (successful(event.message) && resumeNeeded) {
      await reportState("resumed");
      resumeNeeded = false;
    }
    addMessage(event.message);
    await reportUsage();
  });
  pi.on("turn_end", async event => {
    addMessage(event.message, event.messageEntryId);
    for (const [index, message] of (event.toolResults ?? []).entries()) addMessage(message, event.toolResultEntryIds?.[index]);
    await reportUsage();
  });
  pi.on("agent_start", (_event, ctx) => {
    context = ctx;
    running = true;
    waitingSince = undefined;
    updateStatus();
  });
  // agent_end and agent_before_settle can still lead to retries or continuations. Only settled is final.
  pi.on("agent_settled", async (event, ctx) => {
    context = ctx;
    running = false;
    runEvent = undefined;
    if (shuttingDown) return;
    if (event.aborted) cancelRetry();
    if (event.aborted || lastAssistant?.stopReason !== "error") {
      waitingSince ??= new Date();
      updateStatus();
      return;
    }
    const message = lastAssistant;
    const delays = binding.providerRetries?.delaysMs ?? [];
    if (retryTimer || retryDelivery) { updateStatus(); return; }
    if (retryCount >= delays.length || eventsStopped) { await reportState("stopped", message); return; }
    const generation = retryGeneration;
    const delayMs = delays[retryCount++]!;
    const at = new Date(Date.now() + delayMs).toISOString();
    await reportState("retrying", message, { number: retryCount, total: delays.length, at });
    if (generation !== retryGeneration || shuttingDown || eventsStopped) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      retryDelivery = (async () => {
        const reply = await command(["objective", "show"], []);
        if (generation !== retryGeneration || shuttingDown || eventsStopped) return;
        if (reply.exitCode !== 0 || JSON.parse(reply.stdout).ok !== true) throw new Error("Could not check objective before provider retry");
        const text = `The previous model request failed with this provider error: ${errorText(message)}\nRead the briefing with sb_briefing and continue. (Provider retry ${retryCount}/${delays.length}, scheduled for ${at}.)`;
        queued.add(text);
        retryQueued.add(text);
        await pi.sendUserMessage(text, { deliverAs: "followUp" });
      })().catch(async () => {
        if (generation === retryGeneration && !shuttingDown && !eventsStopped) await reportState("stopped", message);
      }).catch(() => {}).finally(() => { retryDelivery = undefined; });
    }, Math.max(0, Date.parse(at) - Date.now()));
  });
  pi.on("session_compact", async event => {
    if (event.compactionEntry?.usage) addUsage(event.compactionEntry.usage, event.compactionEntry.id);
    await reportUsage();
  });
  async function startSession() {
    await registerUsage();
    if (controller || eventsStopped) return;
    controller = new AbortController();
    loop = poll(controller.signal).catch(() => {});
  }
  // Pi reports hook errors and continues, so do not throw past this gate while registration is retryable.
  pi.on("before_provider_request", async (_event, context) => {
    while (!context?.signal?.aborted) {
      try { await startSession(); return; }
      catch { await delay(retryMs, undefined, context?.signal ? { signal: context.signal } : undefined); }
    }
  });
  const delivered = (event: PiEvent) => {
    const message = event.message;
    const text = event.prompt ?? (message?.role === "user" ? typeof message.content === "string" ? message.content
      : message.content.filter(part => part.type === "text").map(part => part.text ?? "").join("") : undefined);
    if (pending && text === pending.text) {
      runEvent = pending.event;
      pending.delivered();
      updateStatus();
    }
  };
  pi.on("before_agent_start", (event, ctx) => {
    context = ctx;
    runEvent = undefined;
    delivered(event);
  });
  pi.on("message_start", (event, ctx) => {
    context = ctx;
    delivered(event);
  });
  const queuedEvent = (message: PiMessage) => message.role === "user" && queued.has(typeof message.content === "string" ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text ?? "").join(""));
  pi.on("context", async event => {
    const messages = event.messages ?? [];
    if (!messages.some(queuedEvent)) return;
    // Pi cannot withdraw a queued follow-up. Check again at the model boundary and hide it if closed.
    if (!eventsStopped) await command(["objective", "show"], []);
    const cancelledRetry = (message: PiMessage) => message.role === "user" && cancelledRetries.has(typeof message.content === "string" ? message.content
      : message.content.filter(part => part.type === "text").map(part => part.text ?? "").join(""));
    if (eventsStopped) return { messages: messages.filter(message => !queuedEvent(message)) };
    if (messages.some(cancelledRetry)) return { messages: messages.filter(message => !cancelledRetry(message)) };
    for (const message of messages.filter(queuedEvent)) {
      const text = typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text ?? "").join("");
      queued.delete(text);
      retryQueued.delete(text);
    }
  });
  const pause = (signal: AbortSignal) => delay(retryMs, undefined, { signal });
  async function poll(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const reply = await command(["wait"], ["--timeout", "30"], signal);
        if (signal.aborted) return;
        const value = JSON.parse(reply.stdout);
        if (reply.exitCode !== 0 || value.ok !== true) throw new Error("Supervisor wait failed");
        if (!value.event) continue;
        const event = value.event as SupervisorEvent;
        const text = eventText(event);
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const settle = (error?: unknown) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", abort);
            pending = undefined;
            if (error !== undefined) reject(error);
            else resolve();
          };
          const abort = () => settle(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          pending = { text, event, delivered: () => { deliveredSinceSuccess.add(event.id); settle(); } };
          Promise.resolve().then(() => {
            if (signal.aborted) return;
            queued.add(text);
            return pi.sendUserMessage(text, { deliverAs: "followUp" });
          }).catch(settle);
        });
        // Delivery, not queueing or a turn ending, permits acknowledgement. Never fetch past a failed acknowledgement.
        while (!signal.aborted) {
          try {
            const handled = await command(["handled"], ["--", event.id], signal);
            if (handled.exitCode !== 0 || JSON.parse(handled.stdout).ok !== true) throw new Error("Supervisor handled failed");
            break;
          } catch { if (!signal.aborted) await pause(signal); }
        }
      } catch { if (!signal.aborted) await pause(signal); }
    }
  }
  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    if (controller) return;
    shuttingDown = false;
    running = stopped = false;
    runEvent = undefined;
    waitingSince = undefined;
    cancelRetry();
    retryCount = 0;
    sessionId = context?.sessionManager.getSessionId() ?? binding.sessionId;
    registered = false;
    seen.clear();
    seenMessages = new WeakSet<PiMessage>();
    cost = tokens = 0;
    observed = unknownCost = unknownTokens = false;
    lastAssistant = undefined;
    resumeNeeded = true;
    deliveredSinceSuccess.clear();
    // Include compacted and off-branch messages when reloading this session.
    for (const entry of context?.sessionManager.getEntries() ?? []) {
      if (entry.type === "message") {
        addMessage(entry.message, entry.id);
        if (entry.message?.role === "assistant") observeResponse(entry.message);
        if (entry.message?.role === "user") {
          const text = typeof entry.message.content === "string" ? entry.message.content
            : entry.message.content.filter(part => part.type === "text").map(part => part.text ?? "").join("");
          if (text.startsWith("Switchboard event ")) {
            try {
              const event = JSON.parse(text.slice(text.indexOf("\n") + 1)) as SupervisorEvent;
              if (typeof event.id === "string" && text === eventText(event)) deliveredSinceSuccess.add(event.id);
            } catch { /* Not an event delivered by this host. */ }
          }
        }
      }
      else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
        if (entry.usage) addUsage(entry.usage, entry.id);
      }
    }
    await startSession();
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    setStatus(undefined, ctx);
    context = undefined;
    cancelRetry();
    controller?.abort();
    await retryDelivery;
    await loop;
    await reporting.catch(() => {});
    await stateReporting.catch(() => {});
    controller = undefined;
    loop = undefined;
  });
}

export type SupervisorEvent = { id: string; kind: string; taskId: string | null; attempt: number | null; [key: string]: unknown };
export function eventText(event: SupervisorEvent): string {
  const next: Record<string, string> = {
    question_asked: "Answer the worker's question or ask the person.",
    worker_finished: "Read the briefing and decide whether to review, repair or finish.",
    attempt_held: "Read the briefing and decide how to address the hold.",
    decision_needed: "Read the briefing and address the refusal without bypassing safety checks.",
    review_recorded: "Read the findings and decide whether to repair or finish the exact commit.",
    budget_reached: "Do not dispatch more work; ask the person what to do next.",
    deadline_reached: "Do not dispatch more work; ask the person what to do next.",
    person_answered: "Read the person's answer and continue within the objective's authority.",
    person_intervention: "Read the briefing again before deciding what to do next.",
    dispatcher_heartbeat_stale: "The worker may still be running; ask the person to inspect it and confirm it stopped before dispatching again.",
  };
  return `Switchboard event ${event.id}: kind=${event.kind}, task=${event.taskId ?? "none"}, attempt=${event.attempt ?? "none"}. ${next[event.kind] ?? "Read the briefing and decide the next action."}\n${JSON.stringify(event, null, 2)}`;
}

export default function (pi: SupervisorPi) {
  const path = process.env.SWITCHBOARD_SUPERVISOR_BINDING;
  if (!path) throw new Error("Start this extension with switchboard supervisor start");
  registerSupervisor(pi, bindingSchema.parse(JSON.parse(readFileSync(path, "utf8"))));
}
