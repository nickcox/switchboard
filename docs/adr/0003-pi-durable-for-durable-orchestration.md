# ADR-0003: Pi Durable for the supervisor and later durable orchestration

Status: accepted architectural direction; integration deferred beyond Phase 1. Reviewed against Pi Durable 1.3.0 on 18 October 2026.

## Context

A persistent supervisor, pending messages and schedules introduce coordination facts that cannot be reconstructed solely from tasks-axi, Treehouse, worker liveness and the attempt log. These needs do not exist in the initial foreground dispatch flow.

Supervision is expected to be done by an agent (see [Supervision](../architecture.md#supervision)). That agent's conversation, pending decisions and promises to the operator must survive a restart.

Pi Durable is an agent harness: a library that runs agent conversations inside the host process. It writes conversations, model turns, tool calls and the host's own typed documents to storage before anything is shown, and runs checkpointed tasks that continue after a crash. It does not manage external Pi CLI processes.

## Decision

Introduce Pi Durable when durable supervisor state is required. The supervisor is a Pi Durable conversation whose tools call Switchboard's operations through their structured interface. Pi Durable then provides the supervisor's continuity. Do not add it in Phase 1. Phase 1's only Switchboard state is the append-only attempt log in [ADR-0006](0006-switchboard-attempt-log.md).

Pi Durable may later persist and execute Switchboard mailbox and scheduling operations, subject to the verification below. Switchboard owns message addressing, delivery and acknowledgement rules, retries, schedule meaning and missed-trigger policy. Pi Durable is the intended implementation mechanism, not the definition of those concepts. Keep its types and API calls within a small integration boundary.

A Pi Durable task represents a resumable operation, such as a delivery. The underlying work item remains a tasks-axi task.

Do not use Pi Durable as the worker runtime. It would put the worker agent in-process, which [ADR-0005](0005-pi-rpc-worker-and-result-file.md) rejects, and it does not solve worker process ownership (see below).

## Consequences

- Future persistence stores new coordination facts rather than duplicate task, lease or attempt authority.
- Supervisor tools invoke the same Switchboard operations and policies used by operators. Authority is enforced by Switchboard. A Pi Durable `beforeTool` hook can block a call or ask the operator inside the supervisor, but it is an additional layer, not the enforcement.
- **Crashed tool calls.** Pi Durable records a tool call's intent before running it. If the process dies mid-call, a tool declared `replay: "safe"` runs again on restart, and any other tool returns an `interrupted` error to the model. A Switchboard tool may be declared replay-safe only when the operation it calls is safe to repeat. `dispatch` is made safe to repeat by its request ID (see the [Phase 1 operator interface](../phases/01-basic-dispatch/PRD.md#operator-interface)); without one, the supervisor must inspect with `status` after an interruption.
- **Storage is owned by one process.** Pi Durable storage has no locking across processes, so the supervisor's storage cannot also hold the dispatcher's attempt log. The attempt log stays separate.
- **Process cleanup is not a solution to process ownership.** `NodeExecutionEnv` starts each command in its own process group and kills tracked groups on `cleanup()`, but stops tracking a command when it finishes. Background processes a finished command left running are not killed.
- **Schedules are unverified.** Pi Durable 1.3.0's scheduler runs pending tasks; no feature for running work at a given time was found in its README or built code. Scheduled triggers may need Switchboard's own timing, with Pi Durable tasks waiting on it.
- Pi Durable describes itself as experimental, with API changes between releases. Pin the version and keep the integration boundary small.
- External effects still need identity checks, idempotency where available and reconciliation; durable local execution does not make cross-system actions atomic.
- At integration time, verify the selected Pi Durable version, restart guarantees, storage ownership and migration behaviour. SQLite and JSONL are both available; compare them with keeping supervisor state in plain files. No backend or durability setting is specified for Phase 1.

## Alternatives considered

- **A custom durable orchestration engine** would add storage and recovery machinery before it is needed. Rejected.
- **Treating a Pi Durable conversation inbox as the whole mailbox model** would constrain recipients and semantics to one runtime. Rejected.
- **Pi Durable as the worker runtime:** see the Decision. Rejected for Phase 1 and not planned.

See [architecture](../architecture.md) for the staged roadmap and [runtime implementation notes](../phases/01-basic-dispatch/runtime-integration.md) for the comparison with the Pi RPC worker.
