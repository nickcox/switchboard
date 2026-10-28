# Phase 3: A supervisor that completes one objective

Status: agreed on 21 October 2026 as "Multiple workers and runtimes"; implementation steps 1 to 6 are complete. **Revised on 28 October 2026, under review:** an agent supervisor that completes one objective comes before concurrency, a second runtime and the pull-request policy, which move to Phase 4, and correctness fixes from a whole-project review come first. Requirements, not a description of existing behaviour.

## Objective and scope

A person gives a supervisor agent one objective. The supervisor creates and dispatches tasks, answers a worker's question, has the result checked and independently reviewed, starts a repair when the review fails, accepts the result and starts dependent work, all within the permissions and budget the person granted. Restarting the supervisor loses neither the objective nor any work, and never starts a worker twice. Progress is measured by the number of times a person had to intervene per completed objective.

Phase 2 completed the foreground workflow, and Phase 3's first two steps moved Switchboard's records into one database and separated reading, deciding and reporting. In real use on Switchboard's own backlog, those operations kept work safe: nothing was lost or duplicated. But every interruption still needed a person: a worker cut off before its last commit, a failed worker whose committed output had to be accepted by hand, a report recovered from a transcript, a task whose instructions conflicted with the rules for workers, and a review of every result against its criteria before finishing it. Stopping safely is not the same as continuing. Phase 3 adds what a supervisor needs in order to continue safely, then the supervisor itself.

Every Phase 1 and Phase 2 safety rule still holds. In particular, Switchboard never returns a lease unless the conditions in the Phase 2 PRD's [Returning a lease](../02-reconciliation-and-recovery/PRD.md#returning-a-lease) are met, which still include a person's `--no-processes` confirmation, and no worker is ever started twice for one attempt or sent the same prompt twice. Switchboard never starts a new attempt on its own: a person or the supervisor, within its permissions, always asks for it.

In scope:

- Moving tasks and Switchboard's own records into one SQLite database ([ADR-0007](../../adr/0007-one-sqlite-database.md)), separating reading, deciding and reporting, and accepting output separately from returning the workspace. All three are complete.
- Acceptance criteria stored with each task, with workers reporting against each one.
- Starting an attempt from an earlier attempt's kept output, with a written handover.
- Configured checks, independent review of an exact commit, and repair.
- Objectives: what a person asked for, above individual tasks.
- Caller identity supplied by trusted code, permissions for each objective, and a budget across all of an objective's attempts.
- Questions from a worker to the supervisor, and answers back.
- One supervisor agent, working on one objective at a time, with one worker at a time.
- `finish --rebase` under `local-merge`, as under [When the target branch has moved](#when-the-target-branch-has-moved).

Out of scope:

- Several attempts at once, the background dispatcher, the `pull-request` finalisation policy and the Claude Agent ACP runtime. These move to Phase 4. Their requirements are kept unchanged below under [Deferred to Phase 4](#deferred-to-phase-4), as an input to Phase 4's PRD.
- Proving that every process a worker started has stopped, and so automatic lease return. This stays deferred, as in Phase 2; a person still confirms `--no-processes`.
- Workers starting other agents. The supervisor starts every worker, including reviewers.
- Messages between workers, and messages from the supervisor to a person through anything other than Switchboard's own records and commands.
- Several objectives at once.
- Real-dispatch qualification on Linux and Windows, which stays a Phase 1 platform item. The suite must still pass in CI on both.

Inputs: the [architecture's notes for later phases](../../architecture.md#notes-for-later-phases), [ADR-0007](../../adr/0007-one-sqlite-database.md), the [comparative orchestration prototype](pi-durable-orchestration-prototype.md), the [provider-errors report](../../../investigations/provider-errors/README.md), the [supervisor experiment](pi-durable-supervisor-experiment.md) and [model trial](pi-durable-supervisor-model-trial-report.md), an external review of the implementation and its direction on 22 October 2026, and an implementation plan from a whole-project review in October 2026.

## Pi Durable checkpoint

**Ownership boundary provisionally selected.** The [comparison report](pi-durable-orchestration-report.md), its follow-up experiments, the scripted [supervisor experiment](pi-durable-supervisor-experiment.md) and two authorised real-model runs ([model trial](pi-durable-supervisor-model-trial-report.md)) lead to the boundary [ADR-0003](../../adr/0003-pi-durable-for-durable-orchestration.md) provisionally selects:

- **Attempts run in Switchboard's operations,** reading each owner's current state at every step, with the position-free step runner under [Shared mechanisms](#shared-mechanisms). No step before the supervisor depends on an engine.
- **The supervisor's continuity uses Pi Durable:** its conversation, queued inputs and interrupted reasoning and tool work, in a separate store owned by one host, on a SQLite connection the host opens with `synchronous = FULL` and `fullfsync` ([ADR-0007](../../adr/0007-one-sqlite-database.md)). Production adoption, before step 11, still needs ADR-0003's remaining checks: real-model reasoning beyond the two trial runs, partly streamed model turns, supervisor upgrades, storage and platform qualification, and comparison with rebuilding the supervisor's state from Switchboard's records and plain notes.
- **Running each attempt as a Durable task is not selected.** It can be compared again for Phase 4's background dispatcher if it would remove a material amount of coordination code.

The fourth comparison in ADR-0005 deferred Durable for Phase 3 under four limits. This revision changes the second: the supervisor can ask for a new attempt that starts from an earlier attempt's kept output, within its permissions and budget. That is the supervisor's decision, not Switchboard retrying on its own, but the comparison report must cover it before [Starting from an earlier attempt](#starting-from-an-earlier-attempt) is implemented. The limits are now:

1. No queue of Switchboard's own. The ready order of tasks in Switchboard's database is the order of work.
2. No automatic restart of workers, and no new attempt unless a person or the supervisor asks for it.
3. The maximum number of attempts is enforced across processes by transactions in Switchboard's database.
4. Whether a pull request has merged is read from GitHub each time an attempt's state is worked out (Phase 4).

A change to this PRD that breaks one of these limits needs another comparison before that part is implemented.

## Shared mechanisms

Phase 1 and Phase 2 each implemented some mechanisms more than once, in slightly different ways, and the features below would add further copies. Each of these is therefore implemented once, before the first feature that needs it, and used everywhere it applies:

- **One database.** Tasks, attempts and their log entries, request-ID reservations, and what a dispatcher records about its workers (binding, heartbeat, exit, activity, and stop and steer requests) are in one SQLite database, as [ADR-0007](../../adr/0007-one-sqlite-database.md) decides. Only the files a worker or Pi writes itself stay on disk. This comes first, with the import ADR-0007 specifies, the rules in the [task-store contract](../../task-store.md), and the existing tests passing against it. The storage boundary offers the transactional operations Switchboard needs, such as reserving an attempt, starting a reserved task, recording an outcome, claiming a request and archiving an attempt, not generic save and load functions that callers would have to combine correctly. Database constraints enforce uniqueness and references; deciding readiness, acceptance, retention and whether a lease can be returned stays in domain code. The import converts old records to the current schema once, so the rest of the code reads only the current schema.
- **Transactions instead of short locks.** A change that touches several records is one transaction, and no transaction includes a call to Git, Treehouse, GitHub or the worker. Dispatch keeps its order: one transaction checks capacity and eligibility and creates the attempt and its reservation, leaving the task queued; the lease is acquired; a second transaction checks readiness again, starts the task and records `task_started`. `prune` removes an attempt's rows and reservation, writes its archive summary and records the directories to delete in one transaction, then deletes the directories. A process that dies leaves no change half made and no lock behind, so the prune lock and the stale-lock instructions go. A process waiting for the write lock retries asynchronously, so its heartbeats and stop handling keep running, and refuses with a stable reason code if the database stays busy beyond a configured time.
- **Launch rows.** Each attempt has exactly one launch row. A dispatcher creates it as permission to launch, and `finish`, `discard` or `resolve` creates it as a fence; exactly one succeeds, and nothing ever removes it. This keeps today's guarantee that a pending launch cannot happen after one of those commands has claimed the attempt.
- **Claims held by long-running processes.** A process that owns something for longer than one transaction, such as the background dispatcher or a dispatcher supervising a worker, holds a claim: a row naming its owner (process ID and start time) with a heartbeat refreshed every five seconds. A claim has an ID generated for it. A claim with a stale heartbeat is never taken over automatically: the refusal names its owner and when its heartbeat stopped, and says how the operator releases it once nothing that could hold it is running.
- **Requests to a running process.** Stop requests and operator messages are rows that the owning process claims exactly once, with an update that succeeds only if nobody has claimed the request, or that the sender withdraws the same way if nobody claims them in time. Requests are addressed to a claim by its ID, never to a process ID or a context, and the request kinds are a parameter, so the background dispatcher's own controls use the same protocol.
- **Reading, deciding and reporting are separate.** `observeAttempt` reads an attempt's records and the current state of each external owner. `assessAttempt` is a pure function that works out the attempt's state, for people, and the facts that decide what is allowed. `status` only presents the result; activity summaries and transcript paths are optional additions for reporting. Commands use `observeAttempt` and `assessAttempt` directly and never call `status`. An observation is evidence, not lasting permission: a command checks the relevant state again, in the transaction or immediately before the external call, at the point where it makes a change.
- **Safety checks, not state labels, authorise operations.** Small domain functions decide each operation from the assessed facts: `checkCanAcceptOutput`, `checkCanIntegrate`, `checkCanReturnLease` and `checkCanPrune`, and others as needed. Each returns permission or a refusal with its evidence. A command composes the checks it needs, instead of keeping its own list of states. These are ordinary functions, not a configurable rules engine.
- **Confirmations are recorded in one way.** The operator's confirmations (that no worker process remains, to accept output, to discard, that a worker stopped, that a lease was returned, and Phase 3's permission to publish) keep their command-line flags but are recorded as one kind of record: the fact confirmed, the attempt, who confirmed it, when, and its scope, such as the commit for accepted output or the branch and target for publishing. A confirmation applies only to what it names: that no worker process remains applies to one lease return, not to any later one.
- **Finalisation is built from a few operations.** `finish`, `discard` and dispatch's finalisation are compositions of shared operations: reserve an attempt, claim or prevent a launch, record accepted output, integrate an exact commit, record a task outcome with its log entry, return a lease, and schedule the deletion of retained files. Returning a lease is one operation that owns its own checks, intent entry and read-back, so no caller assembles them separately. Operations that use the same provider command but mean different things, such as discarding a workspace and returning one whose work is retained, stay separate.
- **Finalisation steps.** `finish`, `discard` and dispatch's finalisation are each a list of steps. Changes within the database that belong together are one transaction within a step; steps exist for changes outside it, in Git, Treehouse and GitHub. Each step has a description, a check of whether the attempt log or its owner shows it has already happened, an optional intent entry recorded before a step whose outcome could be uncertain, and the action itself. One small implementation runs the list: it runs the steps in order, skips steps already done, reports a failure as a stopped result naming the step, and settles an uncertain external outcome by reading the owner's state, never by repeating the step. It has no saved position, no dependency graph, no automatic replay and no generic undo, and a plan is ordinary typed data, never configuration a repository supplies. `--dry-run` uses the same planner as a run, but a run checks the plan's assumptions again, because Git, leases and tasks can change between the two commands.
- **Policy kinds as definitions.** Each finalisation policy kind is one definition: the facts from the forge that would make it fail, its steps, how it confirms that the work was integrated, and any attempt states of its own. The retention check is the same for every kind, because returning a lease keeps the output branch in the backing repository whichever way the work was integrated. Adding `pull-request` adds one definition and changes nothing in `finish` or the classification.
- **One dispatch loop.** `dispatch --once` is the background dispatcher's loop run in the foreground, with a limit of one dispatch, waiting for that attempt to finish before it exits. Starting an attempt and supervising its worker are separate parts that the loop uses, so the two commands cannot behave differently.

## Accepting output separately from returning the workspace

`finish` used to refuse without `--no-processes` before it checked anything else, so a concern about leftover processes stopped accepted work from reaching dependent tasks. `finish` has four steps, which can be completed at different times:

1. **Accept** an exact output commit.
2. **Integrate** it under the context's finalisation policy.
3. **Record the task as done.**
4. **Return the lease.**

Steps 1 to 3 need the same evidence as today about the output and the worker's direct process (an observed exit, or a confirmed stop), but not `--no-processes`. Integration uses the exact accepted commit, so later changes to the output branch do not change what was integrated. Step 4 still needs `--no-processes` and every other condition for returning a lease.

`finish` without `--no-processes` completes steps 1 to 3, and reports that the lease is retained, with the command that returns it. Running `finish` again with `--no-processes` returns the lease, skipping the steps already done. An attempt that is done with its lease retained blocks nothing, and its task's dependents become ready.

## Correctness fixes

A whole-project review in October 2026 found two defects, confirmed in the code, and some smaller problems. They are fixed before the remaining steps, because later steps build on attempt records being consistent.

**One snapshot per attempt.** Today dispatch chooses the delivery contract and repository before acquiring a workspace, but takes the instructions from the task after starting it, and `startReservedTask` checks only that the task is still ready. So a task changed during acquisition can launch its new instructions in the old repository under the old contract, even with a task kind that has no contract. Instead:

- A task has a definition revision, increased in the same transaction as any change to its title, instructions, repository or kind. Holds, releases, dependencies and state changes do not increase it.
- Reservation stores an immutable attempt specification in its transaction: the task ID, definition revision, title and instructions, the repository and context, the base ref and output branch name, the resolved delivery contract, the runtime settings that matter (profile, provider, model, limits; never credentials or a copy of the environment), and where these came from in the configuration.
- After acquisition, Switchboard records the allocation separately and immutably (lease, workspace, backing repository and actual starting commit). Starting checks the definition revision; if it changed, the attempt is held as `task_definition_changed` without launching, and the lease is kept. The worker is launched only from the stored specification and allocation, never from the task or configuration as they now are.
- A change after the task starts applies to a later attempt; it neither changes nor cancels the running one.
- Existing attempts are migrated from their runtime bindings, with missing provenance marked unknown. An open attempt without a complete specification stays inspectable and resolvable, but cannot be launched.

**Request IDs survive archiving.** Today a request ID is a column of the attempt's row, and archiving deletes the row, so the same request ID can then start a second attempt. Request records become separate rows, keyed by context and request ID, that archiving keeps, pointing to the archived summary. Each records a fingerprint of the caller's explicit inputs; a reused request ID with different inputs is refused as `request_input_mismatch`. A request that selected the next ready task records the task it selected, so repeating it returns that attempt rather than selecting again.

**The validated result is recorded once.** Today `finish` reads the worker's `result.json` again when it finishes, so a file changed after validation could change what is accepted. When the worker's exit is observed, Switchboard validates the result and records its content and digest; later steps use that record. A result file that later differs is reported as a discrepancy, never adopted.

**Inspecting and finishing without the runtime installed.** Reading the configuration is separated from opening providers. `status`, the `task` commands, `finish` and `discard` work when Pi is missing or broken; only dispatch checks the runtime's prerequisites, before reserving anything. Each command closes what it opened, including when a later step fails.

**One observation path.** Dispatch uses `observeAttempt` and `assessAttempt` instead of its own inspection, so it and `status` cannot disagree about the same evidence.

**Documentation that no longer matches the code** is corrected: `docs/task-store.md` (says not implemented), the README (says the runtime storage migration is still to come), and `docs/principles.md` (says Phase 1 does not enforce one dispatch at a time). The README states plainly that workers run as the operator's user and are not sandboxed, that usage limits are checked by observation and can be exceeded, and that result validation is not independent verification.

## When an owner cannot be read

An operation that reads an owner (Treehouse, Git, the runtime or, in Phase 4, the forge) can fail for a moment. In the orchestration prototype's real runs, one failed Treehouse read stopped one design for good, although nothing had been changed. Every operation classifies a failure during a step as one of four kinds, and the classification is decided by Switchboard's operations, from what the operation can show, not by an engine or a general error handler:

| Kind | Treatment |
| --- | --- |
| An owner read failed before any effect was attempted | Record the failure with the failed command's output, refuse with a reason that says the read can be tried again, and read again when the operation is next run, by a person, the supervisor or a later check |
| An approval is missing or has expired | Keep waiting, and check again next time |
| An external effect may have happened | Refuse, and require the owner to be inspected and the outcome reconciled; never repeat the effect automatically |
| The request is invalid, or an owner gave a definite rejection | A final refusal, where appropriate |

A failure counts as the first kind only when the operation can show that no effect was attempted, for example because it happened before the step's intent was recorded. The failed command's output is kept with the attempt, so that the failure can be diagnosed later.

## Acceptance criteria as data

Each task has an ordered list of acceptance criteria, stored in the database and set with `task add` and `task update`. A one-time conversion takes them from each existing task's `## Acceptance criteria` section, and reports any task it could not convert.

Dispatch passes them to the worker in `acceptanceCriteria`, which is empty today. A worker's result reports each criterion as met or not met, with a short note of the evidence, and validation refuses a result that does not report every criterion. A criterion reported as met is the worker's claim, not proof; checks and review provide the evidence.

## Starting from an earlier attempt

A person or the supervisor can ask for a new attempt that starts from an earlier attempt's kept output, instead of from the target branch, naming the earlier attempt. The request is refused unless the earlier attempt's worker has an observed exit or a confirmed stop, and its output commit is recorded and retained.

The new attempt has its own lease, workspace, session and output branch, created from the earlier attempt's output commit. It never writes to the earlier attempt's branch, so a process left behind by the earlier worker cannot change the new attempt's work through that branch. Its instructions include a handover:

- the task and its criteria
- the earlier attempt's outcome and summary, its commits and its report against each criterion
- any review findings
- a note from the requester on what remains

The new attempt records the earlier attempt and its exact output commit, and gets a new request ID, attempt, lease, session and branch; nothing of the earlier attempt's identity is reused. The earlier attempt's lease can stay retained; it does not block the new attempt.

A configured limit applies to the number of attempts per task, and an objective's budget applies to all its attempts. A new attempt is still refused while any worker for the task might be running.

## Checks, review and repair

**Configured checks.** A context can list check commands, such as `npm run check` and `npm test`. Before output is accepted, Switchboard runs them in the attempt's workspace at the exact output commit, and records each command's exit status and the end of its output against that commit.

**Independent review.** A review is an attempt of a review task, run in a different worker session from the work it reviews. It names the exact commit it reviewed, and reports each of the reviewed task's criteria as met or not met, with its findings. The existing `review` task kind and delivery contract are the starting point.

**Acceptance.** The supervisor can accept output, within its permissions, only when the checks and a review both passed for that exact commit. After a rebase or any later commit, both are needed again.

**Repair.** When a review fails, the supervisor can start a new attempt from the reviewed commit, as under [Starting from an earlier attempt](#starting-from-an-earlier-attempt), with the review's findings in the handover.

## Objectives

An objective records what a person asked for:

- their request, in their words
- its acceptance criteria
- its scope and constraints
- the permissions granted
- a budget of cost and elapsed time, and an optional deadline
- its tasks
- its state: open, completed or abandoned

A task belongs to at most one objective. Completing every task does not complete the objective. The supervisor completes it with a statement of how each of its criteria was met, referring to the accepted commits and reviews. It can add tasks within the objective's scope. Only the person who created an objective can change its permissions, budget or criteria, or abandon it.

## Caller identity, permissions and budget

Every operation that changes something records who asked for it. The caller is supplied by the code that hosts the caller, never by request arguments: the operating-system user for the command line, as today, and a fixed identity for the supervisor, set by its host.

The supervisor has extensive authority by default, so that it can make decisions and keep work moving without asking. Within its objective it may perform every operation Switchboard offers, including:

- creating, changing, ordering, holding and releasing the objective's tasks, and dispatching them
- starting an attempt from an earlier attempt's kept output, and abandoning an attempt's work by holding its task
- steering and stopping its own workers, and answering their questions
- accepting output, under [Checks, review and repair](#checks-review-and-repair)
- integrating under `local-merge`, including `finish --rebase`
- recording tasks as done, and completing the objective

The person who creates an objective can narrow these permissions for it. Three limits apply whatever the permissions say:

- **No changes to its own authority.** The supervisor cannot change the objective's permissions, budget or criteria, or act on tasks outside the objective.
- **No lease return.** Returning a lease, and so `discard`, still needs a person's `--no-processes` confirmation, because nothing yet proves that every process a worker started has stopped (see the out-of-scope list). Leases accumulate until a person confirms; because [accepting output is separate from returning the workspace](#accepting-output-separately-from-returning-the-workspace), this does not block progress. Once process containment is proven, returning leases can become one of the supervisor's permissions.
- **Safety rules still apply.** Every Switchboard safety check binds the supervisor exactly as it binds a person; authority to perform an operation never overrides a refusal.

Permissions are checked inside Switchboard's operations, as part of the safety checks, not only in the supervisor's instructions. Publishing, under Phase 4's `pull-request` policy, is decided in Phase 4.

The budget is enforced across all of the objective's attempts, not only per attempt. A dispatch is refused once the objective has spent its budget, and a running worker is stopped when the objective goes over it.

## Questions from workers

A worker can ask a question while it works. A question has an ID, the attempt, the text, optional choices, and whether the worker is waiting for the answer. Questions go to the supervisor, or to a person before the supervisor exists. The answer is delivered to the worker as a message naming the question. Only the supervisor asks a person anything, and only its own questions.

A question still open when its worker finishes stays open, and its answer goes into the handover of any attempt that continues the work. How a worker asks is the runtime's concern; with Pi it could be an extension tool, or a file in the attempt's directory that the supervising dispatcher reads.

## The supervisor

The supervisor is an agent that works on one objective, using Switchboard's operations as its tools, with its own caller identity and the objective's permissions. It runs in the execution host the [Pi Durable checkpoint](#pi-durable-checkpoint) chooses. Its lasting state is the objective record and Switchboard's existing records, plus notes it keeps; it adds no second record of attempts or tasks.

After a restart it reads the objective, its tasks, attempts and open questions, and continues. It never starts a worker for an attempt whose worker may still be running. Each time a person intervenes in an objective is recorded, so the verification record can report interventions per completed objective.

## When the target branch has moved

Under `local-merge`, `finish` fast-forwards the target branch to the output branch, which is impossible once the target branch has commits the output branch lacks. It happens whenever someone commits to the target branch while a worker runs, and with several attempts at once (Phase 4) it is the normal case. Rebasing the output branch by hand does not help either, because the rebased branch no longer contains the result commit the worker recorded, so the attempt stops being retained. So:

- `finish` refuses with a specific reason and next action when the target branch has moved, and changes nothing.
- `finish --rebase` rebases the output branch onto the target branch in the attempt's workspace, then finishes as usual. It refuses, leaving the branch as it was, if the workspace has uncommitted or untracked files, if the commits to rebase are not exactly those between the attempt's starting commit and its result commit (or its accepted commit), or if the rebase stops on any conflict. Switchboard never resolves a conflict.
- The rebased head becomes the attempt's accepted commit, recorded as a confirmation whose scope names the original commit, the rebased commit and the target commit it was rebased onto. The retention check, the fast-forward and the rest of `finish` then use the rebased head.
- `--rebase` needs approval: a person's, or the supervisor's within its permissions. The review covered the original commits, and a rebase without conflicts can still combine changes that break each other, so the rebased commit needs the checks and a review again before acceptance, as under [Checks, review and repair](#checks-review-and-repair).
- `finish --rebase --dry-run` reports what would be rebased onto what. If the target branch moves again before the fast-forward, `finish --rebase` can be run again.

Choosing between rebasing, dispatching the task again and discarding the work remains the operator's decision, or later the supervisor's.


## Considered, not scheduled

The whole-project review also proposed the following. Each is reasonable, but none is needed for this phase's objective; each is taken up only when its trigger occurs:

| Proposal | Trigger |
| --- | --- |
| Registered repository and context identities, with an explicit relocation operation | A repository moves, two contexts share a repository, or a configuration change makes historical attempts ambiguous |
| A store for accepted deliverables, with retained copies, digests and its own clean-up | Accepted artefacts are needed after their attempt's records are pruned, or by later tasks |
| Resource accounting beyond the attempt limit and the objective's budget: limits on retained leases and disk, budget reservations reconciled against usage, a maximum gap in usage reporting | Unattended use shows overspending, missing usage, or leases building up |
| One execution host per context, with the command line as its client | Phase 4's background dispatcher |
| Non-recycled workspaces, or a qualified container or virtual machine with evidence that every process stopped | Retained leases become a burden, or automatic lease return is wanted |
| An attempt revision for concurrency checks, instead of comparing whole histories | Measurements show the comparison is slow |

## Deferred to Phase 4

The following requirements were agreed on 21 October 2026. They are kept unchanged as an input to Phase 4's PRD, and are not part of Phase 3.

### Several attempts at once

Each context has a maximum number of active attempts, `maxAttempts` in the context configuration, defaulting to 1. An attempt is active from its first log entry until it records a task outcome, halts or is resolved by the operator: Phase 2's open attempts. An attempt that is awaiting review, awaiting finish or held for another reason has no worker and does not count.

**Enforcing the maximum across processes.** `dispatch --once` and the background dispatcher can run at the same time, and an operator can run several `dispatch --once` commands. Each dispatch therefore counts the active attempts, selects a task and creates the attempt in one transaction (see [Shared mechanisms](#shared-mechanisms)), so two dispatches can never both see room for one more attempt. The transaction never includes acquiring a lease or running a worker.

**Which attempts block dispatch.** Phase 1 refuses every dispatch while any worker may be running, because it could not tell a worker supervised by a live dispatcher from one left by a crash. The dispatcher heartbeat now makes that distinction, so Phase 3 relaxes the rule as the architecture note proposes:

- A worker whose dispatcher heartbeat is fresh (less than 30 seconds old) blocks only its own task, and uses one of the context's attempts.
- A worker with no observed or confirmed exit whose heartbeat is missing, unreadable, stale or dated in the future still blocks all dispatch in the context, as now, until the operator confirms it stopped with `resolve --worker-stopped`.

The heartbeat is only ever a reason to block. A missing or unreadable observation never permits a dispatch.

The rebase requirements apply with one attempt at a time too, so they are in Phase 3, under [When the target branch has moved](#when-the-target-branch-has-moved).

`status` shows the maximum, the number of active attempts and, when dispatch is blocked for the whole context, the attempt that blocks it.

### Background dispatcher

`switchboard dispatcher start` starts a long-running process for one context that dispatches ready tasks while it runs. Starting it is the operator's instruction to keep dispatching; nothing else starts it. It runs detached from the terminal and keeps running after the terminal closes, on macOS, Linux and Windows.

**What it does.** While it runs and is not paused, whenever the context has fewer active attempts than its maximum and nothing blocks all dispatch, it dispatches the next ready task through the same loop as `dispatch --once` (see [Shared mechanisms](#shared-mechanisms)): the same preflight, the same transaction, the same steps and the same finalisation when the worker ends. It has no queue of its own: the next task is always the first eligible task in the database's ready order at that moment. Dispatching stops when no task is eligible and resumes when one becomes ready. It supervises each worker it starts exactly as a foreground dispatch does, including its heartbeat, budget and forwarding of operator messages and stop requests.

**How often it checks.** Each check lists leases through Treehouse, which starts a process, and reading a pull request's state is a call to GitHub, which limits how often it can be asked. The dispatcher therefore checks for eligible work at a configured interval (default 30 seconds), and at once when one of its workers finishes, and reads the state of each recorded pull request at most once per a separate configured interval (default five minutes). The intervals are part of the loop, not stored: after a restart the dispatcher simply checks again.

**One per context.** The dispatcher holds a claim on the context (see [Shared mechanisms](#shared-mechanisms)). A second `dispatcher start` refuses while that heartbeat is fresh. If the heartbeat is stale, the start still refuses and names the claim, as for any claim: Switchboard cannot prove the old process has stopped.

**Controlling it.**

- `switchboard dispatcher pause` and `switchboard dispatcher resume` stop and restart new dispatches without affecting running workers. They are requests addressed to the dispatcher's claim, using the same protocol as `stop` and `steer`.
- `switchboard dispatcher stop` stops new dispatches, then waits for the dispatcher's workers to finish before the process exits. `--stop-workers` also sends each of its workers a stop request, exactly as `switchboard stop` does, so each attempt is held as interrupted once its worker's exit is observed.
- `switchboard dispatcher status`, and a section of `switchboard status`, show whether the dispatcher is running, paused or stopping, its heartbeat, its attempts and why it is not dispatching, if it is not.
- `watch`, `stop` and `steer` work on its attempts unchanged, because they work through the dispatcher's records and requests in the database rather than through the process that owns the worker.

**When it stops unexpectedly.** If the dispatcher process ends without finishing its attempts, for example after a crash or a restart of the computer, its workers' heartbeats go stale. Each attempt is then possibly running and blocks all dispatch until the operator confirms its worker stopped, as for a foreground dispatch that ends unexpectedly. A new dispatcher never restarts a worker or reattaches to one, because a worker cannot be resumed without sending its prompt again, and it never retries an attempt. It starts dispatching again only when nothing blocks all dispatch.

**Its own records.** The dispatcher writes a log of what it did and why it waited, under the runtime root, for diagnosis. The attempt log remains the record of each attempt, and the dispatcher's log is never read to decide anything.

### Pull-request finalisation policy

A third finalisation policy kind, `pull-request`, for repositories whose target branch only accepts changes through pull requests, for example because it is protected. It is configured through the same three layers as `manual` and `local-merge`, with these settings: `targetBranch` (default: the base branch), `remote` (default `origin`) and `draft` (default `false`). Operator layers can forbid it like any other kind. It needs a GitHub origin and the GitHub CLI (`gh`) with access to the repository. Without either, the policy is refused before any step, with the reason.

**Opening the pull request.** Pushing the output branch and opening a pull request publishes work, so `finish` under this policy needs `--publish` as well as the usual review: without it, `finish` stops before any change and reports what it would push and open. With it, `finish`:

1. Runs the retention check, as for any `finish`.
2. Pushes the output branch to the remote under the same name. If a branch of that name already exists on the remote, it must point to the same commit, or to an earlier commit of the output branch that the push only moves forward; otherwise the push is refused. Switchboard never force-pushes.
3. Opens a pull request from the output branch into the target branch with `gh`, as a draft if configured. Its title is the task's title, and its body names the task and attempt and includes the worker's summary.
4. Records `pull_request_opened` in the attempt log, with the pull request's URL and number, the remote and the pushed commit.
5. Leaves the task held, replacing the hold reason with one naming the pull request, and keeps the lease.

Each step reads back its owner's state, and `finish --publish` can be run again after a failure to complete the remaining steps without pushing or opening anything twice: before opening, it looks for an open pull request from the output branch and records that one instead.

**Waiting for the merge.** Switchboard does not track the pull request in the background or store anything about it beyond the attempt-log entries. Each time an attempt with an open pull request is classified, by `status`, by `finish` or by the background dispatcher (at most once per its interval), its state is read from GitHub, which owns it. That gives three new attempt states:

| State | How it is recognised | Next action |
| --- | --- | --- |
| Awaiting merge | Pull request recorded and open | Review and merge it on GitHub |
| Merged | Pull request merged | `finish` (records the task as done and returns the lease) |
| Pull request closed | Pull request closed without being merged | Reopen it, then wait, or `discard` |

A pull request whose state cannot be read makes the attempt's state unknown, which blocks every command that would change it, as in Phase 2. GitHub's answer is never cached between commands.

**Finishing after the merge.** `finish` on a merged attempt records `integrated` with the merge commit, records the task as done and returns the lease. Under `local-merge`, `finish` confirms integration with Git: the target branch contains the output branch's commit. That cannot work here, because after a squash or rebase merge the target branch has new commits with different hashes. This policy instead records `integrated` only when GitHub reports the pull request merged into the target branch and the pull request's head when merged is the pushed commit or a descendant of it. The retention check is unchanged from Phase 2: the output branch still holds the result commit after the merge, and the workspace must have no uncommitted or untracked files. The lease return still needs `--no-processes` and the lease identity check. The background dispatcher may report that an attempt's pull request has merged, but it never finishes the attempt.

**The worker never publishes.** Only `finish` pushes or opens pull requests, using the operator's Git and `gh` credentials. The worker's environment does not receive them.

### Second runtime: Claude Agent ACP

Claude Agent ACP is the second runtime, as the [ACP runtime survey](acp-runtime-survey.md) recommends. Each context chooses its runtime in its configuration (`pi` or `claude-acp`), with Pi the default. Choosing a runtime per task kind can follow if it is needed.

**Supervision is shared; the protocol is not.** `src/runtime/pi/worker.ts` combines the Pi protocol with heartbeats, request claiming, usage limits, activity recording, shutdown and exit recording. Before ACP is added, a shared supervisor is extracted from it, owning the worker's claim and heartbeat, control requests, usage-limit decisions, activity recording, shutdown and the final observations. A runtime adapter keeps starting its isolated process, speaking its protocol, reporting its capabilities and observations, and carrying out the control operations it supports, including its own cancellation and termination: the supervisor does not assume that stopping means the same thing in every runtime. The extraction is made from the working Pi implementation, not designed in advance.

**Runtime interface.** The runtime interface stops assuming Pi, following the survey's recommendations:

- **Capabilities.** Each runtime declares which operations it supports: messages after a turn ends, messages queued by the host, active-turn steering, cancelling a turn, and which usage observations it reports. A `steer` request that the runtime cannot deliver is refused with that reason. It is never turned into a cancellation, a new prompt or a new attempt.
- **Identity.** The attempt's identity stays Switchboard's: context, task, attempt, lease and session. The runtime's own identifiers, such as the ACP session ID, are recorded against it in the runtime records, with the adapter, engine and model versions.
- **Launch and isolation.** Each runtime defines its executable and arguments, its exact working directory, an environment that contains only listed variables, pinned adapter, engine and model versions, private configuration and session directories, and a permission policy that refuses anything not listed. A runtime may not reuse a shared server or a recovered session for a new attempt.
- **Turn end, result and exit stay separate.** A turn ending is not a result: the worker's result file is validated as now, and an attempt's worker is finished only when the exit of its direct child process is observed. Cancelling a turn and stopping the worker are separate operations.
- **Usage.** Usage is recorded as separate, optional observations with their scope: context occupancy, cumulative cost, per-request tokens and the model they are attributed to. A missing value is recorded as missing, not zero. A cost limit is accepted only for a runtime that reports cumulative cost.

**Claude Agent ACP profile.** A pinned `@agentclientprotocol/claude-agent-acp` and engine, started over standard input and output, with one new process and one new session per attempt. The profile sets empty setting sources and plugins, a private home and configuration directory, only the approved credentials, and an exact model, and refuses every permission request outside the workspace and the result file's path. It uses active-turn steering only when the adapter advertises it, with its option that leaves an idle session to the host, so a steering message that arrives after the turn has ended is reported as not delivered rather than starting new work.

**Qualification before use.** Before the runtime can be selected, a qualification suite must pass against the pinned versions, as the survey lists: exact working directory and model; operator and repository settings, skills, plugins and context files placed where the engine would find them, and shown to have no effect; result permissions outside the working directory; missing, invalid and stale results; cancellation during a tool call; the observed exit of the adapter and engine; usage scopes; and steering at the moment a turn ends. A real dispatch with this runtime must then complete on macOS.

## Implementation order

Each step is implemented, tested and recorded in the verification record before the next starts. Each shared mechanism is implemented before the first step that needs it.

1. **One database.** Complete.
2. **Reading, deciding and reporting.** Complete.
3. **Accepting output separately from returning the workspace.** Complete.
4. **Correctness fixes.** Complete.
5. **When an owner cannot be read.** Complete.
6. **Acceptance criteria as data.** Complete.
7. **Starting from an earlier attempt.** Tests first cover crashes while the new attempt is reserved and its branch and workspace prepared, and refusal when the earlier attempt's worker might be running, its output is not retained or its state is unknown.
8. **Checks, review and repair.** Needs steps 6 and 7.
9. **Objectives**, and **caller identity, permissions and budget.**
10. **Questions from workers.**
11. **The supervisor**, once ADR-0003's remaining checks, listed under [Pi Durable checkpoint](#pi-durable-checkpoint), have passed.

`finish --rebase` can be implemented at any point after step 4.

## Acceptance criteria

1. Tasks, attempts, reservations, requests and the dispatcher's records are in the database, with `synchronous = FULL`, and Switchboard no longer depends on tasks-axi. Every rule in the task-store contract has a test. The import refuses while any attempt is not settled, writes and validates a new file before activating it, can be run again, and leaves the old data unchanged; it is tested against a tasks-axi backlog and file-based records including a pruned attempt and a reservation without an attempt. A process killed while holding the write lock leaves no lock behind. The existing tests that pause a dispatch just before launch while another command resolves or discards its attempt pass against launch rows. `finish`, `discard` and dispatch's finalisation are composed from the shared operations and run through the step runner, and for each a test shows that `--dry-run`, with nothing changed in between, plans the steps a run then takes. No command calls `status` to find or classify an attempt, and the commands' own lists of states are replaced by the safety checks, each with tests of its permissions and refusals. Every confirmation is recorded in the one form, with its scope. `dispatch --once` runs through the dispatcher loop.
2. `finish` without `--no-processes` accepts, integrates and records the task as done, leaving the lease retained, and the task's dependents become ready. Running it again with `--no-processes` returns the lease without repeating any step. Tests interrupt each step.
3. A task changed in each of its title, instructions, repository and kind while its workspace is acquired is held as `task_definition_changed` without a launch; a change after start leaves the running attempt's input unchanged; and inspection after a restart shows the same specification whatever the current configuration. Repeating a request after its attempt is archived returns the original attempt and starts nothing, and a request ID reused with different inputs is refused. A changed `result.json` is reported, not adopted. With Pi missing, `status`, the `task` commands and `finish` still work.
4. For each operation that reads an owner, a test injects a read failure before any effect and shows a refusal that can be tried again, with the failed command's output kept, and that running the operation again completes it with each effect performed once. A test injects a failure after an effect's intent, and after the effect, and shows a refusal that requires reconciliation, with no second effect.
5. A task's acceptance criteria reach the worker, and a result that does not report every criterion is refused.
6. An attempt started from an earlier attempt's kept output starts from that exact commit, on its own branch and workspace, with the handover in its instructions. It is refused while the earlier worker might be running, when the earlier output is not retained, and beyond the attempt limit or the objective's budget.
7. Configured checks run at the exact output commit. The supervisor's acceptance is refused unless the checks and a review passed for that commit, and a later commit needs both again.
8. The supervisor's caller identity cannot be supplied in request arguments. Changing its own permissions, budget or criteria, acting on tasks outside its objective, returning a lease, and any operation a person removed from its permissions are each refused inside Switchboard, with a test for each.
9. A worker's question reaches the supervisor, and the answer reaches the worker. An open question survives its worker finishing and appears in the next attempt's handover.
10. A real run: a person gives the supervisor one objective with at least two dependent tasks. The supervisor dispatches them one at a time, answers a worker's question, has a result checked and reviewed, starts a repair after a failed review, accepts the result, starts the dependent task and completes the objective with its statement. A test restarts the supervisor while a worker runs and shows that it continues without starting that worker again. The verification record reports the number of times a person intervened.
11. Under `local-merge`, `finish` on an attempt whose target branch has moved refuses with its specific reason and changes nothing. `finish --rebase` integrates a cleanly rebased output branch and records the original, rebased and target commits; it refuses without changing the branch on a conflict, on a dirty workspace, or when the branch has commits other than the attempt's own; and it is refused without the operator's approval.
12. The suite passes on macOS, and in CI on Linux and Windows.
