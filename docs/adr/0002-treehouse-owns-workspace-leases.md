# ADR-0002: Treehouse owns workspace leases

Status: accepted architecture decision. Applies from Phase 1.

## Context

A worktree path alone does not express durable ownership of a task workspace. The earlier runtime-managed-worktree approach also tied isolation to a particular worker launcher.

## Decision

Treehouse is the initial workspace provider and owns workspace creation, allocation and durable leases. Switchboard accesses it through a workspace-provider interface. That interface may adopt Treehouse's lease model where appropriate; commands, transport formats and implementation-specific types remain inside the adapter. A future provider must satisfy the same durable ownership, identity and safe-return contracts.

Switchboard requests a lease with `lease_holder` equal to the unchanged tasks-axi task ID. The returned `lease_id` identifies the allocation/attempt; the returned workspace path is the worker's working directory.

Switchboard decides when a lease may be returned, but performs allocation and return through Treehouse. Runtime adapters launch and observe workers; they do not independently allocate or delete workspaces. Herdr remains an optional runtime implementation.

## Consequences

- Workspace ownership survives the dispatcher process independently of Switchboard storage.
- Task ID, lease ID and runtime session ID must remain correlated.
- A lease is not evidence of worker liveness or task completion.
- Hold, failure and uncertain outcomes preserve the lease by default. Return requires confirmed worker termination and safe retention of work.
- Phase 1 preserves every lease and leaves return to the operator, because confirmed termination of every worker process is not yet verified. Automatic return is deferred until it is.
- Lease return is potentially destructive workspace recycling, not merely releasing a reservation. Verify retention of the exact result commit and required artefacts before returning the expected allocation using lease-identity preconditions. A clean working tree or the existence of a named branch alone is insufficient.
- Phase 1 normally retains committed code on a named local attempt branch. This protects against workspace recycling, not loss of the backing repository; it neither publishes nor integrates the work.
- Phase 1 does not automatically resume a preserved lease or start another worker for the same task.

## Alternatives considered

Runtime-managed worktrees would make durable allocation depend on the launcher. Switchboard-managed worktrees and lease records would duplicate Treehouse. Neither is selected.

See [architecture](../architecture.md) and the [Phase 1 lease policy](../phases/01-basic-dispatch/PRD.md#outcomes-and-lease-policy).
