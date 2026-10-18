# Phase 1: Basic dispatch

Status: implementation specification. Adapter operations below are required behaviour, not claims about existing upstream command names or guarantees.

## Objective and scope

An operator can dispatch one ready tasks-axi task to one Pi worker in a Treehouse-leased workspace and receive a clear outcome, including the retained work and what the operator must check before returning the workspace.

Run in the foreground on one host, against one configured task store and repository. Phase 1 supports one `dispatch` invocation at a time within that context. Running two at once is unsupported and is not prevented, but a task is still never dispatched twice: each attempt's first log entry is created exclusively before the lease is acquired (see [Attempt log](#attempt-log)). Two invocations at once can exceed the one-active-attempt limit. A host-wide dispatcher lock is deferred until a phase runs attempts concurrently. Competing automation must use this entry point; Phase 1 does not coordinate independent dispatchers or concurrent external status writers.

Phase 1 never returns a lease automatically. Returning a lease recycles the workspace, which is the only routine action that can destroy work, and confirming that every process a worker started has stopped is not yet solved (see [runtime implementation notes](runtime-integration.md#unresolved-process-ownership-gate)). Switchboard preserves every lease and reports whether the work is retained. The operator returns leases through Treehouse. Automatic return is deferred until process ownership is verified.

Implement the CLI in strict TypeScript on a pinned Node.js version, initially on macOS, following [ADR-0004](../../adr/0004-typescript-and-node-for-switchboard-cli.md). Linux and Windows are required future platforms, but their implementation and native acceptance runs are outside Phase 1. Keep OS-specific file creation, process control and path handling behind infrastructure interfaces so the same dispatch safety contracts can be implemented on all three platforms. Refuse dispatch on an unsupported host.

Run type checking separately from the tests. Validate external data at runtime and verify exclusive attempt creation on the supported host before enabling dispatch. External components may use their own supported runtimes.

Excluded: automatic lease return, Switchboard persistent state other than the attempt log, Pi Durable, supervisor, mailboxes, schedules, external events, worker pools, automatic retry/resume, automatic crash recovery, merging and publishing changes.

## Operator interface

Phase 1 has only a human operator, but every command is designed for a later agent supervisor to call unchanged (see [Supervision](../../architecture.md#supervision)).

Provide two commands:

- `switchboard dispatch --once` with optional `--task <id>` and `--request-id <id>`. Without a task ID, select the first task in tasks-axi's ready ordering, breaking unspecified ties by task ID. With an ID, require that task to be ready. Never dispatch a second task in the same invocation.
- `switchboard status`, which is read-only. It reports the preflight result, attempts from the attempt log with each owner's current state, attempts whose workers may still be running, and tasks blocked by an earlier attempt, each with its next action.

Implement the dispatch sequence as separate policy operations: select, acquire, start, launch, observe and finalise. Each enforces its own checks from the [dispatch sequence](#dispatch-sequence), so later phases can expose them as separate commands without moving a safety check. Phase 1 does not expose them separately, and has no command to stop a discovered attempt or return a lease.

`dispatch --once` prints task ID, lease ID, workspace and session ID as they become known. The final report includes worker outcome, retained deliverables and work references, task acceptance or remaining approval/integration requirement, confirmed task state, the preserved lease with its retention-check result, any failed operation and a concrete next action. No ready work is a successful no-op; explicit ineligible selection is an error. Return zero only for no work or a completed attempt whose task outcome is recorded and confirmed; hold, failure and unresolved attempts return non-zero with distinct report reasons.

### Repeated requests

A caller may pass `--request-id`. Switchboard records it in the attempt's first log entry, before acquiring a lease. A later `dispatch` with the same request ID never starts another attempt: it returns the existing attempt's current result, inspecting each owner as `status` does. Without a request ID, each `dispatch` is a new request. This lets a supervisor repeat a dispatch it cannot confirm, for example after its own process crashed mid-call (see [ADR-0003](../../adr/0003-pi-durable-for-durable-orchestration.md)).

### Structured results

Both commands support `--json`. Every result and every refusal contains:

- `ok`: whether the command achieved its purpose.
- `reason`: a stable code from a documented list, such as `no_ready_work`, `attempt_may_be_running` or `task_store_unreadable`. Renaming or removing a code is a breaking change.
- The attempt's identifiers when known: context, task ID, lease ID, session ID.
- The owner state the decision was based on, including any state that was unknown.
- `nextAction`: a stable code and a plain description of what should happen next and who must do it.

Human-readable output is generated from the same result. Consumers must never need to parse prose. Document the reason and next-action codes alongside the implementation.

## Required integration contracts

Implement task-store, workspace-provider and worker-runtime interfaces, with tasks-axi, Treehouse and Pi as the initial adapters. Dispatch policy must depend on these interfaces rather than provider APIs or implementation-specific types. The interfaces may adopt tasks-axi's task model and Treehouse's lease model where appropriate; keep provider commands and transport formats inside adapters. Replacements must satisfy the same ownership, identity and safety contracts. Phase 1 does not require additional providers or a plugin system.

| Adapter | Required behaviour |
| --- | --- |
| tasks-axi | List ready and in-flight tasks in the configured store; read task/context; mark in flight; record done or hold with reasons and work references; inspect the result of an uncertain update |
| Treehouse | Acquire by task ID as `lease_holder` on an explicit base and unique attempt branch; return lease ID/path; enumerate context-owned leases and inspect by holder and ID. Returning a lease is not used in Phase 1 |
| Pi runtime | Launch in an exact working directory with task/lease metadata; return session identity; discover context-owned sessions and inspect by task/lease identity after an uncertain launch; observe running/stopped/unknown; obtain a structured result; request stop and observe direct-child exit |

The [initial integration investigation](investigation.md) records tested versions, executable probes, adapter mappings and remaining gaps. It does not establish full Phase 1 acceptance.

Implement and verify these mappings against the chosen component versions before enabling dispatch. In-flight, done and hold are semantic names here; use actual supported tasks-axi states. Failure is an attempt outcome recorded as hold with a failure reason, rather than assuming a separate failed task state exists. If a required capability is unavailable, fail preflight and identify the integration gap; do not substitute a private database or silently weaken the contract.

Resolve and validate the authoritative task-store location at preflight and use it for every task operation, independently of the caller's or worker's working directory. The adapter must not select an independently checked-out copy or permit implicit configuration to redirect writes. Fail preflight on an ambiguous store location or unsupported addressing capability; do not fall back to manual file mutation. Pass a snapshot of task instructions, acceptance criteria and the delivery contract to the worker, together with task ID and lease ID. Workers report proposed task changes through the runtime and leave authoritative task records and lease mutations to Switchboard.

Use a separate Pi CLI process with built-in RPC and a worker-written, schema-validated result file outside the leased workspace, following [ADR-0005](../../adr/0005-pi-rpc-worker-and-result-file.md). No custom Pi extension, external process supervisor or Pi Durable dependency is required for this initial integration. The [runtime implementation notes](runtime-integration.md) track its current limits and the ongoing comparison with Pi Durable.

Phase 1 finalises an attempt once Pi's direct child process has exited. Tool subprocesses may still be running at that point, so finalisation never returns the workspace. The recorded result commit is identified by its full commit ID, so later changes in the workspace cannot alter the recorded deliverable. Verifying that every process the worker started has stopped is required before any automatic lease return, not before finalisation.

Runtime observations and results must be structured and identity-bound. Agent idleness is not process termination, and neither proves task completion. Terminal text and an empty Treehouse process list are not authoritative runtime evidence. Keep required retained evidence outside recyclable workspaces. An unresolved lookup causes refusal, not a replacement launch.

## Attempt log

An attempt is one launch of one worker for one task in one lease. No existing owner records which task, lease, session, commits and outcome belong together, so Switchboard keeps an append-only attempt log for them, following [principle 3](../../principles.md).

- Each attempt has a record containing the context, task ID, any caller request ID, lease ID, session ID, delivery contract, starting commit and, when known, result commit, worker outcome, recorded task outcome and retention-check result.
- Append the first entry, with the selected task and any request ID, before acquiring the lease. Number each task's attempts and create each attempt's first entry with exclusive file creation, naming the latest attempt the caller has already inspected. Creation fails if any other attempt is now the latest, so two invocations cannot both start the same task. An invocation that finds an earlier unresolved attempt for the task refuses. Append each later observation as it is confirmed. Never edit or delete earlier entries.
- The log is not authoritative for task state, lease state or worker liveness. Each of those is still read from its owner. The log tells Switchboard which owner state belongs to which attempt, including after a dispatcher crash.
- The runtime-owned input binding and child-exit records from ADR-0005 are the attempt's launch and child-exit entries. ADR-0005 and the runtime notes must be updated to describe them as part of this log.
- Store the log under the configured runtime root, outside every workspace. Document its location and format alongside the implementation.

The log does not hold a task lifecycle, a queue, retry state or schedules. Adding any of those needs a separate decision.

## Delivery and completion contract

Phase 1's normal coding deliverable is a reviewable local branch, not a merge or published change. Before acquisition, resolve an explicit base branch, a unique output branch for this attempt, required deliverables and evidence, and whether task acceptance requires review or integration. Record the actual starting commit after acquisition and the exact result commit at finalisation. Use the same resolved contract for worker instructions and completion checks; report these work references and retain them with the task outcome and in the attempt log.

Use a configured default that holds code-changing tasks awaiting review/integration. An explicit task contract may instead accept a retained branch, report or other independent artefact as its final deliverable. Do not infer that exception from a worker's success claim or automatically interpret prose acceptance criteria. If the completion requirement cannot be resolved, refuse dispatch before acquisition. Phase 1 needs no general policy language.

Worker completion, deliverable retention, task acceptance and workspace return are separate facts, not additional task states. A worker result of `completed` does not automatically mean tasks-axi done. When integrated code is required, record hold with the retained work references and the next review/integration action. The operator completes that work and applies the appropriate task transition; Switchboard neither merges nor publishes in Phase 1. Do not mark a task done while its completion contract requires changes that are unavailable to its dependent tasks.

Evidence is worker-reported unless Switchboard actually performs an independent check. Validate result identity, required fields, required evidence entries and work references mechanically; do not describe those checks as independent verification of arbitrary acceptance criteria. Code deliverables must be committed to the named output branch before successful acceptance. Reports and other required artefacts must be retained outside the workspace before successful acceptance.

## Dispatch sequence

1. Validate configuration and adapter availability. Inspect in-flight tasks, leases, runtime sessions and the attempt log in the configured context. Refuse dispatch if an attempt's worker may still be running, or if owner state cannot be inspected. Attempts whose workers have stopped do not block dispatch, even while their tasks are held or their leases are preserved; they block only their own task (step 2).
2. If a request ID was given and the attempt log already holds it, return that attempt's current result and stop. Otherwise select one ready task. Confirm it belongs to the configured repository and has no existing lease, worker or unresolved attempt. A task with a preserved lease from an earlier attempt is not dispatched again until the operator resolves it. Create the attempt's first entry exclusively; if another invocation created it first, refuse.
3. Acquire a Treehouse lease with the exact task ID as `lease_holder`. Validate the returned lease identity, workspace path, output branch and actual starting commit against the delivery contract. Append the lease identity to the attempt record and emit the identifiers in the run report.
4. Re-read the task and readiness before starting it. Use a conditional transition if supported; otherwise the supported operating mode requires exclusive status mutation during this sequence. If readiness changed, do not launch.
5. Mark the task in flight and confirm the authoritative state before launching Pi.
6. Launch exactly one Pi worker in the leased path. Associate its session with the task ID and lease ID. An uncertain launch response must never trigger a second launch.
7. Observe the worker until its direct child exits or the operator interrupts. Accept a terminal result only for this task, lease and session. A successful process exit without a valid result is failure, not completion.
8. Apply the outcome policy below and read back the task mutation. Run the retention check, append the outcome to the attempt log and print the final report. The lease stays preserved.

Transient stages such as selected, leased, running and finalising describe this procedure; they are not a new persisted task lifecycle.

## Outcomes and lease policy

The runtime result contains task ID, lease ID, session ID, outcome (`completed`, `hold` or `failed`), summary, validation evidence and any work references. Hold/failure results include a reason and required next action. Switchboard checks result identity, required evidence and the resolved delivery/completion contract; process exit alone never satisfies task acceptance criteria. Reject stale-session results without treating them as completion evidence for the current attempt.

Every outcome preserves the lease.

| Observed outcome | Task action |
| --- | --- |
| Valid completion satisfying the task's completion contract, with required evidence, retained deliverables and observed direct-child exit | Record done with summary, evidence and retained work references |
| Valid worker completion, but required review or integration remains | Record hold with completed-work summary, retained work references and next action; do not unblock dependants through done |
| Worker requests hold and its direct child has exited | Record hold with reason and next action |
| Worker fails, exits without a valid result, or gives inconsistent identity/evidence | Record hold with failure reason once direct-child exit is observed |
| Direct child still running or its exit unknown | Do not record an outcome; report the attempt as unresolved. It blocks further dispatch until the operator confirms the worker has stopped |

The retention check reports whether returning the workspace would remove the only copy of the work. For Git output, verify that the named output branch contains the exact result commit, outside the workspace's own working tree, and report any uncommitted, untracked or ignored files that return would remove. Branch existence alone is insufficient, and a clean working tree is insufficient if commits would become unreachable. Check required reports and evidence separately. Local refs protect against workspace recycling, not loss of the backing repository. The check is reported to the operator; it does not return the lease.

On operator interruption, request worker stop. Once direct-child exit is observed, record hold with an interruption reason. If exit cannot be observed within the configured timeout, report liveness as unknown and leave the attempt unresolved for operator inspection. A lost dispatcher process cannot run compensation; the next invocation finds the attempt in the log and applies step 1.

## Failure compensation

After an uncertain outcome, read the owner's state back. Continue if the intended state is confirmed; otherwise stop and report the attempt as unresolved with the exact remaining action. No row returns a lease.

| Failure boundary | Required response |
| --- | --- |
| Readiness/configuration check fails | Make no mutations; report the cause |
| Lease acquisition fails definitively | Leave task unchanged; do not launch |
| Lease acquisition outcome is unknown | Inspect Treehouse by holder; no blind reacquisition. If unresolved, stop and report the task ID |
| Readiness changes after leasing, or in-flight transition is definitively rejected | Do not launch; preserve the unused lease and report it |
| In-flight update outcome is unknown | Read tasks-axi. Continue if this transition is confirmed under exclusive ownership; otherwise stop |
| Launch definitively fails before creating a worker | Record hold with launch-failure reason; preserve the unused lease |
| Launch outcome is unknown | Inspect runtime by task/lease identity. Adopt only an unambiguously identified session; otherwise stop without relaunching or resetting the task |
| Runtime inspection/result channel fails | Treat liveness/outcome as unknown; report the attempt as unresolved with the inspection or stop action required |
| Final task update fails or times out | Read tasks-axi to determine whether it applied. Report the result and any exact remaining update |
| Dispatcher/host crashes | No automatic repair. The next invocation finds the attempt in the log; operator inspects all three owners before changing state |

Do not automatically reset a task to ready after a launch failure: the attempt may need diagnosis, and the task's dependencies may have changed. Compensation must never overwrite a conflicting external task update.

## Acceptance criteria

1. **Ready selection:** a real ready task is selected deterministically; blocked or explicitly ineligible tasks never acquire a lease or launch a worker. An empty ready list is a no-op.
2. **Identity and isolation:** an integration run proves the exact task ID is the lease holder, the worker runs in the returned path, and task/lease/session identifiers appear in results, reports and the attempt log.
3. **Ordering:** fault injection proves no worker starts before in-flight state is confirmed, and a readiness change after leasing prevents launch.
4. **Completion:** valid completion satisfying the resolved contract records done. Implementation that still requires review/integration records hold and does not unblock dependent tasks through done. Reports distinguish worker completion, retention, acceptance and the preserved lease.
5. **Preservation:** no Switchboard path returns a lease. Hold, worker failure, missing/invalid result, dirty work and unretained commits are reported distinctly by the retention check.
6. **Compensation:** exercise every failure-table boundary, including lost acknowledgements after a successful mutation. Verify that unknown outcomes cause inspection rather than duplicate launch or reacquisition, and that a repeated request ID returns the existing attempt without dispatching again, including after the dispatcher is killed.
7. **Concurrency and interruption:** two invocations started at once never dispatch the same task; operator interruption requests stop and records hold once direct-child exit is observed; an unobserved exit leaves the attempt unresolved and blocks further dispatch.
8. **Crash limitation:** kill the dispatcher after leasing, after in-flight update and after worker launch. The next invocation finds each attempt in the log, never dispatches the same task again, refuses all dispatch while that worker may still be running, and reports available owner state.
9. **Contract and retention:** the launch instructions and finalisation use the same delivery contract. Verify the configured base, actual starting commit, unique output branch and exact result commit. A branch that does not contain that commit, or required evidence existing only in removable files, is reported as not retained and prevents done.
10. **Runtime and store boundaries:** stale-session results cannot complete the current attempt; idle or unavailable runtime observations cannot prove direct-child exit. An uncertain launch is inspected by task/lease identity without relaunching. Task operations still address the configured store from another working directory and never mutate a workspace copy.
11. **Limited persistence:** a real end-to-end Pi run and failure tests require only tasks-axi, Treehouse, runtime-owned state, the attempt log, configuration and diagnostic output. No other Switchboard database or Pi Durable is installed as a Phase 1 dependency.

Use adapter fault tests for boundary cases and at least one real end-to-end dispatch for command, identity and working-directory verification. Phase 1 is complete only when both pass and the actual adapter mappings and attempt-log format are documented alongside the implementation.

## Operator recovery

For an unresolved attempt, use the reported identifiers and the attempt log to inspect tasks-axi, Treehouse and the runtime. Confirm the worker has stopped, apply the appropriate tasks-axi outcome based on evidence, and re-run dispatch.

To return a preserved lease, first confirm from the report that the retention check passed, and that no process still has the workspace open or as its working directory. Then return it through Treehouse using its lease ID. Automated reconciliation, repair and lease return belong to later phases.

See [architecture](../../architecture.md), [principles](../../principles.md) and the linked ADRs for the ownership decisions.
