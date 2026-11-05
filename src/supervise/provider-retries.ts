import { z } from "zod";

export const providerRetriesSchema = z.strictObject({
  delaysMs: z.array(z.number().int().positive().max(2_147_483_647)),
});
