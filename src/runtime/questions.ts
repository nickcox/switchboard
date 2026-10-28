import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isMissing, readJsonFile, writeOnce, type RuntimeRecord } from "./records.ts";
import { questionDocumentSchema, QuestionStore, type Question } from "./questions-store.ts";

export const maxQuestionBytes = 32 * 1024;
export const questionFilename = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.question\.json$/;
export const questionsDirectory = (directory: string): string => join(directory, "questions");
export const answerFilename = (filename: string): string => filename.replace(/\.question\.json$/, ".answer.json");

async function checkDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw new Error("Unsafe questions directory");
}

/** A published file is immutable input: neither editing it nor replacing it creates another question. */
export async function pollQuestions(record: RuntimeRecord, onRecorded?: (text: string) => void): Promise<void> {
  const directory = questionsDirectory(record.directory);
  try { await checkDirectory(directory); }
  catch (error) { if (isMissing(error)) return; throw error; }
  const store = record.storage.questions;
  const identity = record.binding.input.identity;
  const attempt = await record.storage.attempt(identity.contextId, identity.leaseId);
  const existing = await store.list({ contextId: identity.contextId, taskId: identity.taskId, attempt: attempt.attempt });
  const seen = new Set([...existing.questions, ...existing.invalid].map(file => file.filename));
  const files = await opendir(directory);
  for await (const file of files) {
    if (!file.name.endsWith(".question.json") || seen.has(file.name)) continue;
    let document;
    try {
      if (!questionFilename.test(file.name)) throw new Error("Invalid question filename");
      document = questionDocumentSchema.parse(await readJsonFile(join(directory, file.name), maxQuestionBytes));
    } catch (error) {
      const diagnostic = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      await store.record(record.directory, file.name, { diagnostic });
      onRecorded?.(`Invalid question file ${file.name}: ${diagnostic}`);
      continue;
    }
    await store.record(record.directory, file.name, { document });
    onRecorded?.(`Question from worker (${file.name}${document.waiting ? "; waiting" : ""}): ${document.text}`);
  }
}

/** The database is authoritative. A failed file delivery never removes the answer or permits a second answer. */
export async function writeAnswerFile(store: QuestionStore, directory: string, question: Question): Promise<void> {
  const answer = question.answer!;
  try {
    if (!questionFilename.test(question.filename)) throw new Error("Invalid question filename");
    const path = questionsDirectory(directory);
    await checkDirectory(path);
    await writeOnce(join(path, answerFilename(question.filename)), {
      questionId: question.id, question: question.text, answer: answer.text,
      answeredBy: answer.answeredBy, answeredAt: answer.answeredAt,
    });
    await store.fileDelivery(question.id, "written");
  } catch (error) {
    await store.fileDelivery(question.id, "failed", (error instanceof Error ? error.message : String(error)).slice(0, 2000));
  }
}

export function describeQuestions(questions: Question[]): string[] {
  return questions.flatMap(question => [
    `Question ${question.id} (${question.answer ? "answered" : "open"}${question.waiting ? ", waiting" : ""}; ${question.filename}): ${question.text}`,
    ...(question.choices ? [`Choices: ${question.choices.join("; ")}`] : []),
    ...(question.answer ? [`Answer by ${question.answer.answeredBy}: ${question.answer.text}`,
      ...question.answer.deliveries.map(delivery => `Answer ${delivery.channel}: ${delivery.outcome}${delivery.error ? ` – ${delivery.error}` : ""}`)] : []),
  ]);
}
