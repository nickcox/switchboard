# Phase 3: Multiple workers and runtimes

Status: agreed on 21 October 2026; not yet implemented. Requirements, not a description of existing behaviour.

## Objective and scope

An operator can leave Switchboard working through the ready tasks of a context, with several workers at once up to a configured maximum, on Pi or on a Claude agent through ACP, and can finish work in repositories that only accept changes through pull requests.

Phase 2 completed the foreground workflow: one `dispatch --once` at a time, one attempt at a time, and operator commands to finish, discard and prune attempts. In real use on Switchboard's own backlog, independent tasks waited for each other, the operator had to start each attempt by hand, and repositories with a protected default branch could not use `local-merge`. Phase 3 addresses each of these with a separate feature. The features can be implemented and released one at a time, in the order under [Implementation order](#implementation-order).

Every Phase 1 and Phase 2 safety rule still holds. In particular, Switchboard never returns a lease unless the conditions in the Phase 2 PRD's [Returning a lease](../02-reconciliation-and-recovery/PRD.md#returning-a-lease) are met, which still include the operator's `--no-processes` confirmation, and no worker is ever started twice for one attempt or sent the same prompt twice.

In scope:

- Moving tasks and Switchboard's own records into one SQLite database, as [ADR-0007](../../adr/0007-one-sqlite-database.md) decides, before the first feature.
- Several attempts at once in one context, up to a configured maximum enforced across processes.
- A background dispatcher that starts attempts for ready tasks while it runs and supervises their workers.
- A `pull-request` finalisation policy that pushes the output branch, opens a pull request and finishes the attempt once the pull request is merged.
- A second runtime: Claude Agent ACP, behind a runtime interface that no longer assumes Pi.

Out of scope:

- Proving that every process a worker started has stopped, and so automatic lease return, including after a pull request is merged. This stays deferred, as in Phase 2.
- Starting a new attempt automatically after a failure, and retrying any step automatically (Phase 4).
- An [Agent Host Protocol](https://microsoft.github.io/agent-host-protocol/) server, notifications to the operator, and starting the background dispatcher automatically when a command needs it. These can follow once the background dispatcher has been used.
- Running the background dispatcher as a system service (`launchd`, `systemd` or a Windows service).
- Codex ACP, OpenCode and `pi-acp`. The [ACP runtime survey](acp-runtime-survey.md) ranks Codex ACP next, once a configuration that ignores the operator's own Codex settings has been verified.
- Forges other than GitHub for the `pull-request` policy.
- Rebasing output branches without the operator's approval, merging them, or resolving conflicts between them.
- Real-dispatch qualification on Linux and Windows, which stays a Phase 1 platform item. The suite must still pass in CI on both.

Inputs: the [architecture's notes for later phases](../../architecture.md#notes-for-later-phases), the [ACP runtime survey](acp-runtime-survey.md), the [process-ownership survey](../02-reconciliation-and-recovery/process-ownership-survey.md), [ADR-0007](../../adr/0007-one-sqlite-database.md), and the fourth comparison with Pi Durable in [ADR-0005](../../adr/0005-pi-rpc-worker-and-result-file.md#continuing-comparison-with-pi-durable).

## Pi Durable checkpoint

**Execution and recovery design under review.** Complete the [comparative orchestration prototype](pi-durable-orchestration-prototype.md) before implementation steps 3 to 5 below; steps 2 and 6 can go ahead, as the plan explains. The comparison asks whether Durable should execute deterministic workflows through Switchboard's domain operations and external-worker adapters, including whether one execution host would simplify the current multi-process design. Domain rules and safety requirements remain unchanged; the mechanisms below are the current candidate, not a settled choice against Durable.

The fourth comparison in ADR-0005 deferred Durable for Phase 3 under four limits. These still describe this candidate, but do not establish that it is simpler than Durable-owned execution:

1. No queue of Switchboard's own. The ready order of tasks in Switchboard's database is the order of work. It orders project tasks, which Pi Durable does not model, and is not a queue of dispatch requests.
2. No automatic restart of workers and no retry of attempts.
3. The maximum number of attempts is enforced across processes by transactions in Switchboard's database.
4. Whether a pull request has merged is read from GitHub each time an attempt's state is worked out. Switchboard does not store a schedule of when to check it.

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

## Several attempts at once

Each context has a maximum number of active attempts, `maxAttempts` in the context configuration, defaulting to 1. An attempt is active from its first log entry until it records a task outcome, halts or is resolved by the operator: Phase 2's open attempts. An attempt that is awaiting review, awaiting finish or held for another reason has no worker and does not count.

**Enforcing the maximum across processes.** `dispatch --once` and the background dispatcher can run at the same time, and an operator can run several `dispatch --once` commands. Each dispatch therefore counts the active attempts, selects a task and creates the attempt in one transaction (see [Shared mechanisms](#shared-mechanisms)), so two dispatches can never both see room for one more attempt. The transaction never includes acquiring a lease or running a worker.

**Which attempts block dispatch.** Phase 1 refuses every dispatch while any worker may be running, because it could not tell a worker supervised by a live dispatcher from one left by a crash. The dispatcher heartbeat now makes that distinction, so Phase 3 relaxes the rule as the architecture note proposes:

- A worker whose dispatcher heartbeat is fresh (less than 30 seconds old) blocks only its own task, and uses one of the context's attempts.
- A worker with no observed or confirmed exit whose heartbeat is missing, unreadable, stale or dated in the future still blocks all dispatch in the context, as now, until the operator confirms it stopped with `resolve --worker-stopped`.

The heartbeat is only ever a reason to block. A missing or unreadable observation never permits a dispatch.

**When the target branch has moved.** Under `local-merge`, `finish` fast-forwards the target branch to the output branch, which is impossible once the target branch has commits the output branch lacks. With several attempts at once this is the normal case: by the time one attempt is finished, another has usually been integrated. Rebasing the output branch by hand does not help either, because the rebased branch no longer contains the result commit the worker recorded, so the attempt stops being retained. So:

- `finish` refuses with a specific reason and next action when the target branch has moved, and changes nothing.
- `finish --rebase` rebases the output branch onto the target branch in the attempt's workspace, then finishes as usual. It refuses, leaving the branch as it was, if the workspace has uncommitted or untracked files, if the commits to rebase are not exactly those between the attempt's starting commit and its result commit (or its accepted commit), or if the rebase stops on any conflict. Switchboard never resolves a conflict.
- The rebased head becomes the attempt's accepted commit, recorded as a confirmation whose scope names the original commit, the rebased commit and the target commit it was rebased onto. The retention check, the fast-forward and the rest of `finish` then use the rebased head.
- `--rebase` needs the operator's approval. The review covered the original commits, and a rebase without conflicts can still combine changes that break each other; Switchboard runs no tests. Phase 4 may let the supervisor rebase without approval where configuration allows it, for example once the result of CI on the rebased branch can be read from the forge.
- `finish --rebase --dry-run` reports what would be rebased onto what. If the target branch moves again before the fast-forward, `finish --rebase` can be run again.

Choosing between rebasing, dispatching the task again and discarding the work remains the operator's decision, or later the supervisor's.

`status` shows the maximum, the number of active attempts and, when dispatch is blocked for the whole context, the attempt that blocks it.

## Background dispatcher

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

## Pull-request finalisation policy

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

## Second runtime: Claude Agent ACP

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

Each feature is implemented, tested and recorded in the verification record before the next starts. Each shared mechanism is implemented, with the existing commands moved onto it and their tests passing, before the first feature that needs it:

1. **One database.** Tasks, attempts, reservations, requests, confirmations and the dispatcher's records move into it, with the `task` commands and the import. This replaces the tasks-axi adapter and the file-based records, and the existing tests pass against it, in CI on every platform, before anything else changes.
2. **Reading, deciding and reporting.** `observeAttempt`, `assessAttempt` and the safety checks replace the commands' calls to `status` and their own lists of states.
3. **Several attempts at once.** Needs the transactions above. The relaxed blocking rule is needed by the background dispatcher, and is useful alone with several `dispatch --once` commands.
4. **Background dispatcher.** Needs claims, requests to a running process and the single dispatch loop.
5. **Pull-request finalisation policy.** Needs finalisation built from operations, the step runner and policy kinds as definitions; `finish` and `discard` move onto them first. Independent of the first two, but the background dispatcher should report merged pull requests.
6. **Claude Agent ACP.** Worker supervision is extracted from the Pi adapter first, as described under [Second runtime](#second-runtime-claude-agent-acp), with the Pi runtime's tests passing unchanged; then the runtime interface, then the Claude profile and its qualification suite.

## Acceptance criteria

1. With `maxAttempts` set to 2, two dispatches started at the same time from separate processes start two attempts for different tasks, and a third refuses while both are active. A test kills a dispatch partway through its first transaction and shows that no attempt was created, and the next dispatch proceeds without exceeding the maximum.
2. A running worker with a fresh heartbeat blocks only its own task; one whose heartbeat is missing, unreadable, stale or dated in the future blocks all dispatch. Tests show each case.
3. The background dispatcher dispatches ready tasks up to the maximum, stops dispatching when paused, finalises each attempt as `dispatch --once` does, and refuses to start while another dispatcher holds the context. After its process is killed, its attempts block dispatch until the operator confirms their workers stopped, and a new dispatcher neither restarts nor retries any of them.
4. `dispatcher stop --stop-workers` holds each of its attempts as interrupted once the worker's exit is observed.
5. Under `pull-request`, `finish` without `--publish` changes nothing; with it, it pushes without force and opens one pull request, and can be run again after a failure at any step without pushing or opening anything twice. `status` reports awaiting merge, merged and closed from GitHub, and an unreadable pull request makes the attempt unknown. Tests use a fake `gh` and a local bare remote.
6. `finish` on a merged attempt records `integrated` only when the pull request was merged into the target branch with the pushed commit in its head, and returns the lease only when the retention check passes and the operator confirmed with `--no-processes`. A squash-merged pull request finishes; a pull request whose head does not contain the pushed commit is refused.
7. The Pi runtime runs through the new runtime interface with its existing tests passing. A `steer` request to a runtime without steering is refused.
8. The Claude Agent ACP qualification suite passes against the pinned versions, and a real dispatch with it completes on macOS with a validated result file and an observed process exit.
9. A real end-to-end run with the background dispatcher and `maxAttempts` of 2 completes two attempts at once, and a real run under `pull-request` opens a pull request and, once it is merged, finishes the attempt.
10. Tasks, attempts, reservations, requests and the dispatcher's records are in the database, with `synchronous = FULL`, and Switchboard no longer depends on tasks-axi. Every rule in the task-store contract has a test. The import refuses while any attempt is not settled, writes and validates a new file before activating it, can be run again, and leaves the old data unchanged; it is tested against a tasks-axi backlog and file-based records including a pruned attempt and a reservation without an attempt. A process killed while holding the write lock leaves no lock behind. The existing tests that pause a dispatch just before launch while another command resolves or discards its attempt pass against launch rows. `finish`, `discard` and dispatch's finalisation are composed from the shared operations and run through the step runner, and for each a test shows that `--dry-run`, with nothing changed in between, plans the steps a run then takes. No command calls `status` to find or classify an attempt, and the commands' own lists of states are replaced by the safety checks, each with tests of its permissions and refusals. Every confirmation is recorded in the one form, with its scope. `dispatch --once` runs through the dispatcher loop.
11. Under `local-merge`, `finish` on an attempt whose target branch has moved refuses with its specific reason and changes nothing. `finish --rebase` integrates a cleanly rebased output branch and records the original, rebased and target commits; it refuses without changing the branch on a conflict, on a dirty workspace, or when the branch has commits other than the attempt's own; and it is refused without the operator's approval.
12. The suite passes on macOS, and in CI on Linux and Windows.
