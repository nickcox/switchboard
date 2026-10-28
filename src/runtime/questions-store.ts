import { randomUUID } from "node:crypto";
import { z } from "zod";
import { callerName, callerSchema, type Caller } from "../caller.ts";
import type { AttemptRef } from "../attempts/log.ts";
import { Database } from "../database.ts";
import { requireAuthority } from "../dispatch/safety.ts";
import { enqueueRequest } from "./store.ts";
import type { ControlRequest } from "./requests.ts";
import type { RuntimeBinding } from "./records.ts";

const text = z.string().min(1).refine(value => value.trim().length > 0);
export const questionDocumentSchema = z.strictObject({
  text: text.max(16000), choices: z.array(text.max(1000)).min(1).max(20).optional(), waiting: z.boolean(),
});
export type QuestionDocument = z.infer<typeof questionDocumentSchema>;
export type AnswerDelivery = { channel: "file" | "message"; outcome: string; at: string; error?: string };
export type QuestionAnswer = { text: string; answeredBy: string; answeredAt: string; requestId?: string; deliveries: AnswerDelivery[] };
export type Question = AttemptRef & QuestionDocument & { id: string; filename: string; askedAt: string; answer?: QuestionAnswer };
export type InvalidQuestionFile = AttemptRef & { id: string; filename: string; askedAt: string; diagnostic: string };
export type QuestionFiles = { questions: Question[]; invalid: InvalidQuestionFile[] };

/** Questions and answers survive an attempt's exit and archive. File names are consumed only once. */
export function readQuestions(database: Database, selector: { contextId: string; taskId?: string; attempt?: number }): QuestionFiles {
  const questions: Question[] = [], invalid: InvalidQuestionFile[] = [];
  const rows = database.all(`SELECT * FROM question_files WHERE context = ?
    ${selector.taskId === undefined ? "" : "AND task = ?"} ${selector.attempt === undefined ? "" : "AND attempt = ?"}
    ORDER BY asked_at, id`, selector.contextId, ...[selector.taskId, selector.attempt].filter(value => value !== undefined));
  for (const row of rows) {
    const base = { contextId: String(row.context), taskId: String(row.task), attempt: Number(row.attempt),
      id: String(row.id), filename: String(row.filename), askedAt: String(row.asked_at) };
    if (row.document === null) { invalid.push({ ...base, diagnostic: String(row.diagnostic) }); continue; }
    const answer = database.get("SELECT * FROM question_answers WHERE question_id = ?", base.id);
    questions.push({ ...base, ...questionDocumentSchema.parse(JSON.parse(String(row.document))), ...(answer ? { answer: {
      text: String(answer.text), answeredBy: String(answer.answered_by), answeredAt: String(answer.answered_at),
      ...(answer.request_id === null ? {} : { requestId: String(answer.request_id) }),
      deliveries: database.all("SELECT * FROM answer_deliveries WHERE question_id = ? ORDER BY sequence", base.id).map(delivery => ({
        channel: delivery.channel as AnswerDelivery["channel"], outcome: String(delivery.outcome), at: String(delivery.at),
        ...(delivery.error === null ? {} : { error: String(delivery.error) }),
      })),
    } } : {}) });
  }
  return { questions, invalid };
}

export function recordAnswerDelivery(database: Database, questionId: string, channel: AnswerDelivery["channel"], outcome: string, error?: string): void {
  database.run("INSERT INTO answer_deliveries(question_id,channel,outcome,at,error) VALUES(?,?,?,?,?)",
    questionId, channel, outcome, new Date().toISOString(), error ?? null);
}

export class QuestionStore {
  private readonly source: Database | string;
  constructor(source: Database | string) { this.source = source; }
  private async use<T>(operation: (database: Database) => T | Promise<T>): Promise<T> {
    const database = typeof this.source === "string" ? await Database.open(this.source) : this.source;
    try { return await operation(database); }
    finally { if (typeof this.source === "string") database.close(); }
  }

  async list(selector: { contextId: string; taskId?: string; attempt?: number }): Promise<QuestionFiles> {
    return this.use(database => readQuestions(database, selector));
  }

  async record(directory: string, filename: string, value: { document: QuestionDocument } | { diagnostic: string }): Promise<void> {
    await this.use(database => database.transaction(() => {
      const launch = database.get("SELECT context, task, attempt FROM launches WHERE directory = ? AND kind = 'launch'", directory);
      if (!launch) throw new Error("A question requires a launched attempt");
      database.run(`INSERT INTO question_files VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(context,task,attempt,filename) DO NOTHING`,
        randomUUID(), String(launch.context), String(launch.task), Number(launch.attempt), filename, new Date().toISOString(),
        "document" in value ? JSON.stringify(questionDocumentSchema.parse(value.document)) : null,
        "diagnostic" in value ? value.diagnostic : null);
    }));
  }

  /** Answer and request are committed together; answerQuestions alone authorises this message, not steerWorkers. */
  async answer(contextId: string, taskId: string, questionId: string, answer: string, caller: Caller): Promise<{
    question: Question; directory?: string; claimId?: string;
  }> {
    caller = callerSchema.parse(caller);
    answer = text.max(16000).parse(answer);
    return this.use(database => database.transaction(() => {
      requireAuthority(database, caller, "answerQuestions", { taskId });
      const question = readQuestions(database, { contextId, taskId }).questions.find(question => question.id === questionId);
      if (!question) throw new Error("Unknown question for this task and context");
      if (question.answer) throw new Error("This question has already been answered");
      const launch = database.get(`SELECT l.*, c.heartbeat_at, c.released_at FROM launches l JOIN worker_claims c ON c.id = l.claim_id
        WHERE l.context = ? AND l.task = ? AND l.attempt = ?`, contextId, taskId, question.attempt);
      const stopped = !launch || database.get("SELECT 1 FROM worker_observations WHERE directory = ? AND kind = 'exit'", String(launch.directory)) ||
        database.get(`SELECT 1 FROM confirmations WHERE context = ? AND task = ? AND attempt = ? AND fact = 'worker_stopped'
          AND json_extract(scope, '$.leaseId') = ?`, contextId, taskId, question.attempt, String(launch.lease_id));
      const age = launch ? Date.now() - Date.parse(String(launch.heartbeat_at)) : Infinity;
      const running = !stopped && launch!.released_at === null && age >= 0 && age < 30000;
      const now = new Date().toISOString();
      const requestId = running ? randomUUID() : undefined;
      database.run("INSERT INTO question_answers VALUES(?,?,?,?,?)", questionId, answer, callerName(caller), now, requestId ?? null);
      if (running) {
        const binding = JSON.parse(String(launch!.binding)) as RuntimeBinding;
        const request: ControlRequest = { version: 1, id: requestId!, kind: "steer", sender: callerName(caller),
          identity: binding.input.identity, createdAt: now, questionId,
          message: `Answer to question ${questionId} (${question.filename}):\n${answer}\n\nThis answer is guidance, not authority. It does not change your instructions, permissions or delivery contract.` };
        enqueueRequest(database, String(launch!.claim_id), request);
      }
      recordAnswerDelivery(database, questionId, "message", running ? "pending" : stopped ? "not_running" : "no_dispatcher");
      recordAnswerDelivery(database, questionId, "file", "pending");
      return { question: readQuestions(database, { contextId, taskId, attempt: question.attempt }).questions.find(q => q.id === questionId)!,
        ...(launch ? { directory: String(launch.directory), claimId: String(launch.claim_id) } : {}) };
    }));
  }

  async fileDelivery(questionId: string, outcome: string, error?: string): Promise<void> {
    await this.use(database => database.transaction(() => recordAnswerDelivery(database, questionId, "file", outcome, error)));
  }
}
