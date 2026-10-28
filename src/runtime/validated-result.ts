import { z } from "zod";
import { sameIdentity, validateWorkerResult, workerResultSchema } from "./contracts.ts";
import { readJsonDocument, type RuntimeBinding, type RuntimeRecord } from "./records.ts";

export const validatedResultSchema = z.strictObject({
  validationVersion: z.literal(1), validatedAt: z.iso.datetime(), sourcePath: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/), content: workerResultSchema,
});
export type ValidatedResult = z.infer<typeof validatedResultSchema>;

export function parseValidatedResult(value: unknown, binding: RuntimeBinding): ValidatedResult {
  const record = validatedResultSchema.parse(value);
  if (!sameIdentity(record.content.identity, binding.input.identity) || record.sourcePath !== binding.resultPath) {
    throw new Error("Recorded result does not match this worker");
  }
  return record;
}

/** First validation wins, including when two finish commands upgrade an older attempt at once. */
export async function recordValidatedResult(record: Pick<RuntimeRecord, "storage" | "directory" | "binding">): Promise<ValidatedResult> {
  const existing = await record.storage.observation(record.directory, "validated_result");
  if (existing !== undefined) return parseValidatedResult(existing, record.binding);
  const validated = await validateResultFile(record.binding);
  return parseValidatedResult(await record.storage.recordValidatedResult(record.directory, validated), record.binding);
}

export async function validateResultFile(binding: RuntimeBinding): Promise<ValidatedResult> {
  const source = await readJsonDocument(binding.resultPath);
  const content = validateWorkerResult(source.value, binding.input);
  return validatedResultSchema.parse({ validationVersion: 1, validatedAt: new Date().toISOString(),
    sourcePath: binding.resultPath, digest: source.digest, content });
}

/** The file is diagnostic only after validation. Missing or unreadable files cannot replace the record either. */
export async function resultDiscrepancy(record: ValidatedResult): Promise<string | undefined> {
  try {
    const source = await readJsonDocument(record.sourcePath);
    return source.digest === record.digest ? undefined : "The worker's result file differs from the recorded result; the recorded result is used";
  } catch (error) {
    return `The worker's result file cannot be compared with the recorded result: ${error instanceof Error ? error.message : String(error)}; the recorded result is used`;
  }
}
