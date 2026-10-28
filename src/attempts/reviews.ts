import { z } from "zod";
import { criteriaReportSchema } from "../runtime/contracts.ts";
import type { AttemptRecord } from "./log.ts";

export const reviewRecordSchema = z.strictObject({
  taskId: z.string().min(1), attempt: z.number().int().positive(),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  verdict: z.enum(["passed", "failed"]), findings: criteriaReportSchema,
});
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;

export function recordedReviews(record: AttemptRecord | undefined, commit: string | undefined): ReviewRecord[] {
  return (record?.entries ?? []).filter(entry => entry.kind === "review_recorded" && entry.data.commit === commit)
    .map(entry => reviewRecordSchema.parse(entry.data));
}

export function describeReviews(reviews: ReviewRecord[] | undefined): string[] {
  return (reviews ?? []).flatMap(review => [
    `Review ${review.taskId} attempt ${review.attempt}: ${review.verdict} for ${review.commit}`,
    ...review.findings.map(finding => `  ${finding.position}. ${finding.criterion}: ${finding.status} – ${finding.evidence}`),
  ]);
}
