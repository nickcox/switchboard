import { randomUUID } from "node:crypto";
import { callerName, callerSchema, type Caller } from "../caller.ts";
import type { Database } from "../database.ts";
import { requireScope } from "../dispatch/safety.ts";
import { TaskStoreError } from "../tasks/store.ts";
import { recordEvent } from "./events.ts";

export type PersonQuestion = {
  id: string; objectiveId: string; text: string; choices?: string[]; askedAt: string; askedBy: string; requestId: string;
  answer: { text: string; answeredBy: string; answeredAt: string } | null;
};

export function readPersonQuestions(database: Database, objectiveId?: string): PersonQuestion[] {
  return database.all(`SELECT q.*, a.text AS answer_text, a.answered_by, a.answered_at FROM person_questions q
    LEFT JOIN person_answers a ON a.question_id = q.id WHERE (? IS NULL OR q.objective = ?) ORDER BY q.asked_at,q.id`, objectiveId ?? null, objectiveId ?? null).map(row => ({
    id: String(row.id), objectiveId: String(row.objective), text: String(row.text),
    ...(row.choices === null ? {} : { choices: JSON.parse(String(row.choices)) as string[] }),
    askedAt: String(row.asked_at), askedBy: String(row.asked_by), requestId: String(row.request_id),
    answer: row.answer_text === null ? null : { text: String(row.answer_text), answeredBy: String(row.answered_by), answeredAt: String(row.answered_at) },
  }));
}

export async function askPerson(database: Database, caller: Caller, objectiveId: string, text: string, choices?: string[], requestId: string = randomUUID()): Promise<PersonQuestion> {
  caller = callerSchema.parse(caller);
  if (caller.kind !== "supervisor" || caller.objectiveId !== objectiveId) throw new TaskStoreError("rejected", "Only the objective's supervisor can ask the person a question");
  if (!text.trim() || choices?.some(choice => !choice.trim()) || !requestId.trim()) throw new TaskStoreError("rejected", "Question text, choices and request ID must not be blank");
  return database.transaction(() => {
    requireScope(database, caller, { objectiveId });
    if (database.get("SELECT state FROM objectives WHERE id = ?", objectiveId)?.state !== "open") throw new TaskStoreError("rejected", `Objective ${objectiveId} must be open before asking a question`);
    const existing = readPersonQuestions(database, objectiveId).find(question => question.requestId === requestId);
    if (existing) {
      if (existing.text !== text || JSON.stringify(existing.choices) !== JSON.stringify(choices)) throw new TaskStoreError("rejected", "Request ID already records a different question");
      return existing;
    }
    const question: PersonQuestion = { id: randomUUID(), objectiveId, text, ...(choices === undefined ? {} : { choices }), askedAt: new Date().toISOString(), askedBy: callerName(caller), requestId, answer: null };
    database.run("INSERT INTO person_questions VALUES(?,?,?,?,?,?,?)", question.id, objectiveId, text, choices === undefined ? null : JSON.stringify(choices), question.askedAt, question.askedBy, requestId);
    return question;
  });
}

export async function answerPersonQuestion(database: Database, caller: Caller, objectiveId: string, questionId: string, text: string): Promise<PersonQuestion> {
  caller = callerSchema.parse(caller);
  if (caller.kind !== "person") throw new TaskStoreError("rejected", "Only a person can answer a supervisor's question");
  if (!text.trim()) throw new TaskStoreError("rejected", "An answer must not be blank");
  return database.transaction(() => {
    const question = readPersonQuestions(database, objectiveId).find(question => question.id === questionId);
    if (!question) throw new TaskStoreError("rejected", "Unknown question for this objective");
    if (question.answer) throw new TaskStoreError("rejected", `Question already answered by ${question.answer.answeredBy} at ${question.answer.answeredAt}: ${question.answer.text}`);
    const answer = { text, answeredBy: callerName(caller), answeredAt: new Date().toISOString() };
    database.run("INSERT INTO person_answers VALUES(?,?,?,?)", questionId, text, answer.answeredBy, answer.answeredAt);
    recordEvent(database, objectiveId, `person_answer:${questionId}`, "person_answered", answer.answeredAt, { questionId, question: question.text, answer });
    return { ...question, answer };
  });
}
