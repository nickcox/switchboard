# ADR-0003: Pi Durable for the supervisor and later durable orchestration

Status: accepted direction for the Phase 4 supervisor, subject to the acceptance checks below. Earlier adoption for deterministic orchestration is under review through the comparative prototype. The original review used Pi Durable 1.3.0 on 18 October 2026; the documentation refresh below identifies its upstream source separately.

## Context

A persistent supervisor, pending messages and schedules introduce coordination facts that cannot be reconstructed solely from Switchboard's tasks and attempts, Treehouse and worker liveness. These needs do not exist in the initial foreground dispatch flow.

Supervision is expected to be done by an agent (see [Supervision](../architecture.md#supervision)). That agent's conversation, pending decisions and promises to the operator must survive a restart.

Pi Durable is an agent harness: a library that runs agent conversations inside the host process. It writes conversations, model turns, tool calls and the host's own typed documents to storage before anything is shown, and runs checkpointed tasks that continue after a crash. It does not manage external Pi CLI processes.

## Decision

The [comparative orchestration prototype](../phases/03-multiple-workers-and-runtimes/pi-durable-orchestration-prototype.md) reopens the decision to keep Phase 3 execution outside Durable. Durable does not supply an external-worker process adapter, but could coordinate one through checkpointed tasks. The prototype compares total execution and recovery complexity, including a single execution host. Until it concludes, the decision below remains the supervisor direction, not a finding that Durable is unsuitable for earlier deterministic orchestration. No production dependency or worker-policy change is authorised by the investigation.

Introduce Pi Durable for the Phase 4 agent supervisor, subject to the acceptance checks below. The supervisor is a Pi Durable conversation whose tools call Switchboard's application operations in-process. Pi Durable provides conversation continuity, queued input recovery and explicit interrupted-tool behaviour, not the dispatcher or external worker lifecycle. Do not add it in Phase 1. Phase 1 used the append-only attempt log in ADR-0006; [ADR-0007](0007-one-sqlite-database.md) replaces that storage and tasks-axi with Switchboard's database.

Pi Durable may later persist and execute Switchboard mailbox and scheduling operations, subject to the verification below. Switchboard owns message addressing, delivery and acknowledgement rules, retries, schedule meaning and missed-trigger policy. Pi Durable is the intended implementation mechanism, not the definition of those concepts. Keep its types and API calls within a small integration boundary.

A Pi Durable task represents a resumable operation, such as a delivery. The underlying project work item remains a Switchboard task, stored under ADR-0007.

Do not use Pi Durable as the worker runtime. It would put the worker agent in-process, which [ADR-0005](0005-pi-rpc-worker-and-result-file.md) rejects, and it does not solve worker process ownership (see below).

## Consequences

- Future persistence stores new coordination facts rather than duplicate task, lease or attempt authority.
- **Shared application operations.** The supervisor's tools call Switchboard's application operations in-process, as the CLI does, under the rule in the architecture's [One set of application operations](../architecture.md#supervision). A tool checks the model's arguments and turns the operation's result into the tool's result. Starting the CLI with `--json` from a tool would also work as a first step, but is not the intended design. Every operation called in-process must stay asynchronous, because it shares the supervisor's event loop: Switchboard's database access is synchronous, and only its retries while the database is busy wait asynchronously.
- **Narrow supervisor access.** Register only the tools the supervisor needs. The host code, not the model, supplies the supervisor's identity and checks any operator approval, so nothing in a model's arguments can claim the operator's authority. Do not expose direct database writes or unrestricted shell access as a way around application policy. A Pi Durable `beforeTool` hook is an additional guard, not the enforcement.
- **Crashed tool calls.** Pi Durable records a tool call's intent before running it. If the process dies mid-call, a tool declared `replay: "safe"` runs again on restart, and any other tool returns an `interrupted` error to the model. Declare a tool replay-safe only when its application operation is safe to repeat. For `dispatch`, take the request ID from the ID Durable records for the tool call, or store one before the call, and use the same request ID on every replay. Never generate a new one each time the tool runs, or a replay would start a second attempt. The request ID prevents a second attempt, but the replayed call may still be refused while the first attempt's reservation is unresolved. Without a request ID, inspect with `status` after interruption rather than dispatching again.
- **Separate storage ownership.** One process must own the supervisor's Durable storage, with exclusive ownership enforced by the host. Switchboard's task and attempt database remains under ADR-0007 and supports its existing multi-process operations; do not open it as competing Durable storage. In-process calls do not make commits in the two stores atomic. Resume supervisor reasoning after a crash, not external workers.
- **Process cleanup is not a solution to process ownership.** `NodeExecutionEnv` starts each command in its own process group and kills tracked groups on `cleanup()`, but stops tracking a command when it finishes. Background processes a finished command left running are not killed.
- **Timed waits arrived in 1.4.0.** Pi Durable 1.4.0, published on 21 October 2026, adds `runtime.sleepUntil()`, a `sleeping` task status whose deadline survives a restart, and `onWake` for hosts that wake themselves (see [Source refresh](#source-refresh)); 1.3.0 has none of these. They have not been qualified for Switchboard. Evaluate them before Switchboard adds its own timing for deferred checks, backoff or schedules. 1.4.0 also sets aside a task that crashes five times in a row without saving new progress, instead of running it again, and migrates SQLite storage to a schema that earlier versions cannot open; both matter for the recovery and upgrade checks below. Switchboard still defines how often something recurs, what happens to a missed trigger and how deliveries work. A sleep only ends while its host is running; starting a stopped host stays the host's job.
- Pi Durable describes itself as experimental, with API changes between releases. Pin the package version and its integrity hash in the lockfile, record which upstream commit was reviewed, and keep the integration boundary small. A version number alone does not identify the source: upstream changes after 1.3.0 still carry that number.
- External effects still need identity checks, idempotency where available and reconciliation; durable local execution does not make cross-system actions atomic.
- **Storage durability is an adoption condition.** Upstream documents SQLite WAL with `synchronous = NORMAL`, which can lose recent commits on power or host failure, and JSONL with optional `fsync`. Do not assume a stored intent, deduplication record or event acknowledgement survives those failures under defaults. Before integration, specify and verify the supervisor's required durability, including flush behaviour on supported platforms, against ADR-0007's stronger requirements for authoritative records. If the chosen backend cannot meet it, revise the integration rather than claiming equivalent guarantees.

## Event delivery and recovery

The watcher reads new entries from the attempt log in Switchboard's database. Each event it delivers to the supervisor has an ID that never changes and is unique within its context, and that ID is the request ID of the Durable submission. The watcher stores how far it has delivered, and moves that position forward only after Durable reports that it has stored the submission, not when the watcher reads the event. If the watcher crashes after Durable stored a submission but before the position moved, it delivers the same event again, and the request ID finds the existing submission. A stored submission is not an answered one: submissions that are unanswered or failed are tracked and shown to the operator.

The Phase 4 PRD specifies the rest: which process owns the delivery position, the order of delivery, keeping events until they are delivered, and recovery when either store fails. None of this makes a change to both stores a single transaction, and it is only as reliable as Durable's storage of submissions and request IDs.

## Integration acceptance checks

Before adopting Durable in Phase 4, run a small integration trial and record:

- Restart during a model turn, a queued input and a pending decision, with the conversation and outstanding work recovered.
- Crashes before Durable stores a submission, and after it stores one but before the delivery position moves, showing no event is lost and a repeated delivery does not give the supervisor the same input twice.
- A crash after Switchboard accepts dispatch but before Durable records the tool result, proving replay reuses the request ID and does not launch another worker; also verify interrupted non-replay-safe calls lead to inspection.
- Approval enforcement through both the CLI and in-process operations, including rejection of model-supplied operator identity or approval claims.
- Only one process can open the supervisor's storage; how the host restarts and shuts down; that storage failures, and tasks that cannot run because their definition is missing, are reported to the operator; and that no external worker is ever restarted automatically.
- What the chosen storage keeps after a process crash and after a power or host failure, separating what its configuration promises from what tests showed.
- Upgrading Durable with tool calls and deadlines still pending, recording the package's integrity hash and the upstream commit.

Compare the trial with plain files using the same requirements for conversations, queued inputs, interrupted calls and pending decisions. Do not treat a saved transcript alone as equivalent recovery. No backend or durability setting is selected for Phase 1.

## Source refresh

The [upstream README at commit `02726086d11c2911aa872959e308b90d69182392`](https://github.com/earendil-works/pi/blob/02726086d11c2911aa872959e308b90d69182392/packages/durable/README.md) documents persisted sleep and wake behaviour, tool replay, submission deduplication and storage defaults. Its `package.json` still says version 1.3.0, but the published 1.3.0 package, downloaded and inspected on 21 October 2026, contains none of the timed-wait features: neither its README nor its compiled code mentions `sleepUntil`. So the features were unreleased at that point. This is a comparison of documentation, not a qualification of a package or a crash-recovery test. It corrects the earlier view that Pi Durable has no timed waits at all. Pi Durable 1.4.0, published on 21 October 2026 at 22:44 UTC, then released them: its README, type definitions and scheduler contain `sleepUntil` and `onWake`, and its changelog lists them (checked 22 October 2026). The orchestration prototype's baseline (`investigations/durable-orchestration/README.md`) records the same, and pins 1.3.0 until 1.4.0 is qualified.

## Alternatives considered

- **A custom durable orchestration engine** would add storage and recovery machinery before it is needed. Rejected.
- **Treating a Pi Durable conversation inbox as the whole mailbox model** would constrain recipients and semantics to one runtime. Rejected.
- **Pi Durable as the worker runtime:** see the Decision. Rejected for Phase 1 and not planned.

See [architecture](../architecture.md) for the staged roadmap and [runtime implementation notes](../phases/01-basic-dispatch/runtime-integration.md) for the comparison with the Pi RPC worker.
