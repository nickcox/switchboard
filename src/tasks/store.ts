/** Provider-independent task-store interface. tasks-axi is the initial implementation (ADR-0001). */

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
};

export type Hold = {
  /** Short reason the store can index; the full reason and work references belong in `body`. */
  reason: string;
  /** Replacement task body: the original instructions and acceptance criteria plus the attempt outcome. */
  body: string;
};

export type TaskStoreFailure =
  /** The store could not be read, so its state is unknown. */
  | "unreadable"
  /** The store refused the change. Nothing was applied. */
  | "rejected"
  /** The command did not report a result. Read the task back before deciding anything. */
  | "outcome_unknown"
  /** The store reported success but reading the task back showed a different state. */
  | "unexpected_state";

export class TaskStoreError extends Error {
  readonly reason: TaskStoreFailure;
  readonly detail: string | undefined;
  constructor(reason: TaskStoreFailure, message: string, detail?: string) {
    super(message);
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Every mutation reads the task back and returns what the store now holds. A mutation whose result is unknown
 * throws `outcome_unknown`; the caller reads the task again rather than repeating the change blindly.
 */
export interface TaskStore {
  /** Ready task IDs in the store's own order, for the configured repository. */
  ready(): Promise<string[]>;
  /** In-flight task IDs for the configured repository. */
  inFlight(): Promise<string[]>;
  /** The task, or undefined when the store has no task with this ID. */
  read(id: string): Promise<Task | undefined>;
  start(id: string): Promise<Task>;
  recordDone(id: string, note: string): Promise<Task>;
  /** Leaves the task queued and held, so it is neither ready nor in flight and its dependants stay blocked. */
  recordHold(id: string, hold: Hold): Promise<Task>;
}
