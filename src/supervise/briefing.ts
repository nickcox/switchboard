import { AttemptStore } from "../attempts/store.ts";
import type { CheckResult } from "../attempts/checks.ts";
import type { ReviewRecord } from "../attempts/reviews.ts";
import type { AttemptEntry } from "../attempts/log.ts";
import type { Dependencies } from "../dispatch/dependencies.ts";
import { requireAuthority } from "../dispatch/safety.ts";
import { status, type AttemptStatus } from "../dispatch/status.ts";
import type { AttemptState } from "../dispatch/state.ts";
import { ObjectiveStore } from "../objectives/store.ts";
import { readQuestions } from "../runtime/questions-store.ts";
import { TaskStoreError } from "../tasks/store.ts";
import { readNotes } from "./notes.ts";

type BriefingAttempt = {
  contextId: string; taskId: string; attempt: number; status: AttemptState | null; archived: boolean;
  assessment?: AttemptStatus;
  checks: CheckResult[]; reviews: ReviewRecord[];
  outputRetained: boolean | null; retention: AttemptEntry | null;
  leaseHeld: boolean | null; leaseReturn: string;
  possiblyRunning: boolean; warning?: string;
  archivedAt?: string; summary?: unknown;
};

/** A read-only briefing uses status itself, so it cannot introduce another attempt classification. */
export async function briefing(deps: Dependencies, objectiveId: string) {
  const database = deps.attempts.database;
  requireAuthority(database, deps.caller, "recordAttempt", { objectiveId });
  const shown = new ObjectiveStore(database, deps.caller).show(objectiveId);
  if (shown.state !== "open") throw new TaskStoreError("rejected", `Objective ${objectiveId} must be open before supervising it`);
  const { tasks: linked, personInterventions, ...objective } = shown;
  const contexts = database.all(`SELECT DISTINCT n.context FROM attempt_numbers n JOIN tasks t ON t.id = n.task
    WHERE t.objective_id = ? ORDER BY n.context`, objectiveId).map(row => String(row.context));
  const attempts: BriefingAttempt[] = [];
  const diagnostics: { contextId: string; detail: string }[] = [];
  for (const contextId of contexts) {
    const store = contextId === deps.contextId ? deps.attempts : new AttemptStore(database, contextId, deps.caller, deps.checks);
    const current = await status({ ...deps, contextId, attempts: store }, { activity: false, transcript: false });
    if (current.detail) diagnostics.push({ contextId, detail: current.detail });
    for (const assessment of current.attempts.filter(attempt => linked.some(task => task.id === attempt.attempt.taskId))) {
      const ref = { contextId, taskId: assessment.attempt.taskId, attempt: assessment.attempt.attempt };
      const record = store.findForTask(ref.taskId, ref.attempt);
      const retention = [...(record?.entries ?? [])].reverse().find(entry => entry.kind === "retention_checked") ?? null;
      const leaseUnknown = assessment.leaseInOtherPool !== undefined || assessment.unknownOwners !== undefined;
      const leaseHeld = leaseUnknown ? null : assessment.leaseHeld;
      attempts.push({ ...ref, status: assessment.state, archived: false, assessment,
        checks: assessment.checks ?? [], reviews: assessment.reviews ?? [],
        outputRetained: retention ? Boolean(retention.data.retained) : null, retention, leaseHeld,
        leaseReturn: leaseHeld === false ? "The lease is not held." : leaseHeld === true
          ? "The lease is still held. Only a person can confirm no processes remain and return it; this does not by itself block further work."
          : "Whether the lease is still held is unknown. A person must reconcile its owner records before returning it.",
        possiblyRunning: assessment.possiblyRunning,
        ...(assessment.possiblyRunning ? { warning: "The worker may still be running. Do not start this task again." } : {}),
      });
    }
  }
  for (const row of database.all(`SELECT ar.* FROM archived_attempts ar JOIN tasks t ON t.id = ar.task
    WHERE t.objective_id = ? ORDER BY ar.context,ar.task,ar.attempt`, objectiveId)) {
    const archive = JSON.parse(String(row.summary));
    const retention: AttemptEntry | null = archive.retention ?? null;
    attempts.push({ contextId: String(row.context), taskId: String(row.task), attempt: Number(row.attempt), archived: true,
      // Prune saved the shared assessment's state, after proving the worker stopped and the lease was returned.
      status: archive.summary?.state ?? null, archivedAt: archive.archivedAt, summary: archive.summary,
      checks: archive.checks ?? [], reviews: archive.reviews ?? [], outputRetained: retention ? Boolean(retention.data.retained) : null, retention,
      leaseHeld: false, leaseReturn: "The attempt was archived after its lease was returned.", possiblyRunning: false,
    });
  }
  const tasks = await Promise.all(linked.map(async task => ({
    ...await deps.tasks.read(task.id),
    dependencies: database.all("SELECT blocker FROM dependencies WHERE task = ? ORDER BY blocker", task.id).map(row => String(row.blocker)),
    attempts: attempts.filter(attempt => attempt.taskId === task.id).sort((a, b) => a.contextId.localeCompare(b.contextId) || a.attempt - b.attempt),
  })));
  const openQuestions = contexts.flatMap(contextId => readQuestions(database, { contextId }).questions)
    .filter(question => !question.answer && linked.some(task => task.id === question.taskId))
    .sort((a, b) => Date.parse(a.askedAt) - Date.parse(b.askedAt) || a.id.localeCompare(b.id));
  return { ok: true, action: "briefing", objective: { ...objective, criteria: objective.criteria.map(criterion => ({
    ...criterion, status: criterion.completion === null ? "pending" : "completed",
  })) }, tasks, possiblyRunning: attempts.filter(attempt => attempt.possiblyRunning).map(attempt => ({
    contextId: attempt.contextId, taskId: attempt.taskId, attempt: attempt.attempt, warning: attempt.warning!,
  })), openQuestions, notes: readNotes(database, objectiveId), personInterventions, diagnostics };
}
