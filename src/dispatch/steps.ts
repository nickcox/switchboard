import type { DispatchResult } from "./result.ts";

export type OperationStep = { description: string; run: () => Promise<DispatchResult | void> };

/** A plan and a run use the same list. Owners and records, never a saved position, decide which steps remain. */
export async function runSteps(steps: OperationStep[], options: {
  dryRun?: boolean; stopped: (error: unknown, step: string) => DispatchResult;
}): Promise<{ descriptions: string[]; result?: DispatchResult }> {
  const descriptions = steps.map(step => step.description);
  if (options.dryRun) return { descriptions };
  for (const step of steps) {
    try {
      const result = await step.run();
      if (result) return { descriptions, result };
    } catch (error) { return { descriptions, result: options.stopped(error, step.description) }; }
  }
  return { descriptions };
}
