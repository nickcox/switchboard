/** Provider-independent workspace interface. Treehouse is the initial implementation (ADR-0002). */

export type Lease = {
  leaseId: string;
  /** The task ID the lease was acquired for. */
  holder: string;
  path: string;
  branch: string | null;
};

export type Allocation = {
  leaseId: string;
  holder: string;
  /** Absolute, canonical workspace path. */
  path: string;
  /** The output branch checked out in the workspace. */
  branch: string;
  /** The commit the workspace started from, read from the workspace itself. */
  startingCommit: string;
};

export type WorkspaceFailure =
  /** Leases could not be listed, so lease state is unknown. */
  | "unreadable"
  /** The provider refused the request and no lease was created. */
  | "rejected"
  /** The request did not report a result. Inspect leases by holder before deciding anything. */
  | "outcome_unknown"
  /** A lease exists but does not match what was requested; preserve it for the operator. */
  | "unexpected_state";

export class WorkspaceError extends Error {
  readonly reason: WorkspaceFailure;
  readonly detail: string | undefined;
  constructor(reason: WorkspaceFailure, message: string, detail?: string) {
    super(message);
    this.reason = reason;
    this.detail = detail;
  }
}

/** Phase 1 acquires and inspects leases only. Returning a lease is left to the operator. */
export interface WorkspaceProvider {
  acquire(request: { holder: string; baseRef: string; branch: string }): Promise<Allocation>;
  /** Current leases in this context's workspace pool. */
  leases(): Promise<Lease[]>;
}
