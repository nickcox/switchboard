import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readActivity, type ActivityEntry } from "../runtime/activity.ts";
import { dispatcherRunning } from "../runtime/heartbeat.ts";
import type { RuntimeRecord } from "../runtime/records.ts";

const isFinalNote = (entry: ActivityEntry) => entry.kind === "note" && entry.text.startsWith("Worker finished");
import type { Dependencies } from "./dispatch.ts";

export type ActivitySummary = {
  lastActivity: string | null;
  /** The tool that has started but not finished, if any. */
  currentTool: string | null;
  tokens: number | null;
  cost: number | null;
};

export function summariseActivity(entries: ActivityEntry[]): ActivitySummary {
  const open = new Map<string, string>();
  let tokens: number | null = null;
  let cost: number | null = null;
  for (const entry of entries) {
    if (entry.kind === "tool_start") open.set(entry.id, entry.tool);
    if (entry.kind === "tool_end") open.delete(entry.id);
    if (entry.kind === "stats") { tokens = entry.tokens; cost = entry.cost; }
  }
  return { lastActivity: entries.at(-1)?.ts ?? null, currentTool: [...open.values()].at(-1) ?? null, tokens, cost };
}

/** Pi's session file for a runtime record, if one has been written. */
export async function transcriptPath(record: RuntimeRecord): Promise<string | undefined> {
  try {
    const name = (await readdir(record.binding.sessionDirectory)).filter(file => file.endsWith(".jsonl")).sort()[0];
    return name ? join(record.binding.sessionDirectory, name) : undefined;
  } catch { return undefined; }
}

/**
 * Prints an attempt's activity and, when following, new entries as they arrive. Works without a running dispatcher:
 * it only reads the runtime records. Following ends once the worker's exit is recorded or confirmed and its dispatcher
 * has finished writing activity: the worker's final note has been written, or no dispatcher heartbeat is fresh.
 */
export async function watch(
  deps: Dependencies, options: { leaseId: string; follow: boolean; print: (entry: ActivityEntry) => void; signal?: AbortSignal; pollMs?: number },
): Promise<{ found: boolean; finished: boolean }> {
  const find = async () => (await deps.runtime.discover(deps.contextId)).find(r => r.binding.input.identity.leaseId === options.leaseId);
  let record = await find();
  if (!record) return { found: false, finished: false };
  let printed = 0;
  for (;;) {
    const entries = await readActivity(record);
    for (const entry of entries.slice(printed)) options.print(entry);
    printed = Math.max(printed, entries.length);
    const identity = record.binding.input.identity;
    const attempt = (await deps.attempts.forTask(identity.taskId)).find(a => a.entries.some(e => e.kind === "leased" && e.data.leaseId === identity.leaseId));
    const stopped = attempt && deps.attempts.confirmations(attempt).some(c => c.fact === "worker_stopped" && c.scope.leaseId === identity.leaseId &&
      (c.scope.sessionId === undefined || c.scope.sessionId === identity.sessionId));
    const finished = record.child.status !== "unknown" || Boolean(stopped);
    const settled = finished && (entries.some(isFinalNote) || !await dispatcherRunning(record));
    if (!options.follow || settled || options.signal?.aborted) {
      // Print anything written between the last read and the decision to stop.
      if (options.follow && settled) for (const entry of (await readActivity(record)).slice(printed)) options.print(entry);
      return { found: true, finished };
    }
    await sleep(options.pollMs ?? 1000, undefined, { signal: options.signal }).catch(() => {});
    record = (await find()) ?? record;
  }
}
