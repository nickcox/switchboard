import { TaskStoreError } from "../tasks/store.ts";

export class ObjectiveNotOpenError extends TaskStoreError {
  readonly code = "objective_not_open";
  readonly state: "completed" | "abandoned";

  constructor(state: "completed" | "abandoned", detail: string) {
    super("rejected", detail);
    this.state = state;
  }
}

export function requireOpenObjective(state: unknown, detail: string): void {
  if (state === "open") return;
  if (state === "completed" || state === "abandoned") throw new ObjectiveNotOpenError(state, detail);
  throw new TaskStoreError("rejected", detail);
}
