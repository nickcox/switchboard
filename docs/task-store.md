# Task-store contract

Status: agreed on 21 October 2026 with [ADR-0007](adr/0007-one-sqlite-database.md); not yet implemented.

Switchboard owns its tasks from ADR-0007 onwards. tasks-axi applied some of these rules implicitly, and some cases it never had to decide, so this contract states every rule the task store must implement and its tests must cover. Readiness is unchanged from tasks-axi.

## Identity

- A task ID is chosen by whoever adds the task, and must be slug-shaped, as tasks-axi requires: letters, digits, `.`, `_` and `-`, with no spaces. It is unique within the database. Tasks are never deleted, so an ID is never reused.
- Task IDs are not scoped to a context: one database's tasks are shared by every context that uses it, and each context selects tasks by repository, as it did with a shared tasks-axi backlog.
- A request ID is unique within a context. The same request ID may be used in two contexts.

## States and holds

- A task is `queued`, `in_flight` or `done`. A hold is separate from the state: a held task keeps its state and has a hold reason.
- A hold reason is one line of at most 200 characters, as now.
- Only dispatch marks a task `in_flight`, after acquiring its lease and in the same transaction that records `task_started`. The operator's commands never do.

## Dependencies

- A task can be blocked by other tasks. A dependency on the task itself, on a task that does not exist, or one that would create a cycle, is refused, and nothing changes.
- The import drops a dependency on a task that does not exist and reports it. tasks-axi treats such a blocker as done, so readiness is the same with or without it.

## Readiness and order

- A task is ready when it is `queued`, not held, and every task it is blocked by is `done`.
- Every task has a position, unique within the database. A new task goes after every existing task. Ready tasks are listed, and taken by dispatch, in order of position, filtered by repository.
- Readiness is checked when an attempt is created and again when its task is started. It is never re-checked for an attempt that has started: holding the task, adding a dependency or changing its instructions takes effect at the next dispatch, not on a running attempt.
- Reopening a task that others are blocked by makes them blocked again from then on. A dependant that has already started or finished is unaffected.

## Changes during an attempt

- The operator can change any task at any time, including while an attempt runs, for example to hold it, record it as done, or change its body.
- Recording an attempt's outcome changes the task only if it is still `in_flight` and has not been held since the attempt started it, in the same transaction as the outcome's log entry. If the operator has changed the task's state or held it in the meantime, the outcome is still recorded in the attempt log, the task is left as the operator set it, and `status` reports the disagreement. Finalisation never overwrites a newer operator decision.
- `finish` and `discard` record a task as done or held only after checking, in the same transaction, that it is in the state the command expected.

## Commands

The `switchboard task` commands (add, show, list, ready, update, hold, release, block, unblock, done, reopen) apply these rules. Each change is one transaction, each command takes `--json`, and a refusal changes nothing and gives a stable reason code.
