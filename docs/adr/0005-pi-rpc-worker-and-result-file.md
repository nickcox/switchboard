# ADR-0005: Pi RPC subprocess and result-file contract

Status: accepted initial runtime integration decision. Applies to Phase 1; full runtime acceptance remains unverified.

## Context

Switchboard needs a Pi worker outside its own process, structured outcomes, explicit session identity and conservative handling of uncertain launch or termination. Maintaining a custom Pi extension is not required if standard Pi tools can produce the result. Pi Durable is the intended later orchestration foundation and must remain part of implementation reviews.

## Decision

Launch the standard Pi CLI in a separate Node.js process, in the exact Treehouse-leased directory, using Pi's built-in RPC protocol. The runtime adapter owns the child-process handle and verifies the reported session identity. Do not embed an agent in the Switchboard process. Use an explicit model, session ID and session directory; disable ambient extensions and MCP in the initial worker configuration.

The worker uses Pi's standard write tool to produce one versioned `result.json` at a specified per-attempt location outside the recyclable workspace. Switchboard validates its schema, identity, required evidence entries and work references. A result remains a worker claim, not independent acceptance verification. Missing, malformed, stale or inconsistent results do not imply completion.

Keep immutable input/session bindings and observed process facts in runtime-owned files, alongside Pi-owned session storage. These files are each attempt's launch and child-exit entries in the attempt log ([ADR-0006](0006-switchboard-attempt-log.md)). These facts support discovery and refusal after dispatcher loss. Do not persist a duplicate task lifecycle, add a queue or implement automatic resume. A retained binding without a confirmed exit observation is unresolved, not an absent worker or permission to launch a replacement.

Neither Herdr nor a generic process supervisor is required for this first integration. Herdr may later provide operator visibility. Its interactive readiness and completion badges are not task acceptance or termination evidence.

## Consequences

- No custom Pi extension or model-callable result tool is a Phase 1 dependency.
- RPC progress, model settlement, direct-child exit, worker termination and task acceptance are separate facts. The adapter must not equate them.
- Automatic workspace return requires a verified process-ownership strategy covering tool subprocesses. Pi's shell tool can create detached subprocesses; observing the Pi child exit alone does not authorise workspace return. Phase 1 finalises on direct-child exit and never returns workspaces, so this is no longer a Phase 1 gate.
- The adapter reports `workerTermination: unverified` on every path. It is not ready to enable dispatch until the task-store and workspace adapters, the attempt log and the required fault tests are in place.
- Same-lease relaunch is refused even after a completed child-exit observation. A later resume design must define separate semantics.
- Runtime files are not a security sandbox. A worker with the same OS account and filesystem access is not isolated from malicious tampering by filenames or instructions alone.
- Keep OS-specific process control in infrastructure code and verify the equivalent contract separately on macOS, Linux and Windows, following ADR-0004.

## Continuing comparison with Pi Durable

At each runtime milestone, record what Pi Durable already supplies, what remains application policy and why any new runtime-owned state or lifecycle code is necessary. Reconsider this decision before adding a persistent runtime service, retries, replay, automatic restart, resumable orchestration, queues or scheduled work. Do not reproduce those features incrementally in this adapter.

The first comparison used Pi Durable 1.3.0. It provides committed task/conversation state, request-ID deduplication, inspection and cancellation, but not an external Pi CLI process manager. Its scheduler can start through submit and wait operations as well as explicit resume. Adopting it would require an explicit host, storage and restart policy and revising Phase 1's exclusion in ADR-0003. Merely replacing this adapter's transport would not establish cross-owner atomicity or safe workspace return.

The next comparison checkpoint is subprocess ownership: assess Pi Durable's execution-environment cleanup alongside the native process-ownership mechanism, rather than assuming either confirms all descendants have terminated.

## Alternatives considered

- **Custom Pi extension:** schema-aware reporting is convenient but adds an agent integration to maintain. Prefer the standard write tool and host-side validation first.
- **Pi Durable now:** a valid alternative if the runtime would otherwise need substantial durable execution machinery. It is not added solely to avoid a small RPC adapter.
- **Herdr:** useful for interactive terminals and operator supervision, but does not directly provide this headless result-file and termination contract.
- **Generic process supervisor:** does not remove task identity, result validation or uncertain-outcome handling. Automatic restart would conflict with Phase 1 refusal semantics unless explicitly constrained.

See [runtime implementation notes](../phases/01-basic-dispatch/runtime-integration.md), [architecture](../architecture.md), [Phase 1](../phases/01-basic-dispatch/PRD.md), and [ADR-0003](0003-pi-durable-for-durable-orchestration.md).
