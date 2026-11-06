import { z } from "zod";
import { completionStatementsSchema } from "../../objectives/store.ts";
import { resultRenderer } from "./rendering.ts";

const text = z.string();
const attempt = z.number().int().positive();
const selector = { task: text.optional(), lease: text.optional(), attempt: attempt.optional() };
const definition = { title: text.optional(), body: text.optional(), repo: text.optional(), kind: text.optional(), criteria: z.array(text.trim().min(1).refine(value => !/[\r\n]/.test(value), "Criteria must be single lines")).optional() };
const operation = (command: string, fields: z.ZodRawShape = {}) => ({ command, schema: z.strictObject(fields), renderResult: resultRenderer(command) });

/** Only operation inputs belong here – authority and request identity belong to the host. */
export const supervisorTools = {
  sb_briefing: operation("briefing"),
  sb_note: operation("note", { text }),
  sb_ask: operation("ask", { text, choices: z.array(text).optional() }),
  sb_objective_show: operation("objective show"),
  sb_objective_complete: operation("objective complete", { statements: completionStatementsSchema }),
  sb_task_add: operation("task add", { id: text, ...definition, title: text }),
  sb_task_show: operation("task show", { id: text }),
  sb_task_list: operation("task list", { repo: text.optional(), state: z.enum(["queued", "in_flight", "done"]).optional() }),
  sb_task_update: operation("task update", { id: text, ...definition }),
  sb_task_hold: operation("task hold", { id: text, reason: text }),
  sb_task_release: operation("task release", { id: text }),
  sb_task_block: operation("task block", { id: text, by: text }),
  sb_task_unblock: operation("task unblock", { id: text, by: text }),
  sb_task_done: operation("task done", { id: text, note: text.optional() }),
  sb_dispatch: operation("dispatch", { task: text, fromAttempt: attempt.optional(), note: text.optional(), dryRun: z.boolean().optional() }),
  sb_review: operation("review", { task: text, attempt: attempt.optional() }),
  sb_answer: operation("answer", { task: text, question: text, text, wait: z.number().positive().optional() }),
  sb_steer: operation("steer", { ...selector, text, after: z.boolean().optional(), label: text.optional(), wait: z.number().positive().optional() }),
  sb_stop: operation("stop", { ...selector, label: text.optional(), wait: z.number().positive().optional() }),
  sb_finish: operation("finish", { ...selector, acceptOutput: z.boolean().optional(), rebase: z.boolean().optional(), dryRun: z.boolean().optional() }),
};
export const supervisorToolNames = Object.keys(supervisorTools);
