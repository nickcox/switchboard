import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { supervisorTools } from "./tools.ts";

export const bindingSchema = z.strictObject({
  objectiveId: z.string().min(1), configPath: z.string().min(1), cliPath: z.string().min(1),
  privateDirectory: z.string().min(1), sessionId: z.string().min(1),
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
type PiMessage = { role: string; content: string | { type: string; text?: string }[]; usage?: PiUsage };
type PiEvent = { prompt?: string; message?: PiMessage; messageEntryId?: string; toolResults?: PiMessage[]; toolResultEntryIds?: string[]; compactionEntry?: { id: string; usage?: PiUsage } };
type PiContext = { sessionManager: { getSessionId(): string; getEntries(): { id: string; type: string; message?: PiMessage; usage?: PiUsage }[] } };
/** The small part of Pi's extension API used here; Pi loads the extension, not Switchboard. */
export interface SupervisorPi {
  registerTool(tool: SupervisorTool): void;
  on(event: string, handler: (event: PiEvent, context?: PiContext) => void | Promise<void>): void;
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
  const command = (operation: string[], args: string[], signal?: AbortSignal) => execute(["supervise", ...operation, ...fixed, ...args], signal);
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

  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;
  let pending: { text: string; delivered(): void } | undefined;
  let sessionId = binding.sessionId;
  let registered = false;
  let registration: Promise<void> | undefined;
  let reporting = Promise.resolve();
  const seen = new Set<string>();
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
    if (message?.role === "assistant" || message?.usage) addUsage(message.usage, id);
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
  pi.on("turn_end", async event => {
    addMessage(event.message, event.messageEntryId);
    for (const [index, message] of (event.toolResults ?? []).entries()) addMessage(message, event.toolResultEntryIds?.[index]);
    await reportUsage();
  });
  pi.on("session_compact", async event => {
    if (event.compactionEntry?.usage) addUsage(event.compactionEntry.usage, event.compactionEntry.id);
    await reportUsage();
  });
  async function startSession() {
    await registerUsage();
    if (controller) return;
    controller = new AbortController();
    loop = poll(controller.signal).catch(() => {});
  }
  // A failed startup registration must be retried before any provider request.
  pi.on("before_provider_request", startSession);
  const delivered = (event: PiEvent) => {
    const message = event.message;
    const text = event.prompt ?? (message?.role === "user" ? typeof message.content === "string" ? message.content
      : message.content.filter(part => part.type === "text").map(part => part.text ?? "").join("") : undefined);
    if (pending && text === pending.text) pending.delivered();
  };
  pi.on("before_agent_start", delivered);
  pi.on("message_start", delivered);
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
          pending = { text, delivered: () => settle() };
          Promise.resolve().then(() => pi.sendUserMessage(text, { deliverAs: "followUp" })).catch(settle);
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
  pi.on("session_start", async (_event, context) => {
    if (controller) return;
    sessionId = context?.sessionManager.getSessionId() ?? binding.sessionId;
    registered = false;
    seen.clear();
    cost = tokens = 0;
    observed = unknownCost = unknownTokens = false;
    // Include compacted and off-branch messages when reloading this session.
    for (const entry of context?.sessionManager.getEntries() ?? []) {
      if (entry.type === "message") addMessage(entry.message, entry.id);
      else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
        if (entry.usage) addUsage(entry.usage, entry.id);
      }
    }
    await startSession();
  });
  pi.on("session_shutdown", async () => {
    controller?.abort();
    await loop;
    await reporting.catch(() => {});
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
