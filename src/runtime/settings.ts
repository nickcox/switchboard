import { isAbsolute } from "node:path";
import { z } from "zod";

export const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
const nonempty = z.string().min(1);
/** The non-secret runtime profile. Credentials and the environment are never part of an attempt specification. */
export const runtimeSettingsSchema = z.strictObject({
  profile: z.literal("pi"), executable: nonempty.refine(isAbsolute), entrypoint: nonempty.refine(isAbsolute).optional(),
  provider: nonempty.refine(value => !value.startsWith("-")), model: nonempty.refine(value => !value.startsWith("-")), thinking: thinkingLevelSchema.optional(),
  shellTool: z.enum(["bash", "powershell"]),
  runMs: z.number().int().positive(), requestMs: z.number().int().positive(), stopMs: z.number().int().min(100),
  statsMs: z.number().int().positive(), requestPollMs: z.number().int().positive(),
  maxCost: z.number().positive().optional(), maxTokens: z.number().int().positive().optional(),
});
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
