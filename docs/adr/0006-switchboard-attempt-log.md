# ADR-0006: Switchboard keeps an append-only attempt log

Status: superseded by [ADR-0007](0007-one-sqlite-database.md) on 21 October 2026, which keeps the attempt log's meaning but stores it in Switchboard's database instead of files. Describes the design through Phase 2.

## Context

Each dispatch attempt involves a task in tasks-axi, a lease in Treehouse and a session in the runtime. Each owner holds its own state, but none records which task, lease, session, commits and outcome belong to the same attempt. Without that record, a fresh invocation after a dispatcher crash cannot tell which preserved lease or held task came from which attempt, and the worker's result and retention check exist only in the run report.

The earlier rule "Phase 1 has no Switchboard database" pushed this information into runtime-owned files and free-text task notes. Phase 1 also now preserves every lease (see the [Phase 1 PRD](../phases/01-basic-dispatch/PRD.md#objective-and-scope)), so a record of each attempt is needed to tell the operator what each preserved lease contains.

## Decision

Switchboard keeps an append-only attempt log under the configured runtime root, outside every workspace. An attempt is one launch of one worker for one task in one lease. Its record contains the context, task ID, any caller request ID, lease ID, session ID, delivery contract, starting commit and, when known, result commit, worker outcome, recorded task outcome and retention-check result.

The record is created before the lease is acquired, and later observations are appended as they are confirmed. A repeated request ID finds the existing attempt instead of creating another. Earlier entries are never edited or deleted. The runtime-owned input binding and child-exit records from [ADR-0005](0005-pi-rpc-worker-and-result-file.md) hold the attempt's launch input and observed exit; the log refers to them by lease ID, session ID and runtime directory rather than copying them.

The log is not authoritative for task state, lease state or worker liveness. Each of those is still read from its owner. The log records which owner state belongs to which attempt.

## Consequences

- This is the only persistent state Switchboard keeps in Phase 1. It follows [principle 3](../principles.md): an attempt is a fact no existing owner holds.
- Each task's attempts are numbered, and each attempt's first entry is created with exclusive file creation before the lease is acquired. Creation names the latest attempt the caller has already inspected and fails if any other attempt is now the latest. Two invocations at once cannot dispatch the same task, whatever their timing. Phase 1 relies on this instead of a host-wide dispatcher lock.
- After a crash, the next invocation finds unresolved attempts in the log and reads their state from each owner. It still does not resume or repair them automatically.
- An attempt whose worker may still be running blocks all dispatch. An attempt whose worker has stopped blocks only its own task until the operator resolves it.
- The log does not hold a task lifecycle, a queue, retry state or schedules. Adding any of those needs a separate decision, and [ADR-0003](0003-pi-durable-for-durable-orchestration.md) requires reconsidering Pi Durable first.
- The file format, location and write-durability guarantees are documented in the [attempt log format](../phases/01-basic-dispatch/attempt-log.md). Like the runtime records, the log is not protected from a malicious worker running as the same OS user.

## Alternatives considered

- **No Switchboard state:** keeps the persistence boundary minimal, but splits each attempt's record across three owners and free-text notes, and leaves crash recovery depending on the operator matching them by hand.
- **A Switchboard database holding task and lease state:** would duplicate the authority of tasks-axi and Treehouse. Rejected, as in [ADR-0001](0001-tasks-axi-is-task-source-of-truth.md) and [ADR-0002](0002-treehouse-owns-workspace-leases.md).
- **Pi Durable now:** provides committed state, but brings a scheduler and replay machinery Phase 1 does not need. An append-only record of attempts is a much smaller commitment.

See [architecture](../architecture.md) and [Phase 1](../phases/01-basic-dispatch/PRD.md#attempt-log).
