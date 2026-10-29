# Objectives

An objective records what a person asked for, above individual tasks. It keeps their request in their own words, ordered acceptance criteria, scope and constraints, permissions, a cost and worker-time budget, an optional deadline, who created it, timestamps and a state of `open`, `completed` or `abandoned`.

Objectives and their change history live in the same SQLite database as tasks and attempts. Schema version 10 creates them and adds a nullable `objective_id` foreign key to tasks. Existing tasks start without an objective; the migration changes neither their definitions nor their revisions. Objective IDs use letters, digits, `.`, `_` and `-`, and are unique within the database, like task IDs. Objectives are database-wide, not scoped to a context or repository. `objective list` and `status` therefore include objectives across contexts sharing that database.

## Creating and inspecting

```sh
switchboard objective add release-notes "Please make release notes useful to our operators" \
  --criterion "Operators can find the changes affecting them" \
  --criterion "The notes explain any manual steps" \
  --scope "Release notes and their generation" \
  --constraints "Do not publish the release"
switchboard objective show release-notes
switchboard objective list --state open --json
```

All objective commands accept `--config <path>` and `--json`. Add takes either the quoted request or `--request-file <path>`; it preserves the request's text, including line endings. Criteria are nonempty single lines, with at least one criterion per objective. Repeatable `--criterion <text>` flags or `--criteria-file <path>` (one criterion per line, ignoring blank lines) replace the entire ordered list on update. Repeated criterion text is allowed at different positions. An empty criteria file is refused for an objective.

`objective show` includes:

- the request, scope, constraints, permissions, budget, deadline, time left before the deadline, creator and timestamps
- `spending`: total cost and worker time, known subtotals, and each attempt with unknown usage, including whether the creator has confirmed that uncertainty
- each criterion's 1-based position, text and any completion statement
- linked tasks, their states and hold reasons, and the latest attempt in each context, including archived attempts
- `openPersonQuestions`, unanswered questions asked by the objective's supervisor; answer with `objective answer <id> --question <question-id> "<answer>"` (see [questions to the person](supervisor.md#questions-to-the-person))
- `availableReferences`, the accepted commits and recorded reviews that completion statements can cite
- `history`, an ordered record of who changed what and when
- `personInterventions`, a count and oldest-first list derived from the existing actor-bearing records, excluding objective creation and supervisor actions, with lease-return confirmations listed and counted separately. It is the same accounting as the [supervisor briefing](supervisor.md#person-interventions), not another audit table.

The command-line caller is the operating-system user, recorded as `operator:<username>`, not a command argument or the `USER`/`USERNAME` environment variables. Every changing operation takes its caller from trusted hosting code. Objective history, task changes, attempt entries and scoped confirmations record that caller. See [callers and permissions](#callers-and-permissions).

`status` briefly shows each open objective's request and done/total task counts, budget, spending, unknown usage and time left before its deadline, as well as its existing attempt information. JSON status includes an `objectives` list with the same accounting as `objective show`. A done task count is progress, not objective completion.

## Tasks and definition revisions

```sh
switchboard task add release-notes-write "Write the notes" --objective release-notes
switchboard task update existing-task --objective release-notes
switchboard task update existing-task --clear-objective
```

A task belongs to at most one objective. Setting another objective moves the task; `--clear-objective` removes the link. Setting, changing or clearing the link increases the task's definition revision once with any other definition changes in the same update. Setting the same link is a no-op. Task show and JSON output include `objectiveId`, which is `null` when unlinked. New attempt specifications retain it; historical specifications without the field do not acquire a guessed objective.

An objective must be open before tasks can be added to it, moved to or from it, or unlinked from it. Explicitly reopen a completed or abandoned objective first. Creating an independent review task inherits the source task's current objective, so the review is included in its progress. Task-state changes do not implicitly change an objective's state; existing task and attempt safety checks still apply.

## Updating permissions, budget and scope

```sh
switchboard objective update release-notes --scope "Notes and their tests" \
  --constraints "Do not publish or change the version number" \
  --permissions-file permissions.json --budget-file budget.json \
  --deadline 2026-11-01T17:00:00+11:00
switchboard objective update release-notes --clear-deadline
```

Update can replace criteria, scope, constraints, permissions, budget or deadline. It cannot replace the person's original request or creator, or set a state directly. Each effective update is transactional with an append-only history entry containing the actor, time and the old and new values of each changed field. No-op updates do not add history. Creation, completion, abandonment and reopening are recorded too.

Permissions are enforced inside operations, including their dry runs. Only the person who created an objective can change its permissions, budget, deadline or criteria, confirm unknown spending, or abandon it. Other person callers retain their normal task and attempt authority. Budgets and deadlines bind both people and supervisors: a zero budget or past deadline refuses even the first reservation. `dispatch: false` refuses new supervisor dispatches, not a person's dispatch and not an already running worker.

The default permissions record grants the extensive authority described in the [Phase 3 PRD](phases/03-supervisor/PRD.md#caller-identity-permissions-and-budget). `--permissions-file` replaces the whole JSON record, with exactly these boolean fields:

```json
{
  "manageTasks": true,
  "dispatch": true,
  "continueAttempts": true,
  "steerWorkers": true,
  "stopWorkers": true,
  "answerQuestions": true,
  "acceptOutput": true,
  "integrate": true,
  "rebase": true,
  "completeTasks": true,
  "completeObjective": true
}
```

`manageTasks` permits creating, changing, ordering, holding and releasing tasks within the objective, creating reviews, pruning its eligible attempts, and updating its scope or constraints or reopening it. `completeTasks` separately permits marking tasks done. Starting from kept output requires both `dispatch` and `continueAttempts`; stop confirmations use `stopWorkers`. `acceptOutput` permits acceptance only with passing evidence for the exact commit, and `integrate` additionally permits local-merge integration. `answerQuestions` permits recording and delivering answers to [worker questions](worker-questions.md), independently of `steerWorkers`. `rebase` permits `finish --rebase`; the rebased commit then needs passing checks and a passing review of that exact commit before the supervisor can accept it. The other fields name the corresponding operations. None grants authority outside the objective, to change the supervisor's own authority, or to return a lease. Existing safety rules and the person's `--no-processes` confirmation for lease return are unchanged.

`--budget-file` also replaces the whole JSON record:

```json
{ "maxCost": 20, "maxWorkerTimeMs": 3600000 }
```

Both values must be finite nonnegative numbers or `null` for no limit, the default. `maxCost` uses the worker runtime's reported cost units, as the existing attempt limit does. `maxWorkerTimeMs` limits elapsed worker time in milliseconds across the objective's attempts, not the supervisor's conversation time. A deadline must be an ISO timestamp with `Z` or an explicit timezone offset. It defaults to `null`; `--clear-deadline` clears it.

### Accounting and enforcement

Spending is computed from every attempt of the objective's currently linked tasks, across contexts sharing the database, including archived attempts. Each attempt contributes its latest observed cost, not the sum of its snapshots, and elapsed time from its launch record to its observed direct-child exit, or to now while running. Concurrent workers' times are added, not counted as one wall-clock interval. Launch permission is recorded just before starting the process, so its preparation time is included conservatively. An unused reservation or an observed failure to spawn has known zero spending. A launch fence, an archived attempt without accounting evidence, a missing cost snapshot or a finished worker without an observed exit leaves the relevant usage unknown. An operator's stop confirmation does not invent an exit time. Historical cost snapshots are read from activity where available; new runtimes keep their latest usage separately from the bounded diagnostic log. Pruning preserves accounting before removing runtime observations.

`spending.cost` and `spending.workerTimeMs` are `null` when the respective total is unknown. `observedCost` and `observedWorkerTimeMs` are known subtotals, not claims that unreported work was free. `spending.unknown` identifies the attempts and which values are missing. A provider-reported zero is an observed value, not evidence that the subscription consumed no resources; worker-time limits still apply.

Every reservation, including dry runs and requests to start from earlier output, checks the objective inside its reservation transaction. It refuses at or above the recorded cost or worker-time limit, or once the deadline passes, with `objective_cost_limit`, `objective_worker_time_limit` or `objective_deadline` and the `review_objective_budget` next action. Replaying a request ID still returns the original attempt without another reservation. Tasks without an objective keep their existing per-attempt behaviour.

The supervising dispatcher checks the objective while its worker runs. It persists each successful cost snapshot and checks the total; it also checks elapsed worker time and the deadline on its control polling interval, independently of whether usage reporting succeeds. A worker over a budget or past the deadline is stopped as `over_budget`, with the objective-specific reason in the recorded detail and activity. Budgets are checked by observation and can be exceeded by work in progress between observations. There are no budget reservations against unreported future spending and no provider-side cap.

Unknown usage for a finished attempt refuses further reservations as `objective_usage_unknown`, even with unlimited budgets. After inspection, the creator can explicitly allow further work:

```sh
switchboard objective show release-notes
switchboard objective confirm-budget release-notes --note "Inspected the subscription session; allow further work despite unknown cost"
```

Confirmation records the creator, time, note and the exact currently finished unknown attempts in the objective's append-only history. Raising either budget (including removing a finite limit) also confirms those attempts. A no-op or lower budget does not. This permits further reservations only if the known subtotals and deadline still allow them; it does not replace unknown values with zero, confirm future attempts or override other safety checks. A supervisor cannot confirm its own uncertainty or raise its budget.

## Callers and permissions

A caller is a host-supplied `Caller` from `src/caller.ts`: `{ kind: "person", id: "operator:<username>" }` or `{ kind: "supervisor", objectiveId: "<id>" }`. Ordinary CLI commands construct the person with `node:os`'s `userInfo()`. The restricted [supervisor command](supervisor.md) constructs the supervisor for its required `--objective` instead. There is no `--caller` option. Stop and steer keep `--as`, but store it as a `label` alongside the caller-derived `sender`, never as authority.

Supervisor agent integrations are not implemented yet. Hosts can use the restricted command; in-process tools can also call operations with dependencies created by trusted code, for example:

```ts
const caller: Caller = { kind: "supervisor", objectiveId: "release-notes" };
const deps = await createDependencies(config, caller);
try {
  await dispatchOnce(deps, { taskId: "release-notes-write", requestId: "stable-request" });
} finally { deps.close(); }
```

Task and objective stores also take their caller from the host, when opened or constructed, not from task data or update arguments. A manually assembled dependency bundle must bind the same caller to its attempt store. Model arguments, worker output and display labels cannot substitute a person caller. This is an application boundary, not a sandbox against trusted host code or workers with unrestricted filesystem access.

The checks live in `src/dispatch/safety.ts`, and operations re-read the objective's current permissions before effects, including inside their database transactions. A person is not restricted by the permission booleans. A supervisor must name an existing objective, and cannot act on, move, unlink or create tasks outside it. Automatic dispatch selects only its objective's ready tasks; bulk conversion and pruning leave other tasks alone. Database-wide imports require a person.

Three limits cannot be granted away: the supervisor cannot change any objective's permissions, budget or criteria or abandon it; it cannot change tasks outside its objective or create them there; and it cannot return a lease, including `finish --no-processes`, `discard`, `resolve --lease-returned` or reconciliation of a lease-return effect. Finishing without lease return still lets dependent tasks progress. Acceptance additionally requires `checkAcceptanceEvidence` to pass for the exact commit: every currently configured check and the latest review of that commit must have passed, even when accepting output without a worker result. A later commit needs its own evidence. A review verdict can be recorded without accepting the review task's output.

Schema version 11 adds append-only `task_changes` with the caller, action, time and changes. New attempt entries carry `askedBy`; confirmations retain `confirmedBy`, and archive and cleanup records retain their callers too. Older records are still readable without inventing a missing caller. Imports preserve historical entries and record the importing caller separately in task history.

## Completing, abandoning and reopening

Finishing every task **does not complete the objective**. Completion is an explicit statement of how every objective criterion was met:

```sh
switchboard objective show release-notes --json
switchboard objective complete release-notes --statements-file completion.json
```

`completion.json` is an array containing exactly one statement for every criterion, by its current 1-based position. Each statement must be nonblank and refer to at least one accepted commit or recorded review of a currently linked task. Copy the reference objects from `objective show`'s `availableReferences`, for example:

```json
[
  {
    "position": 1,
    "statement": "The accepted change groups the notes by operator impact.",
    "references": [
      {
        "kind": "accepted_commit",
        "contextId": "my-project",
        "taskId": "release-notes-write",
        "attempt": 1,
        "commit": "0123456789abcdef0123456789abcdef01234567"
      }
    ]
  },
  {
    "position": 2,
    "statement": "The recorded review checked that all manual steps are explained.",
    "references": [
      {
        "kind": "review",
        "contextId": "my-project",
        "taskId": "release-notes-write",
        "attempt": 1,
        "commit": "0123456789abcdef0123456789abcdef01234567",
        "reviewTaskId": "release-notes-review",
        "reviewAttempt": 1
      }
    ]
  }
]
```

For a review reference, `taskId` and `attempt` identify the reviewed source; `reviewTaskId` and `reviewAttempt` identify the reviewer. Switchboard checks the exact recorded review, including the commit. It does not infer a review from a worker's Git reference or a free-text assertion. A recorded review may have passed or failed; the statement explains why that evidence supports the objective criterion. These statements and reviews remain judgements, not independent proof.

An accepted commit is one explicitly accepted with a scoped `output_accepted` confirmation, recorded as integrated, or recorded done under its delivery contract with an immutable recorded output commit. A worker merely reporting a commit, or the operator marking a task done without an accepted attempt, is not enough. New archives retain accepted commits and reviews, so pruning attempt entries does not lose those references. Completion checks references and records all statements and the state change in one transaction. Invalid, missing, duplicate or extra criterion positions, blank statements, empty reference lists, invented references and references to other objectives' tasks refuse without changing anything.

Completion does not itself accept, integrate, finish or stop any task or worker. It need not wait for every task to be done if the objective's criteria have been met with recorded evidence.

```sh
switchboard objective abandon release-notes
switchboard objective reopen release-notes
```

Abandonment is a separate command, never an update flag. A completed or abandoned objective refuses updates and other transitions until explicitly reopened. Reopening clears its current completion statements and closed timestamp; the earlier completion and its statements remain in history. Existing tasks and attempts are not stopped, discarded, reopened or otherwise changed by these objective state transitions.
