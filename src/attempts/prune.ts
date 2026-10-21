import { z } from "zod";

/** Legacy reservation and archive formats, read only by import. */
export const reservationSchema = z.strictObject({
  version: z.literal(1), requestId: z.string(), taskId: z.string(), reservedAt: z.iso.datetime(),
});
export const archiveSchema = z.strictObject({
  version: z.literal(1), contextId: z.string(), taskId: z.string(), attempt: z.number().int().positive(),
  archivedAt: z.iso.datetime(), finishedAt: z.iso.datetime(), leaseId: z.string().optional(), pool: z.string().optional(),
  requestId: z.string().optional(), reservation: reservationSchema.optional(),
  summary: z.record(z.string(), z.unknown()),
});
export type ArchivedAttempt = z.infer<typeof archiveSchema>;
