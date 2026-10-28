import { summarise } from "./attempt.ts";
import type { Dependencies } from "./dependencies.ts";
import { result, type AttemptSummary, type DispatchResult, type NextAction } from "./result.ts";

/**
 * The lease of a task's attempt, its latest unless `attempt` is given, for the commands that act on an attempt through
 * its lease. An attempt that stopped before acquiring a lease has none, and is refused with that reason.
 */
export async function leaseOfTask(deps: Dependencies, taskId: string, attempt?: number): Promise<{ leaseId: string } | { refused: DispatchResult }> {
  const observed = { taskId, ...(attempt === undefined ? {} : { attempt }) };
  const refused = (detail: string, options: { lease?: "none" | "unknown"; nextAction?: NextAction; attempt?: AttemptSummary } = {}) => ({
    refused: result({
      ok: false, reason: "refused", stage: "select", lease: options.lease ?? "none", observed, detail, nextAction: options.nextAction ?? "inspect_attempt",
      ...(options.attempt ? { attempt: options.attempt } : {}),
    }),
  });
  let attempts;
  try { attempts = await deps.attempts.forTask(taskId); }
  catch (error) { return refused(`The attempt log could not be read: ${error instanceof Error ? error.message : String(error)}`, { lease: "unknown", nextAction: "fix_configuration" }); }
  const chosen = attempt === undefined ? attempts.reduce<typeof attempts[number] | undefined>((latest, a) => (!latest || a.attempt > latest.attempt ? a : latest), undefined)
    : attempts.find(a => a.attempt === attempt);
  if (!chosen) return refused(`Task ${taskId} has no ${attempt === undefined ? "attempt" : `attempt ${attempt}`} in this context`);
  const summary = summarise(chosen);
  if (!summary.leaseId) return refused(`Attempt ${chosen.attempt} of task ${taskId} has no lease: it stopped before a workspace was leased`, { attempt: summary });
  return { leaseId: summary.leaseId };
}
