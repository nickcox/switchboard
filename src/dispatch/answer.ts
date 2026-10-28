import { QuestionStore } from "../runtime/questions-store.ts";
import { describeQuestions, writeAnswerFile } from "../runtime/questions.ts";
import { awaitDelivery } from "../runtime/requests.ts";
import { RuntimeStore } from "../runtime/store.ts";
import type { Dependencies } from "./dependencies.ts";
import { requireOperationAuthority } from "./safety.ts";
import { result, type DispatchResult } from "./result.ts";

/** An answer remains recorded even when the worker has finished or neither delivery channel succeeds. */
export async function answerQuestion(deps: Dependencies, options: {
  taskId: string; questionId: string; answer: string; waitMs?: number;
}): Promise<DispatchResult> {
  const base = { stage: "control" as const, lease: "unknown" as const };
  const store = new QuestionStore(deps.attempts.database);
  let recorded;
  try {
    requireOperationAuthority(deps, ["answerQuestions"], { taskId: options.taskId });
    if (options.waitMs !== undefined && (!Number.isFinite(options.waitMs) || options.waitMs <= 0)) throw new Error("waitMs must be positive");
    recorded = await store.answer(deps.contextId, options.taskId, options.questionId, options.answer, deps.caller);
  } catch (error) {
    return result({ ...base, ok: false, reason: "refused", observed: { questionId: options.questionId },
      detail: error instanceof Error ? error.message : String(error), nextAction: "inspect_attempt" });
  }
  const { question, directory, claimId } = recorded;
  if (directory) await writeAnswerFile(store, directory, question);
  else await store.fileDelivery(question.id, "unavailable", "The attempt's runtime directory has been archived");
  const requestId = question.answer!.requestId;
  if (requestId && directory && claimId) {
    await awaitDelivery({ directory, claimId, storage: new RuntimeStore(deps.attempts.database) }, requestId, options.waitMs ?? 10000);
  }
  const current = (await store.list({ contextId: deps.contextId, taskId: options.taskId, attempt: question.attempt })).questions.find(q => q.id === question.id)!;
  return result({ ...base, ok: true, reason: "answered", attempt: { contextId: deps.contextId, taskId: options.taskId, attempt: question.attempt },
    observed: { question: current }, detail: describeQuestions([current]).join("\n"), nextAction: "inspect_attempt" });
}
