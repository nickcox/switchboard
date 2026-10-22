# Comparative prototype: Pi Durable for orchestration

Status: planned; no prototype results yet. Reopens the Phase 3 execution and recovery design, not its domain rules or worker safety requirements.

## Decision to make

Should Pi Durable execute Switchboard's deterministic workflows, rather than only host the Phase 4 reasoning supervisor?

The earlier comparisons asked whether Durable replaces individual components. It does not supply project-task semantics or manage external Pi processes, but it could coordinate operations implemented by Switchboard's adapters. Phase 3 proposes a step runner, persistent control requests, process claims, background dispatch and periodic forge checks. Compare the total execution and recovery machinery needed, rather than treating each mechanism as too small to justify Durable.

Inputs: [ADR-0003](../../adr/0003-pi-durable-for-durable-orchestration.md), [ADR-0005](../../adr/0005-pi-rpc-worker-and-result-file.md#continuing-comparison-with-pi-durable), [ADR-0007](../../adr/0007-one-sqlite-database.md), and the [Phase 3 PRD](PRD.md#shared-mechanisms).

Complete this comparison before implementing the Phase 3 PRD's [implementation steps](PRD.md#implementation-order) 3 to 5: several attempts at once, the background dispatcher, and the step runner the pull-request policy needs. Design B would move the attempt maximum, background execution and the step runner into its execution host, so each depends on the outcome. Work both designs need can go ahead: step 2, separating reading, deciding and reporting an attempt's state, and step 6, the Claude Agent ACP runtime, whose adapter stays Switchboard's in either design. Existing domain operations, database work and runtime adapters are inputs, not implementations to discard in advance. The prototype does not authorise a production dependency, migration or change to automatic recovery policy.

## Designs

### A: Switchboard-owned execution

Switchboard's own code runs each operation's steps and recovers from interruptions, as now.

Use the current implementation and the Phase 3 design: Switchboard's database holds project tasks, attempts, request reservations and runtime observations; Switchboard runs the dispatch and finalisation steps, controls workers and inspects owner state after interruptions. Durable would later host the reasoning supervisor in a separate store.

Implement only enough of the proposed Phase 3 machinery to exercise the common scenario. Distinguish code already present from code the prototype adds and further code production would require.

### B: Durable-owned execution

Durable runs each operation's steps as checkpointed tasks, and its storage records how far each has got.

Durable tasks execute deterministic orchestration through the same Switchboard domain operations and external adapters. No model is needed for dispatch, waiting or finalisation. The reasoning supervisor remains a later conversation that requests operations and handles decisions.

Evaluate one execution host per context, with CLI clients submitting requests, inspecting state and optionally waiting for completion. The host owns Durable storage and worker handles. Do not require foreground commands to independently own execution merely to preserve the current arrangement. Include the cost of transport, exclusive host ownership, startup, shutdown and failure reporting in the comparison.

For every persistent record, name its authoritative owner and purpose. Distinguish project-task and attempt facts from Durable execution checkpoints. Determine which Switchboard mechanisms can actually be removed or reduced; keeping both complete execution records is not simplification. Do not assume sharing a SQLite file gives atomic commits across the application and Durable APIs.

## Common scope and boundaries

Both designs must exercise the same operation:

1. Accept a stable caller request ID, check readiness and capacity, and reserve an attempt.
2. Acquire a Treehouse workspace and record its identity.
3. Revalidate readiness, record that work started, and launch one external worker for the attempt.
4. Observe worker exit and validate its result under the delivery contract.
5. Wait for simulated review or a pull-request merge, without repeatedly asking a model what to do.
6. Finalise using the same acceptance, retention and approval checks.

Use controlled fake workspace, worker and forge adapters first. Keep their side-effect records outside the execution host so a host crash cannot erase the evidence being tested. Use a lightweight real child process to test host and worker lifecycle where an in-memory fake would conceal the problem. Then run one real Pi/Treehouse attempt through each design in disposable workspaces, using a simulated review gate rather than publishing or merging a real pull request.

The following stay Switchboard responsibilities in both designs:

- Project tasks, dependencies, readiness, capacity policy and attempt identity.
- Deliverable acceptance, finalisation policy, authority and operator approvals.
- Workspace retention and return checks.
- Pi/ACP, Treehouse and forge adapters and interpretation of their observations.

The prototype tests whether Durable can record how far each operation has got, and supply waits, interruption handling and cancellation coordination. It must not duplicate domain rules inside Durable tasks or treat a Durable task completing as project-task acceptance.

### Safety requirements

- Never launch a second worker or send the initial prompt again for the same attempt after an uncertain outcome. Request IDs remain stable across client retries and workflow recovery.
- Inspect external effects before continuing after uncertainty. Refusal with an operator action is a valid recovery result; automatic continuation is not required.
- A supervisor or execution-host restart is not permission to restart or adopt an external worker. Preserve current conservative handling of workers that may still be running.
- Keep the current operator confirmation that no worker process remains before returning a workspace. Cancellation of a Durable task is not termination evidence.
- Process containment here concerns the external worker and processes its tools start, such as test runners, watchers and servers that might keep using the workspace. Building containment or automatic workspace return is out of scope, not a prerequisite for evaluating Durable orchestration.
- Recheck approval and relevant owner state before an action, including when recovering a workflow. Neither model input nor a workflow checkpoint grants operator authority.

Also out of scope: an LLM supervisor, additional worker runtimes, recurring production schedules, a general mailbox API, OS service installation and a production database migration.

## Work sequence

1. **Record the baseline.** Identify the implementation commit, existing operations and proposed Phase 3 mechanisms. Map each to domain policy, external adaptation or execution machinery. Record the code and records each design would retain, replace or add.
2. **Qualify the dependency being tested.** Pin the Durable package and integrity hash, or an exact upstream commit for a separate source experiment. Read that revision's specification and relevant examples before implementing. ADR-0003 records that timed waits are absent from published 1.3.0 but present in later source still labelled 1.3.0. Do not infer capability from the version number. Test a released package where possible; label source-only results and report release availability as an adoption constraint.
3. **Build the common test scenario.** Define the domain-operation inputs, outcomes, refusal codes and independent side-effect counters. Add explicit interruption points before and after external effects and recorded acknowledgements. Use the same assertions for both designs.
4. **Implement A and B.** Keep both under an investigation directory with isolated dependencies and temporary storage. Reuse existing application operations where practical; do not refactor production solely to make the prototype work. Count any duplicated adapter code and explain what production integration would need.
5. **Run the failure matrix.** Run controlled crash tests in separate processes, including crashes without graceful shutdown. Record commands, outcomes and repeat counts. Use a controllable clock for deadline tests where supported.
6. **Run real integrations.** Complete the real Pi/Treehouse scenario for each design. Preserve the resulting branches and evidence, and return workspaces only under existing checks and explicit operator confirmation. No automatic publishing or merging.
7. **Write the comparison and decision proposal.** Record results beside this plan, including limitations and untested platforms. Update the ADRs and Phase 3 PRD only after a design is selected.

## Failure matrix

| Boundary or failure | Required evidence |
| --- | --- |
| Duplicate request, including a retry after the client loses its response | One attempt and at most one launch; the retry finds the existing result or a specific unresolved state |
| Concurrent submissions at capacity, including from two CLI clients | The configured maximum is never exceeded; show where it is enforced in each design |
| Host stops before workspace acquisition, or after acquisition succeeds but before its acknowledgement is recorded | The lease is discovered or reported uncertain; no blind second acquisition and no unsafe return |
| Host stops before launch, or after launch but before acknowledgement is recorded | Independent launch and prompt counts remain at most one per attempt; a possibly running worker blocks unsafe continuation |
| Worker finishes before its result is recorded by orchestration | Recovery validates identity and evidence or refuses; absence of a live process alone does not imply success |
| Finalisation effect succeeds before its completion is recorded | Recovery inspects the external owner and does not repeat an uncertain destructive or publishing effect |
| Review signal is delivered twice, or arrives around host restart | One accepted transition, with unanswered or unprocessed work visible rather than silently lost |
| Host restarts during a wait, including after a deadline has passed | Review state is retained; for a timed-wait-capable revision, record how the persisted deadline becomes runnable and who restarts the host |
| Cancellation or shutdown interrupts active work | Distinguish stopping orchestration, requesting worker cancellation and observing termination; retain the lease if termination is unknown |
| A second host starts, storage fails, or a workflow cannot resume | Exclusive ownership is enforced and the failure is visible; no silent new execution or automatic worker replacement |
| Approval is missing, stale or claimed by model-controlled arguments | The shared domain operation refuses before the protected effect, under either execution design |

Process-kill tests do not establish power-loss durability. Record backend settings, flush guarantees and evidence separately, especially Durable's documented default SQLite `synchronous = NORMAL` versus ADR-0007's requirements. Explain what happens if an external effect survives but its execution record is lost. Test upgrade/reopen with unfinished work where supported; otherwise list it as an adoption blocker rather than claiming it works.

## Comparison and decision criteria

Use a table with evidence for each design:

| Criterion | What to record |
| --- | --- |
| Safety and recovery | Matrix results, remaining uncertainty and operator recovery steps |
| Custom execution code | Modules and mechanisms retained, added or removed; line counts are supporting evidence, not the decision alone |
| State ownership | Authoritative stores, duplicate facts, cross-store commits and reconciliation rules |
| Host and CLI complexity | Startup, transport, request deduplication, client disconnects, ownership and shutdown |
| Visibility | How an operator finds active, waiting, interrupted and failed operations without inspecting private engine tables |
| Dependency constraints | Released versus source-only features, storage durability, migrations and platform evidence |
| Production change | Required changes to existing code and records, separate from disposable prototype shortcuts |

The recommendation must be one of:

- **Adopt Durable for orchestration:** it removes meaningful custom execution machinery, meets the safety requirements and has an acceptable release, storage and host design.
- **Retain Switchboard-owned execution:** the experiment shows that necessary custom machinery remains and Durable adds more integration cost than it removes.
- **Use a narrower integration:** identify exactly which operations Durable owns and why that boundary avoids duplicate execution state.

If evidence is incomplete, say which decision is blocked and what additional check would resolve it. Do not interpret a working happy path or unavailable released feature as proof for either architecture. The final report should include reproducible commands, the ownership table, failure results, code-removal estimates and proposed changes to ADR-0003, ADR-0005 and the Phase 3 PRD. Revise ADR-0007 too if the recommendation changes its storage or multi-process ownership rules.
