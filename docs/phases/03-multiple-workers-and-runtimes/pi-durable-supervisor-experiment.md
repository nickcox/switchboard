# Narrow Durable supervisor experiment

Status: dispatch/tool-result-loss and queued-input/event-delivery cases implemented and tested after operator approval; the remaining trial is proposed. The production boundary is not selected. This plan changes no ADR or PRD and authorises no chargeable model calls.

## Question and proposed boundary

Can a supervisor resume after interruption, inspect actual attempt state and continue without repeating an uncertain operation?

The [comparison report](pi-durable-orchestration-report.md) recommends testing Durable for conversation, queued inputs and interrupted tool work only. Switchboard retains deterministic attempt operations, position-free finalisation, permissions, budgets and all task/attempt authority. There is no per-attempt Durable workflow or second dispatcher queue. The classified-read and configured-SQLite experiments through `1a9ee97` remove two earlier objections to full B; this trial must justify the narrower boundary on its own merits.

Use one objective, one supervisor conversation and at most one external worker at a time. One exclusive host owns the separate Durable store. Tools call shared asynchronous application operations in-process, with caller identity supplied by trusted code. Conversation history and previous tool results never authorise an operation.

Inputs: [ADR-0003 acceptance checks](../../adr/0003-pi-durable-for-durable-orchestration.md#integration-acceptance-checks), the [investigation record](../../../investigations/durable-orchestration/README.md), and the supervision-first draft at `047403c894d05fba942898a3bcf134f0aab5f045`, `docs/phases/03-supervisor/PRD.md`. The draft is an input, not the current agreed scope.

## Smallest useful implementation

After approval, keep the experiment under `investigations/` with disposable state under ignored `.investigation/`. Reuse the existing independent effect counters, process-crash fixtures and production application operations where available. Do not introduce a production dependency or migrate authoritative records.

- Start with a scripted model and synthetic workers. This tests conversation and tool recovery without chargeable calls or new agents.
- Expose only inspection, stable-ID dispatch, event/question acknowledgement and the minimum acceptance/continuation operations needed by the cases below. No shell or direct database tool; no model-granted operator confirmation.
- Persist each mutating operation's request ID before execution and reuse it after uncertainty. Declare replay-safe only operations whose application boundary actually supports repetition. Interrupted unsafe calls must lead to inspection, not a new request ID.
- Deliver application events with stable submission IDs. Advance the application delivery position only after Durable acknowledges storage. Keep unanswered and failed inputs visible.
- Use the demonstrated public FULL/fullfsync SQLite connection configuration, measure it on the actual transaction connection and pin the tested package/lockfile. Inspect the installed documentation and examples before choosing APIs; do not silently substitute upstream `main` for released 1.4.0.
- A follow-up attempt from retained output needs an explicit application operation that neither existing prototype supplies. Implement only a disposable contract for this trial if necessary, using existing reservation and safety boundaries. Identify any simulated permissions or budget checks; success must not be reported as production continuation qualification.

## Cases and pass criteria

Use separate host processes and independently counted external effects. Repeat each crash case three times at named boundaries; report counts, refusals and operator interventions, not just test totals.

| Case | Required result |
| --- | --- |
| Interrupt a model turn, queued input or pending decision | Reopen the same conversation; retain accepted input and unresolved work. Any incomplete answer remains visibly incomplete. No assumption that a remote generation request ran exactly once |
| Crash before submission storage, or after storage but before application delivery-position update | Redeliver the same event ID. No accepted event is lost and no duplicate logical input is created; unanswered inputs remain visible |
| Application dispatch succeeds before its tool result is recorded | Recover or inspect using the original operation ID and attempt. Exactly one reservation, acquisition, launch and initial prompt; no fresh dispatch ID to bypass uncertainty |
| Interrupt an unsafe mutating tool | Show the interrupted call and inspect application/owner facts before further action. Do not replay an uncertain effect |
| Restart while a worker may be running | Preserve the binding and lease. No adoption, relaunch or second prompt. Refuse replacement until positive exit or separately authorised resolution permits it |
| Restart while waiting for review or approval | Read current exact-commit evidence and permissions. Expired/revoked approval or model-supplied authority prevents the protected action; conversation history cannot override it |
| Request a new attempt from kept output, then crash around reservation/preparation | Retry the new operation with the same new request ID. Preserve parent-attempt/exact-commit correlation and immutable handover; use a new branch, lease and session, without writing to the old branch. Unknown/running parent, unretained commit or exhausted permission/budget refuses admission |
| Competing host, storage failure or missing definition | Refuse competing ownership; retain diagnosable unfinished work. No stale-claim takeover, hidden retry or replacement worker. Stop and join fixture processes before explicit fixture claim recovery |

All finalisation cases retain current retention checks and human-only no-processes authority. Cancellation or host shutdown is never evidence that descendants stopped. Do not weaken the existing uncertain-effect tests to obtain continuation.

## First case results

The [investigation record](../../../investigations/durable-orchestration/README.md#narrow-supervisor-trial--dispatch-succeeds-before-its-tool-result-is-stored) records three hard-kill/reopen repetitions for each dispatch replay policy. Safe replay reuses the persisted tool-task/request ID and finds the same possibly running attempt; unsafe replay reports interruption without another dispatch. Both then perform scripted fresh inspection. Independent fake-owner counts remain one acquisition, launch and prompt, with zero returns. Live and stale host claims refuse another opener, and the FULL/fullfsync transaction settings are measured in both processes.

This uses a faux supervisor provider and file-backed fake worker owners, not a real worker or model. Each case needs one explicit fixture claim recovery. That first case demonstrates one interrupted-tool boundary, not permissions, objective completion, continuation from retained output or a comparison with plain notes. Its validation was 520 investigation tests; the extension below brings the suite to 538.

## Queued-input and event-delivery results

The [input/event investigation record](../../../investigations/durable-orchestration/README.md#narrow-supervisor-trial--queued-inputs-and-event-delivery-acknowledgement) adds 18 tests: three repetitions each of four hard-kill boundaries and two failure cases. One fixed attempt's immutable log supplies stable event IDs; an application-owned cursor advances only after Durable acknowledges submission. A kill before admission loses no source event, and a kill after admission but before cursor commit redelivers to the identical submission. Queued inputs and their order survive reopening without duplicate transcript inputs.

With `afterFailedRun: "keep"`, an injected failed answer leaves later inputs queued. Tests retain visible unanswered records and use one explicit new operator input to continue the remaining queue, not retry the failed input. Acknowledged delivery is not an answered input. All 24 supervisor cases and 538 investigation tests pass, along with repository checks.

This is a scripted, two-entry, single-attempt delivery fixture, not a production watcher or objective completion. Live appends/pruning, cross-attempt ordering, partial streamed answers, pending decisions, fresh permissions, storage faults/upgrades and the plain-notes comparison remain unqualified.

## Comparison and decision

Compare against reconstructing from application records and plain notes using the same requirements, as ADR-0003 requires. Record what that alternative would need for queued inputs, pending decisions and interrupted calls; a saved transcript is not equivalent. If it is only a desk comparison, label it as such rather than claiming an experimental win.

Deliver a short report with:

- record ownership, API/version provenance and exactly which application operations were reused or simulated;
- crash boundaries, independent effect counts, retained diagnostics and human interventions per completed objective;
- new custom coordination code and any actual removal, separating fixtures from integration code;
- remaining process, storage, upgrade and platform limits.

A successful scripted trial justifies a separately authorised small real-model run to test whether the supervisor actually inspects current state and continues appropriately. It does not establish reasoning quality, power-loss safety or production readiness. A failure that needs substantial custom conversation/replay machinery should reopen the proposed boundary, not trigger an unbounded prototype expansion.

After reviewing the evidence, explicitly select or reject the boundary before updating ADRs and the Phase 3 PRD. Keep pending-tool/deadline upgrade and platform/storage qualification as adoption gates even if the initial trial passes.

## Deferred

No response-watch refactor, child-task restructuring, general recovery console, full-B rerun, daemon/service installation, concurrency, forge publication, automatic lease return or production integration is part of this experiment. No chargeable model run, push, merge or publication is authorised by this plan.
