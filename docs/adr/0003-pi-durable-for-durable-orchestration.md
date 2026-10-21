# ADR-0003: Pi Durable for the supervisor and later durable orchestration

Status: accepted architectural direction; integration deferred to Phase 4 and subject to the acceptance checks below. The original review used Pi Durable 1.3.0 on 18 October 2026; the documentation refresh below identifies its upstream source separately.

## Context

A persistent supervisor, pending messages and schedules introduce coordination facts that cannot be reconstructed solely from Switchboard's tasks and attempts, Treehouse and worker liveness. These needs do not exist in the initial foreground dispatch flow.

Supervision is expected to be done by an agent (see [Supervision](../architecture.md#supervision)). That agent's conversation, pending decisions and promises to the operator must survive a restart.

Pi Durable is an agent harness: a library that runs agent conversations inside the host process. It writes conversations, model turns, tool calls and the host's own typed documents to storage before anything is shown, and runs checkpointed tasks that continue after a crash. It does not manage external Pi CLI processes.

## Decision

Introduce Pi Durable for the Phase 4 agent supervisor, subject to the acceptance checks below. The supervisor is a Pi Durable conversation whose tools call Switchboard's application operations in-process. Pi Durable provides conversation continuity, queued input recovery and explicit interrupted-tool behaviour, not the dispatcher or external worker lifecycle. Do not add it in Phase 1. Phase 1 used the append-only attempt log in ADR-0006; [ADR-0007](0007-one-sqlite-database.md) replaces that storage and tasks-axi with Switchboard's database.

Pi Durable may later persist and execute Switchboard mailbox and scheduling operations, subject to the verification below. Switchboard owns message addressing, delivery and acknowledgement rules, retries, schedule meaning and missed-trigger policy. Pi Durable is the intended implementation mechanism, not the definition of those concepts. Keep its types and API calls within a small integration boundary.

A Pi Durable task represents a resumable operation, such as a delivery. The underlying project work item remains a Switchboard task, stored under ADR-0007.

Do not use Pi Durable as the worker runtime. It would put the worker agent in-process, which [ADR-0005](0005-pi-rpc-worker-and-result-file.md) rejects, and it does not solve worker process ownership (see below).

## Consequences

- Future persistence stores new coordination facts rather than duplicate task, lease or attempt authority.
- **Shared application operations.** The CLI and Durable tool adapters call the same typed application operations, with the same authority and safety enforcement. Operations accept explicit caller context, approval evidence where required and request IDs, and return typed results and refusals. They contain no CLI argument parsing, printing or process-exit behaviour. The CLI handles arguments and presentation; Durable adapters validate model arguments and translate results. Spawning the CLI with `--json` remains a possible transitional integration, not the intended embedded design. This does not require publishing a general-purpose library.
- **Narrow supervisor access.** Register only the tools the supervisor needs. Trusted host code supplies the supervisor's identity and validates operator approval evidence; model arguments cannot claim operator authority. Do not expose direct database writes or unrestricted shell access as a way around application policy. A Pi Durable `beforeTool` hook is an additional guard, not the enforcement.
- **Crashed tool calls.** Pi Durable records a tool call's intent before running it. If the process dies mid-call, a tool declared `replay: "safe"` runs again on restart, and any other tool returns an `interrupted` error to the model. Declare a tool replay-safe only when its application operation is safe to repeat. For `dispatch`, derive or persist the request ID from the durable tool-call identity before invocation and reuse it on every replay; never generate a fresh ID inside each execution. Request-ID deduplication prevents another attempt, but an unresolved reservation may still refuse. Without a request ID, inspect with `status` after interruption rather than dispatching again.
- **Separate storage ownership.** One process must own the supervisor's Durable storage, with exclusive ownership enforced by the host. Switchboard's task and attempt database remains under ADR-0007 and supports its existing multi-process operations; do not open it as competing Durable storage. In-process calls do not make commits in the two stores atomic. Resume supervisor reasoning after a crash, not external workers.
- **Process cleanup is not a solution to process ownership.** `NodeExecutionEnv` starts each command in its own process group and kills tracked groups on `cleanup()`, but stops tracking a command when it finishes. Background processes a finished command left running are not killed.
- **Persisted timing is available upstream.** The source refresh below documents `sleepUntil()`, persisted deadlines and host wake notifications. Evaluate these before adding custom timing for deferred checks, backoffs or schedules. Switchboard still defines recurrence, missed-trigger policy and delivery rules. Durable's timer runs only while its host is running; starting a stopped host remains a host responsibility. These capabilities have not been qualified in Switchboard.
- Pi Durable describes itself as experimental, with API changes between releases. Pin the package and integrity hash, record the reviewed upstream commit, and keep the integration boundary small. A version number alone does not identify the source reviewed.
- External effects still need identity checks, idempotency where available and reconciliation; durable local execution does not make cross-system actions atomic.
- **Storage durability is an adoption condition.** Upstream documents SQLite WAL with `synchronous = NORMAL`, which can lose recent commits on power or host failure, and JSONL with optional `fsync`. Do not assume a stored intent, deduplication record or event acknowledgement survives those failures under defaults. Before integration, specify and verify the supervisor's required durability, including flush behaviour on supported platforms, against ADR-0007's stronger requirements for authoritative records. If the chosen backend cannot meet it, revise the integration rather than claiming equivalent guarantees.

## Event delivery and recovery

The deterministic watcher reads the attempt log in Switchboard's database. Give each supervisor event a stable identity scoped to its context, and derive the Durable submission request ID from it. Persist a delivery cursor and advance it only after Durable confirms durable admission, not merely after the watcher reads the event. A crash between admission and cursor advancement must redeliver the same ID and find the existing submission. An admitted input is not necessarily an answered input; track unresolved or failed submissions and make them visible to the operator.

The Phase 4 PRD must specify cursor ownership, ordered delivery, event retention while delivery is pending, and recovery after either store fails. Neither the cursor protocol nor in-process invocation creates a transaction across both stores. Its guarantees depend on the verified durability of admission and deduplication records.

## Integration acceptance checks

Before adopting Durable in Phase 4, run a small integration trial and record:

- Restart during a model turn, a queued input and a pending decision, with the conversation and outstanding work recovered.
- Crashes before submission admission and after admission but before cursor advancement, proving no event is lost and redelivery does not create duplicate supervisor input.
- A crash after Switchboard accepts dispatch but before Durable records the tool result, proving replay reuses the request ID and does not launch another worker; also verify interrupted non-replay-safe calls lead to inspection.
- Approval enforcement through both the CLI and in-process operations, including rejection of model-supplied operator identity or approval claims.
- One-owner storage exclusion, host restart and shutdown behaviour, surfaced storage failures and parked tasks, and no automatic restart of external workers.
- The chosen backend's process-crash and power/host-failure guarantees, with configuration and evidence distinguished from empirical tests.
- Upgrade and migration recovery, including pending tools and deadlines, with the package integrity hash and upstream commit recorded.

Compare the trial with plain files using the same requirements for conversations, queued inputs, interrupted calls and pending decisions. Do not treat a saved transcript alone as equivalent recovery. No backend or durability setting is selected for Phase 1.

## Source refresh

The [upstream README at commit `02726086d11c2911aa872959e308b90d69182392`](https://github.com/earendil-works/pi/blob/02726086d11c2911aa872959e308b90d69182392/packages/durable/README.md) documents persisted sleep and wake behaviour, tool replay, submission deduplication and storage defaults. Its package still reports version 1.3.0. This is a documentation comparison, not a new package-source qualification or crash-recovery test. It updates the earlier timing assessment without asserting that the previously inspected package had these features.

## Alternatives considered

- **A custom durable orchestration engine** would add storage and recovery machinery before it is needed. Rejected.
- **Treating a Pi Durable conversation inbox as the whole mailbox model** would constrain recipients and semantics to one runtime. Rejected.
- **Pi Durable as the worker runtime:** see the Decision. Rejected for Phase 1 and not planned.

See [architecture](../architecture.md) for the staged roadmap and [runtime implementation notes](../phases/01-basic-dispatch/runtime-integration.md) for the comparison with the Pi RPC worker.
