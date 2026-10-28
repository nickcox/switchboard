# ADR-0005: Pi RPC subprocess and result-file contract

Status: accepted runtime integration decision. Applies to Phase 1. Real runs have passed through `switchboard dispatch --once`; whole-worker termination remains unverified. Revised on 19 October 2026 to allow operator messages and stop requests while a worker runs.

## Context

Switchboard needs a Pi worker outside its own process, structured outcomes, explicit session identity and conservative handling of uncertain launch or termination. Maintaining a custom Pi extension is not required if standard Pi tools can produce the result. Pi Durable is the intended later orchestration foundation and must remain part of implementation reviews.

## Decision

Launch the standard Pi CLI in a separate Node.js process, in the exact Treehouse-leased directory, using Pi's built-in RPC protocol. The runtime adapter owns the child-process handle and verifies the reported session identity. Do not embed a worker agent in the Switchboard process; the separately qualified reasoning supervisor may run in-process under ADR-0003. Use an explicit model, session ID and session directory; disable ambient extensions and MCP in the initial worker configuration.

The worker uses Pi's standard write tool to produce one versioned `result.json` at a specified per-attempt location outside the recyclable workspace. Switchboard validates its schema, identity, required evidence entries and work references. A result remains a worker claim, not independent acceptance verification. Missing, malformed, stale or inconsistent results do not imply completion.

Keep immutable input and session bindings and observed process facts as runtime records in Switchboard's database, beside the attempt they belong to ([ADR-0007](0007-one-sqlite-database.md)); only Pi's session files, the worker's artefacts and its result file stay on disk. These facts support discovery and refusal after dispatcher loss. Do not persist a duplicate task lifecycle, add a queue or implement automatic resume. A retained binding without a confirmed exit observation is unresolved, not an absent worker or permission to launch a replacement.

The worker receives one prompt containing its instruction snapshot. While it runs, only the dispatcher that owns its RPC channel writes to that channel. Stop requests and operator messages reach the owning dispatcher as request records addressed to its claim, each with a unique ID. The dispatcher forwards each request once, as Pi's `abort`, `steer` or `follow_up`, and records it in the attempt log with who sent it and Pi's response. A request that no running dispatcher forwards is reported as undelivered and is never retried automatically. This keeps the original guarantee against duplicate prompts: no lost acknowledgement can cause a message to be sent twice.

Neither Herdr nor a generic process supervisor is required for this first integration. Herdr may later provide operator visibility. Its interactive readiness and completion badges are not task acceptance or termination evidence.

## Consequences

- No custom Pi extension or model-callable result tool is a Phase 1 dependency.
- RPC progress, model settlement, direct-child exit, worker termination and task acceptance are separate facts. The adapter must not equate them.
- Automatic workspace return requires a verified process-ownership strategy covering tool subprocesses, because Pi's shell tool can create detached subprocesses that outlive the Pi child. Until then the adapter reports `workerTermination: unverified` on every path, and Phase 1 finalises on direct-child exit and never returns workspaces ([runtime notes](../phases/01-basic-dispatch/runtime-integration.md#unresolved-process-ownership-gate)).
- An operator message changes the worker's instructions after launch. It is part of the attempt record reviewers see, and does not change the delivery contract or the result requirements.
- Same-lease relaunch is refused even after a completed child-exit observation. A later resume design must define separate semantics.
- Runtime files are not a security sandbox. A worker with the same OS account and filesystem access is not isolated from malicious tampering by filenames or instructions alone.
- Keep OS-specific process control in infrastructure code and verify the equivalent contract separately on macOS, Linux and Windows, following ADR-0004.

## Continuing comparison with Pi Durable

**Comparison complete; narrow supervisor boundary provisionally selected.** The [comparison report](../phases/03-supervisor/pi-durable-orchestration-report.md) and scripted supervisor trials support Durable for reasoning continuity, not per-attempt deterministic workflows. The fifth comparison below supersedes the fourth comparison's pending execution choice, not its worker safety requirements. Production adoption remains conditional on [ADR-0003](0003-pi-durable-for-durable-orchestration.md#integration-acceptance-checks). The revised Phase 3 PRD moves the supervisor into Phase 3; that changes phase scope, not this ownership boundary. **Revised on 28 October 2026 (under review):** the Phase 3 supervisor does not use Pi Durable; it is a general-purpose agent whose state is rebuilt from Switchboard's records ([ADR-0003](0003-pi-durable-for-durable-orchestration.md#phase-3-revision)).

The comparisons below are findings about the package and scope inspected at the time, not about every upstream revision numbered 1.3.0. [ADR-0003's source refresh](0003-pi-durable-for-durable-orchestration.md#source-refresh) records timed waits that survive a restart, which 1.3.0 does not have and Pi Durable 1.4.0, published on 21 October 2026, does. Phase 3's scope is unchanged; compare again before Switchboard stores any timing, and qualify a released package before relying on those features.

At each runtime milestone, record what Pi Durable already supplies, what remains application policy and why any new runtime-owned state or lifecycle code is necessary. Reconsider this decision before adding a persistent runtime service, retries, replay, automatic restart, resumable orchestration, queues or scheduled work. Do not reproduce those features incrementally in this adapter.

The first comparison used Pi Durable 1.3.0. It provides committed task/conversation state, request-ID deduplication, inspection and cancellation, but not an external Pi CLI process manager. Its scheduler can start through submit and wait operations as well as explicit resume. Adopting it would require an explicit host, storage and restart policy and revising Phase 1's exclusion in ADR-0003. Merely replacing this adapter's transport would not establish cross-owner atomicity or safe workspace return.

The second comparison, after the first real Pi runs in October 2026, used the Pi Durable 1.3.0 package itself rather than its documentation:

- Pi Durable is an agent harness that runs conversations inside its host process, not a manager for external Pi CLI processes. It suits the agent supervisor ([ADR-0003](0003-pi-durable-for-durable-orchestration.md)); the worker stays a Pi CLI subprocess.
- `NodeExecutionEnv` stops tracking a command when it finishes, so background processes a finished command started are not cleaned up. It has the same gap as Pi's shell tool and does not solve process ownership.
- Its storage is owned by one process with no locking across processes, so the attempt log stays separate ([ADR-0006](0006-switchboard-attempt-log.md)).
- Since the first comparison this adapter gained the attempt log and, by this revision, forwarded control requests. Neither adds a queue, replay or automatic restart: a request is forwarded once and never replayed.

The third comparison, on 20 October 2026, was made before implementing the [Phase 2 PRD](../phases/02-reconciliation-and-recovery/PRD.md), as that PRD requires:

- Phase 2 classifies each attempt's state by reading the attempt log and each owner's current state, and adds operator commands to finish, discard and prune attempts. None of it runs in the background, retries, replays or starts work without an operator command.
- `finish` can be run again after a failure, but it does so by reading each owner's state and doing the steps not yet done, as the Phase 1 hold update already does. That is not a replay journal: nothing is re-executed from a record of past steps.
- The new attempt-log entries record facts about each attempt, such as an integration or a returned lease. They are not a task queue or checkpointed execution state, which is what Pi Durable would supply.
- Starting a new attempt automatically after a temporary error, the one candidate that would have started work without an operator command, is deferred to the Phase 4 supervisor.

So Phase 2 gives no reason to adopt Pi Durable. The next checkpoints are the Phase 3 background dispatcher, a long-running process that owns workers, and the Phase 4 supervisor, which ADR-0003 already assigns to Pi Durable. Subprocess ownership, the checkpoint named in the second comparison, is deferred together with automatic lease return.

The fourth comparison, on 21 October 2026, was made before writing the Phase 3 PRD, against the candidate scope in the [architecture](../architecture.md#roadmap): a background dispatcher that owns workers, several attempts at once up to a configured maximum, a second runtime, and a finalisation policy that opens and watches pull requests. Pi Durable is still at 1.3.0, the version the earlier comparisons used, so this comparison is about what Phase 3 would add, not about changes to Pi Durable:

- **Background dispatcher.** Pi Durable is a library that runs inside a host process. It does not provide the host: starting it when a command first needs it, letting clients attach and detach, or owning external processes. Switchboard would write that process either way. If the dispatcher restarts, a worker it started cannot be resumed from a checkpoint, because running the worker again would send its prompt a second time. Pi Durable would treat such a step as not safe to replay and report it as interrupted, which is the state Phase 2 already derives from the attempt log and each owner (possibly running, or unfinished). The dispatcher must not restart workers itself after its own restart.
- **Several attempts at once.** The maximum must hold across processes, because `dispatch --once` from the command line and the background dispatcher could both start work. Pi Durable has no limit on how many tasks run at once, and its storage belongs to one process with no locking across processes, so it cannot enforce the maximum. The dispatcher lock or exclusive slot files proposed under [Parallel attempts](../architecture.md#notes-for-later-phases) remain Switchboard's.
- **Second runtime.** An ACP agent is an external process, like the Pi worker. Pi Durable runs agents in its own process and does not manage external ones, so it has no part in the runtime adapter. `@earendil-works/pi-env` 1.3.0, published with it, runs the tools of an agent that Pi Durable hosts on another machine over SSH. It does not manage Pi CLI or ACP processes either.
- **Watching pull requests.** A pull-request policy keeps the task held until the pull request is merged, so something must notice the merge. Pi Durable 1.3.0 has no timed waits, so noticing the merge on a schedule would need Switchboard's own timing. 1.4.0 adds them (see the note above), and they should be evaluated if Switchboard ever stores when to check a pull request. Reading the pull request's state as another owner, each time `status` or the background dispatcher classifies attempts, needs no new stored state: the forge holds the pull request, and the attempt log would record the facts about it.
- **Queue.** A background dispatcher that starts the next task when a slot is free needs no queue of its own: tasks-axi's ready list is the order of work, as in Phase 1. A queue held by Switchboard, for example of dispatch requests waiting for a slot, would be the first new state of the kind Pi Durable supplies.

So Phase 3, as scoped, gives no reason to adopt Pi Durable, provided its PRD keeps to the following: no queue of Switchboard's own, no automatic restart of workers or retry of attempts, a cross-process maximum held in files, and whether a pull request has merged read from GitHub each time an attempt's state is worked out, with no stored schedule of when to check it. If the PRD needs to break any of these limits, compare again before implementing that part. The Phase 4 supervisor remains where Pi Durable is expected to be adopted.

[ADR-0007](0007-one-sqlite-database.md), accepted the same day, moves tasks and Switchboard's records into one SQLite database. The Phase 3 PRD restates the first and third limits for it: the ready order of project tasks in the database is the order of work, not a queue of dispatch requests, and the maximum is enforced by transactions in the database. Neither adds state of the kind Pi Durable supplies.

### Fifth comparison: provisionally selected supervisor boundary

The comparative A/B investigation qualified released Durable **1.4.0**, then added classified-read recovery, caller-configured SQLite and three scripted supervisor trial stages. The [investigation record](../../investigations/durable-orchestration/README.md) retains package provenance, process boundaries, real-run limitations and test results; the current supervisor evidence is committed through `8698084`.

- **Select the narrow boundary provisionally.** Durable stores supervisor conversation, queued inputs and interrupted reasoning/tool work. Switchboard retains shared attempt operations, position-free finalisation, request reservations, launch fences, worker claims and current authority checks. No per-attempt Durable task or second dispatch queue is selected. Reconsider full B if future requirements demonstrate a material coordination reduction; raw prototype line counts do not establish that reduction.
- **Do not reject B for limitations the follow-ups removed.** Its real-run terminal owner-read failure was a classification choice, not an inherent engine limit. Classified reads now recover through existing persisted waits. Released 1.4.0 accepts a caller-configured FULL/fullfsync connection. General operator reconciliation, a new real B completion run and storage/platform qualification remain unproven.
- **Keep worker boundaries unchanged.** A restarted conversation is not worker adoption, permission to relaunch or evidence of termination. Model tool-call replay reuses a stable application request ID; unsafe interrupted calls require inspection. A separately authorised new attempt from retained output needs a new operation/identity and handover, not replay of the old worker. Neither prototype implements that production feature.
- **Treat scripted evidence as bounded.** Sixteen supervisor scenarios repeated three times preserve stable dispatch/event identity and fresh approval checks with fake owners. They do not prove real-model reasoning, objective completion, pending-call upgrades, power-loss durability or superiority over plain-note reconstruction.

This records an ownership decision only. The revised Phase 3 PRD (28 October 2026) moves the supervisor into Phase 3 and restates the fourth comparison's limits, with the second changed: a new attempt is started only when a person or the supervisor asks for it. The next real-model trial needs separate approval of its scope and budget. No production dependency, automatic worker recovery or lease-return policy is authorised by this comparison.

## Alternatives considered

- **Custom Pi extension:** schema-aware reporting is convenient but adds an agent integration to maintain. Prefer the standard write tool and host-side validation first.
- **Pi Durable now:** a valid alternative if the runtime would otherwise need substantial durable execution machinery. It is not added solely to avoid a small RPC adapter.
- **Herdr:** useful for interactive terminals and operator supervision, but does not directly provide this headless result-file and termination contract.
- **Generic process supervisor:** does not remove task identity, result validation or uncertain-outcome handling. Automatic restart would conflict with Phase 1 refusal semantics unless explicitly constrained.

See [runtime implementation notes](../phases/01-basic-dispatch/runtime-integration.md), [architecture](../architecture.md), [Phase 1](../phases/01-basic-dispatch/PRD.md), and [ADR-0003](0003-pi-durable-for-durable-orchestration.md).
