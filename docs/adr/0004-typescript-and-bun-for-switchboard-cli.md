# ADR-0004: TypeScript and Bun for the Switchboard CLI

Status: accepted implementation decision. Applies from Phase 1.

## Context

Switchboard is a foreground CLI that coordinates task-store, workspace-provider and worker-runtime operations. Its implementation needs explicit outcome types, structured data validation and reliable subprocess handling. Exclusive file creation, interruption and uncertain external outcomes are more important than execution speed.

## Decision

Implement Switchboard in TypeScript with Bun as its application runtime and package manager. Use Bun's test runner and a separate `tsc --noEmit` check. Enable strict TypeScript checking; validate configuration, adapter responses and worker results at runtime rather than relying on static types alone.

Switchboard must eventually support macOS, Linux and Windows. Phase 1 initially supports macOS only; Linux and Windows implementation and verification are deferred, not optional. Each platform must satisfy the same adapter, exclusive-creation, process-lifecycle and retention contracts before being advertised as supported. These are implementation requirements, not claims that the integrations have already been verified.

Keep Bun-specific APIs, subprocess objects and external transport formats inside adapters and infrastructure code. Dispatch policy depends on the task-store, workspace-provider and worker-runtime interfaces, not on Bun types. Use asynchronous subprocess operations for workers so the dispatcher can observe termination and respond to interruption.

Bun runs Switchboard; it does not have to run Pi, tasks-axi or Treehouse. Launch external components through their supported executables and runtimes. Verify compatibility separately before importing any component's SDK into the Bun process. Pi remains the initial worker runtime; this decision does not change that ownership or add Pi Durable to Phase 1.

## Consequences

- Pin the Bun version and dependency versions, commit the dependency lockfile, and document the verified component versions alongside the adapter mappings.
- Type checking, runtime validation, adapter fault tests and a real end-to-end dispatch are separate checks. Passing one does not replace the others.
- Verify interruption, direct-child exit, uncertain subprocess outcomes and dispatcher crashes on the supported host OS. Sending a signal does not by itself confirm termination. Confirmed termination of every worker process must also be verified before automatic lease return is enabled; Phase 1 does not return leases.
- Phase 1 has no host-wide dispatcher lock (see the [Phase 1 PRD](../phases/01-basic-dispatch/PRD.md#objective-and-scope)). It relies on exclusive file creation of attempt entries, which macOS, Linux and Windows provide without native bindings. Verify on each supported host that two concurrent creations of the same attempt produce exactly one winner.
- Choose and test a host-wide lock before any phase runs attempts concurrently. That lock must be released when its owning process exits or crashes; a PID written to an ordinary lockfile is not sufficient. The Phase 1 investigation found that `flock` through Bun FFI works on macOS and that the tested Node-API locking package crashes Bun.
- Runtime and file-creation implementation choices must preserve the Phase 1 persistence boundary. Do not extend the attempt log ([ADR-0006](0006-switchboard-attempt-log.md)) or add other Switchboard state to compensate for a missing integration capability.
- Isolate OS-specific file creation, locking, process control and path handling behind infrastructure interfaces. Do not expose POSIX shell requirements, Unix signal names or file-descriptor assumptions as dispatch-policy requirements. Native implementations may use different mechanisms while satisfying the same behavioural contract.
- Maintain shared behavioural tests for exclusive attempt creation, context identity and refusal when an attempt entry cannot be written. Add tests for lock exclusion, crash release and child handle non-inheritance when a host-wide lock is introduced. Run them on each native host before enabling that platform; macOS-only probes do not establish Linux or Windows support.
- Refuse dispatch on an unsupported host or when an attempt entry cannot be created exclusively.
- A Bun upgrade or new supported OS requires rechecking the process, exclusive-creation and adapter guarantees on which dispatch safety depends.

## Alternatives considered

TypeScript on Node.js remains an alternative if a required integration cannot run reliably under Bun. Running a component as a subprocess may avoid an in-process compatibility constraint; it does not remove the need to verify its integration contract. No current requirement justifies choosing another implementation language.

See [architecture](../architecture.md) and [Phase 1](../phases/01-basic-dispatch/PRD.md) for the ownership, safety and acceptance requirements.
