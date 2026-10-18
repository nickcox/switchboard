# ADR-0005: Pi RPC subprocess and result-file contract

Status: accepted runtime integration decision. Applies to Phase 1. Real runs have passed through `switchboard dispatch --once`; whole-worker termination remains unverified. Revised on 19 October 2026 to allow operator messages and stop requests while a worker runs.

## Context

Switchboard needs a Pi worker outside its own process, structured outcomes, explicit session identity and conservative handling of uncertain launch or termination. Maintaining a custom Pi extension is not required if standard Pi tools can produce the result. Pi Durable is the intended later orchestration foundation and must remain part of implementation reviews.

## Decision

Launch the standard Pi CLI in a separate Node.js process, in the exact Treehouse-leased directory, using Pi's built-in RPC protocol. The runtime adapter owns the child-process handle and verifies the reported session identity. Do not embed an agent in the Switchboard process. Use an explicit model, session ID and session directory; disable ambient extensions and MCP in the initial worker configuration.

The worker uses Pi's standard write tool to produce one versioned `result.json` at a specified per-attempt location outside the recyclable workspace. Switchboard validates its schema, identity, required evidence entries and work references. A result remains a worker claim, not independent acceptance verification. Missing, malformed, stale or inconsistent results do not imply completion.

Keep immutable input/session bindings and observed process facts in runtime-owned files, alongside Pi-owned session storage. The attempt log refers to these files for each attempt's launch input and observed exit ([ADR-0006](0006-switchboard-attempt-log.md)). These facts support discovery and refusal after dispatcher loss. Do not persist a duplicate task lifecycle, add a queue or implement automatic resume. A retained binding without a confirmed exit observation is unresolved, not an absent worker or permission to launch a replacement.

The worker receives one prompt containing its instruction snapshot. While it runs, only the dispatcher that owns its RPC channel writes to that channel. Stop requests and operator messages reach the owning dispatcher as write-once request files in the attempt's runtime directory, each with a unique ID. The dispatcher forwards each request once, as Pi's `abort`, `steer` or `follow_up`, and records it in the attempt log with who sent it and Pi's response. A request that no running dispatcher forwards is reported as undelivered and is never retried automatically. This keeps the original guarantee against duplicate prompts: no lost acknowledgement can cause a message to be sent twice.

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

At each runtime milestone, record what Pi Durable already supplies, what remains application policy and why any new runtime-owned state or lifecycle code is necessary. Reconsider this decision before adding a persistent runtime service, retries, replay, automatic restart, resumable orchestration, queues or scheduled work. Do not reproduce those features incrementally in this adapter.

The first comparison used Pi Durable 1.3.0. It provides committed task/conversation state, request-ID deduplication, inspection and cancellation, but not an external Pi CLI process manager. Its scheduler can start through submit and wait operations as well as explicit resume. Adopting it would require an explicit host, storage and restart policy and revising Phase 1's exclusion in ADR-0003. Merely replacing this adapter's transport would not establish cross-owner atomicity or safe workspace return.

The second comparison, after the first real Pi runs in October 2026, used the Pi Durable 1.3.0 package itself rather than its documentation:

- Pi Durable is an agent harness that runs conversations inside its host process, not a manager for external Pi CLI processes. It suits the agent supervisor ([ADR-0003](0003-pi-durable-for-durable-orchestration.md)); the worker stays a Pi CLI subprocess.
- `NodeExecutionEnv` stops tracking a command when it finishes, so background processes a finished command started are not cleaned up. It has the same gap as Pi's shell tool and does not solve process ownership.
- Its storage is owned by one process with no locking across processes, so the attempt log stays separate ([ADR-0006](0006-switchboard-attempt-log.md)).
- Since the first comparison this adapter gained the attempt log and, by this revision, forwarded control requests. Neither adds a queue, replay or automatic restart: a request is forwarded once and never replayed.

The next comparison checkpoint is subprocess ownership: assess Pi Durable's execution-environment cleanup alongside the native process-ownership mechanism, rather than assuming either confirms all descendants have terminated.

## Alternatives considered

- **Custom Pi extension:** schema-aware reporting is convenient but adds an agent integration to maintain. Prefer the standard write tool and host-side validation first.
- **Pi Durable now:** a valid alternative if the runtime would otherwise need substantial durable execution machinery. It is not added solely to avoid a small RPC adapter.
- **Herdr:** useful for interactive terminals and operator supervision, but does not directly provide this headless result-file and termination contract.
- **Generic process supervisor:** does not remove task identity, result validation or uncertain-outcome handling. Automatic restart would conflict with Phase 1 refusal semantics unless explicitly constrained.

See [runtime implementation notes](../phases/01-basic-dispatch/runtime-integration.md), [architecture](../architecture.md), [Phase 1](../phases/01-basic-dispatch/PRD.md), and [ADR-0003](0003-pi-durable-for-durable-orchestration.md).
