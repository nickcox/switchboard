import type { Outcome } from "../scenario/contract.ts";

export type Step = {
  description: string;
  happened(): boolean;
  run(): Promise<Outcome | null>;
};

// There is no saved cursor or replay. Each invocation plans from domain facts and checks owners
// inside the action. An uncertain external effect stops the list instead of retrying its action.
export async function runSteps(steps: Step[]): Promise<Outcome | null> {
  for (const step of steps) {
    if (step.happened()) continue;
    const stopped = await step.run();
    if (stopped) return stopped;
  }
  return null;
}
