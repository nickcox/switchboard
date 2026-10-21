/** Task-store boundary. SQLite is the implementation (ADR-0007). */

export type TaskState = "queued" | "in_flight" | "done";

export type Task = {
  id: string;
  title: string;
  state: TaskState;
  repo: string | null;
  /** The task's kind, which selects its delivery contract. Null when no kind is set. */
  kind: string | null;
  blocked: boolean;
  held: boolean;
  holdReason: string | null;
  body: string;
  /** Used to compare a finalisation plan with later operator holds. */
  holdRevision?: number;
};

export type TaskStoreFailure =
  /** The store could not be read, so its state is unknown. */
  | "unreadable"
  | "busy"
  /** The store refused the change. Nothing was applied. */
  | "rejected";

export class TaskStoreError extends Error {
  readonly reason: TaskStoreFailure;
  readonly detail: string | undefined;
  constructor(reason: TaskStoreFailure, message: string, detail?: string) {
    super(message);
    this.reason = reason;
    this.detail = detail;
  }
}

/** Dispatch reads tasks here; task start and outcomes belong to the transactional attempt store. */
export interface TaskStore {
  /** Ready task IDs in the store's own order, for the configured repository. */
  ready(): Promise<string[]>;
  /** In-flight task IDs for the configured repository. */
  inFlight(): Promise<string[]>;
  /** The task, or undefined when the store has no task with this ID. */
  read(id: string): Promise<Task | undefined>;
}
