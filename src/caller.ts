import { userInfo } from "node:os";
import { z } from "zod";

/** Supplied by trusted hosting code, never parsed from operation arguments. */
export const callerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), id: z.string().trim().min(1) }),
  z.strictObject({ kind: z.literal("supervisor"), objectiveId: z.string().regex(/^[a-zA-Z0-9._-]+$/) }),
]);
export type Caller = z.infer<typeof callerSchema>;
export const callerName = (caller: Caller): string => caller.kind === "person" ? caller.id : `supervisor:${caller.objectiveId}`;
export const commandLineCaller = (): Caller => ({ kind: "person", id: `operator:${userInfo().username}` });
