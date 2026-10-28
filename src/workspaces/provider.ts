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
  /** The canonical repository whose refs the workspace shares. */
  backingRepository: string;
  /** The pool the lease was acquired in, as `pool()` identified it. */
  pool: string;
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

export type LeaseIdentity = { leaseId: string; holder: string; path: string };

/**
 * Phase 1 acquires and inspects leases only. `returnLease` exists for the Phase 2 `finish` and `discard` commands, which
 * check every return condition first; nothing else may call it.
 */
export interface WorkspaceProvider {
  /**
   * Returns exactly this lease, refusing if its identity or holder has changed. Uncommitted changes in the workspace
   * make the return fail unless `discardChanges` is set. Confirms the lease is no longer listed.
   */
  returnLease(lease: LeaseIdentity, options: { discardChanges: boolean }): Promise<void>;
  acquire(request: { holder: string; baseRef: string; branch: string }): Promise<Allocation>;
  /** Areas containing every recyclable workspace, including idle workspaces and earlier pools. */
  recyclableRoots(): Promise<string[]>;
  /** Current leases in this context's workspace pool. */
  leases(): Promise<Lease[]>;
  /**
   * Identifies the pool that `leases()` currently lists. A lease acquired under a different identifier is not listed,
   * so whether it is still held is unknown.
   */
  pool(): Promise<string>;
}
