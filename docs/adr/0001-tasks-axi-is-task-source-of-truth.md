# ADR-0001: tasks-axi is the task source of truth

Status: superseded by [ADR-0007](0007-one-sqlite-database.md) on 21 October 2026, which moves tasks into Switchboard's own database with the same readiness rules. Describes the design through Phase 2.

## Context

Switchboard needs to select ready work and record its outcome. Duplicating task status or dependency evaluation in an orchestration store would create competing answers about what can run.

## Decision

tasks-axi is the initial task-store provider and is authoritative for work items, dependencies, readiness and task status. Switchboard accesses it through a task-store interface, queries its ready-work interface and uses its supported status transitions. The Switchboard interface may adopt tasks-axi's task model where appropriate; commands, transport formats and implementation-specific types remain inside the adapter. A future provider must satisfy the same authority, readiness and identity contracts. Switchboard may choose among ready tasks but must not implement a separate readiness calculation.

The tasks-axi task ID is the stable correlation key across leases, runtime metadata and logs. Switchboard does not create a second project-task model. Future Pi Durable computational tasks represent orchestration operations, not project work items.

## Consequences

- Phase 1 needs no Switchboard task database.
- Dispatch stops when tasks-axi state cannot be read or a required transition cannot be confirmed.
- Adapter code must document the actual status/command mapping and preserve the original task ID.
- Resolve and validate the authoritative store explicitly; every adapter operation addresses it independently of the worker's working directory. A workspace copy is not a second live task store.
- Workers report results to Switchboard; Switchboard applies orchestration transitions through tasks-axi.
- Mark done only when the agreed completion contract is satisfied. Worker completion alone cannot unblock dependent tasks when required review or integration remains; record hold with work references and the next action instead.
- Task state alone cannot establish whether a worker or workspace still exists.

## Alternatives considered

A Switchboard task database would duplicate authority and require synchronisation. Using Pi Durable tasks as project tasks would couple work tracking to an execution mechanism. Both are rejected.

See [architecture](../architecture.md) and [Phase 1](../phases/01-basic-dispatch/PRD.md).
