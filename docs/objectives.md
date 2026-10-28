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

- the request, scope, constraints, permissions, budget, deadline, creator and timestamps
- each criterion's 1-based position, text and any completion statement
- linked tasks, their states and hold reasons, and the latest attempt in each context, including archived attempts
- `availableReferences`, the accepted commits and recorded reviews that completion statements can cite
- `history`, an ordered record of who changed what and when

The command-line actor is the operating-system user, recorded as `operator:<username>`, not a command argument. Objective operations take their actor from the hosting code. Caller permissions and creator-only changes are **not enforced yet**; the later caller-identity task will enforce them.

`status` briefly shows each open objective's request and done/total task counts, as well as its existing attempt information. JSON status includes an `objectives` list. A done task count is progress, not objective completion.

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

Permissions and budgets are **recorded only in this step**. They do not yet refuse dispatch, stop workers, restrict commands or enforce creator-only changes. In particular, recording a zero budget, a past deadline or `dispatch: false` is not a way to stop work today. Use the existing hold and stop commands for that.

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

`manageTasks` records authority to create, change, order, hold and release tasks within the objective. `continueAttempts` covers starting from kept earlier output; `integrate` and `rebase` cover local-merge integration and `finish --rebase`. The other fields name the corresponding operations. Some operations, such as answering worker questions, will arrive in later tasks. None grants authority outside the objective, to change the supervisor's own authority, or to return a lease. Existing safety rules and the person's `--no-processes` confirmation for lease return are unchanged.

`--budget-file` also replaces the whole JSON record:

```json
{ "maxCost": 20, "maxWorkerTimeMs": 3600000 }
```

Both values must be finite nonnegative numbers or `null` for no limit, the default. `maxCost` uses the worker runtime's reported cost units, as the existing attempt limit does. `maxWorkerTimeMs` records elapsed worker time in milliseconds across the objective's attempts, not the supervisor's conversation time. Accounting and enforcement come later. A deadline must be an ISO timestamp with `Z` or an explicit timezone offset. It defaults to `null`; `--clear-deadline` clears it.

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
