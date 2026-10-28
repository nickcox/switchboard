# Attempt records

Status: commands use `src/attempts/store.ts`, under [ADR-0007](../../adr/0007-one-sqlite-database.md). `src/attempts/log.ts` retains only the legacy file reader for import; commands never use it for storage. `src/attempts/prune.ts` retains only the legacy reservation and archive schemas, with no file writer, lock or pruning operations.

Attempts link tasks, leases, sessions, commits and outcomes. Tasks and attempts share the configured SQLite database, normally `<runtimeRoot>/switchboard.db`, outside every recyclable workspace. Treehouse still owns leases, and runtime observations still decide whether a worker may be running.

## Database records

Schema version 11 holds attempts, entries, separate request records, retained attempt numbers, confirmations, archive summaries, pending directory deletions, runtime records, attempt specifications, acceptance criteria, immutable review-task targets, objectives and append-only task-change history. Opening an older database migrates it automatically. Version 3 removed the task's obsolete `started_body` snapshot; outcomes leave the current task body untouched, so no splicing is needed to preserve operator edits. Attempt numbers are unique within a context and task; entry sequences start at zero and have no gaps. Request IDs are unique within a context and never expire. Each new request record stores a versioned fingerprint of explicit selection inputs and the selected attempt; archiving switches it to the archived summary. A reservation imported without an attempt has a null attempt number and still prevents reuse of its request ID. Historical requests with unknown explicit inputs remain excluded, and conflicting historical mappings refuse migration. See the [request-record contract](../../task-store.md#request-records-and-pruning).

Each immutable entry has `version: 1`, `contextId`, `taskId`, `attempt`, `sequence`, `kind`, `recordedAt` (an ISO time) and validated `data`. New entries also have `askedBy`, derived from the host-supplied caller (`operator:<username>` or `supervisor:<objective-id>`); older entries may lack it. Database references enforce ownership, and a trigger refuses entry updates. Corrections are new entries.

| Kind | Data |
| --- | --- |
| `requested` | Acquisition intent: optional `requestId`, the acquisition `pool`, and the resolved delivery `contract` |
| `leased` | `leaseId`, `workspace`, `baseRef`, `outputBranch`, `startingCommit`, and acquisition `pool` |
| `task_started` | No fields |
| `launched` | `sessionId` |
| `operator_request` | Request `id`, `kind`, caller-derived `sender`, `outcome`, optional display `label` (`--as`), `message` and `error` |
| `worker_finished` | Runtime `status`, `runtimeDirectory`, optional `reason`, `detail`, `outcome` and `resultCommit` |
| `retention_checked` | `retained`, `findings` and `notes` |
| `review_recorded` | Review `taskId`, review `attempt`, exact reviewed `commit`, `verdict` (`passed` or `failed`) and per-criterion `findings` |
| `owner_read_failed` | `owner`, `classification`, `operation`, `step`, `failedAt` and bounded command `diagnostics` |
| `owner_read_reconciled` | Settled `failureSequence`, recorded `targetBranch` and exact `commit` established by Git |
| `task_recorded` | `outcome` (`done` or `hold`), `reason`, explicit `category`, and `applied` |
| `halted` | `stage`, `reason`, optional `detail` and recovered lease identity |
| `operator_resolved` | `action` (`worker_stopped`, `lease_returned` or `owner_read_reconciled`), optional `note` |
| `output_accepted` | Exact accepted `commit` |
| `integration_started` | Intended `targetBranch`, its previous `from` commit and exact output `commit` |
| `integrated` | `policy: local-merge`, `targetBranch` and `commit` |
| `discarded` | Optional `note` |
| `output_branch_cleanup` | Output `branch`, `status` (`deleted` or `kept`) and optional explanatory `detail` |
| `lease_return_started`, `lease_returned` | `leaseId`, `by` (`finish` or `discard`) and the return's unique `returnId` |

Outcome categories are `done`, `review_required`, `not_retained`, `held_by_worker`, `failed`, `interrupted` and `over_budget`. Classification reads the category, never a category inferred from a hold reason. Task instructions are not changed to carry attempt evidence; the result and attempt records retain it.

## Starting-point reservations

A reservation starting from kept output uses a fresh `requested` entry and request ID. Its immutable attempt specification additionally stores `startingPoint: { taskId, attempt, commit }`, linking the same task's earlier attempt and exact recorded output commit. Output acceptance takes precedence over the validated worker result; a current branch head or result file is never substituted. The explicit source task and attempt participate in the request fingerprint, so replay cannot change the starting point. The source's entries, confirmations, lease, session and branch are left unchanged.

`reserveFromAttempt` performs owner and retention checks, then `AttemptStore.reserveAttempt` atomically checks the source snapshot, observed exits or scoped stop confirmations, task-wide worker exclusion, readiness, context capacity and `maxAttemptsPerTask` (default 3), and writes the new number, request, attempt and specification. Retained numbers, including archives and other contexts, count towards the per-task limit. Replays return the original reservation even at the limit. Refusals change nothing; a transaction crash leaves either all reservation records or none. A reserved continuation prevents the source from obtaining fresh launch permission, even after archiving.

The named source's retained lease is allowed for this reservation only. Ordinary dispatch and other earlier leases retain their existing exclusions. The operation stops at reservation: there is no new `leased` or `launched` entry yet, no task start and no reused worker identity. A later workspace-preparation step must allocate a fresh branch, lease and session from the stored commit. See the [task-store contract](../../task-store.md#starting-from-an-earlier-attempt).

## Output-branch lifecycle

An attempt's exact recorded output commit is retained when reachable from its output branch or target branch. Continuations and reviews use this rule too, so integrated output remains usable after its branch has gone. The target is the recorded integration target, or otherwise the attempt's recorded base branch; a later configuration change does not choose another target for old output. Other Git references still require their named branch, except a review's exact source-output reference, which uses the source attempt's target.

After `finish` or `discard` confirms a lease return and records `lease_returned`, it deletes the output branch only if the attempt was discarded or its recorded output commit is reachable from that target. Manual finalisation keeps unintegrated output. A branch must still point at the exact recorded commit; Git checks that old value atomically during deletion. Symbolic refs, moved branches, missing commit records and failed checks or deletions are kept with a reason. An already absent branch counts as deleted. Cleanup is best effort: failure never prevents or undoes a lease return.

Each cleanup appends `output_branch_cleanup`, including kept branches and failures. `status` presents its latest result as deleted or kept with any reason; before cleanup it shows kept. If writing that entry fails, the command still reports the cleanup result and recording failure. An interrupted return completed by a later `finish` or `discard` also performs cleanup after confirming absence.

`cleanup-output-branches --dry-run` lists what would be deleted and every branch kept with its reason, without changing refs or records. Running without `--dry-run` applies the same rule to attempts whose returns have already been confirmed. Held leases and unknown worker or lease state never permit cleanup. Archived attempts are included where their records identify the branch and commit; incomplete older records are kept rather than guessed. Cleanup never changes tasks or leases. It may be run again after manual integration or a failed deletion.

Pruning preserves the output commit, target and discard decision in `outputBranchRecord`, and the branch-cleanup history in `outputBranchCleanup` in the archive summary. Later cleanup appends to that history with its own sequence, time and caller. Older archives use their recorded allocation, result commit or scoped acceptance where available. A dry run records no cleanup entry.

## Review records

A generated review task has an immutable target and uses `reviewTarget` in its attempt specification and worker input. It starts at the exact reviewed output commit in a different worker session. The source's stored acceptance criteria become the review's criteria. Its result must include a `reviewed-output` Git reference naming the source branch and exact commit, and report every criterion through `criteriaReport`.

The review outcome transaction appends `review_recorded` to the source attempt, using the validated result rather than the result file. It records `passed` only for a retained completed review with every criterion met, otherwise `failed`. An invalid or missing result records no judgement. The source's recorded output commit is checked again inside the transaction; findings for another commit are never attached to it. Review task completion does not accept or integrate the source output. Status shows reviews matching its recorded output commit, and pruning copies all review records into the source's archive summary. See the [review-task contract](../../task-store.md#review-tasks-and-findings).

## Failed owner reads

`dispatch`, `resolve`, `prune`, `finish` and `discard` classify failures at declared read boundaries, from evidence held by the operation, not by treating every exception as retryable. The shared classification has four kinds: `owner_read` (a failed read before any effect was attempted), `approval_required` (a missing or expired approval or confirmation), `effect_uncertain` (an external effect may have happened), and `rejected` (an invalid request or definite rejection).

A failed read appends an immutable `owner_read_failed` entry. Its operation names the command; its step names the read being checked. Dispatch failures before reservation have no attempt to append to, so the structured result retains their diagnostics. If records cannot be read or written, the result still retains the failed command's diagnostics. `failedAt` is the failure time, distinct from the entry's `recordedAt`. Diagnostics keep the error message and, when a command ran, its executable, arguments, exit status, timeout and truncation flags, and the last 2,000 characters of each output stream. Environment, stdin, arbitrary error properties and stacks are not copied. Credential-bearing URLs and common authentication fields are redacted.

Before any effect, the command refuses as `owner_read_retryable`, with next action `retry_owner_read`, naming the owner and saying the read can be tried again. Running the same command again reads the owner afresh; the historical entry does not block it. A definite retention finding, such as a missing output branch or uncommitted files, still refuses rather than promising a retry will fix the work.

After an effect or a durable intent (`requested` for acquisition, `integration_started`, or `lease_return_started`), a failed read refuses as `reconciliation_required`, with next action `reconcile_owner`. It cannot start another acquisition or repeat an uncertain effect. Existing process, retention, identity and confirmation checks still apply.

A later `finish` can settle an interrupted integration by reading the recorded target branch and proving it contains the exact intended commit. It records `owner_read_reconciled`, referring to the failure's entry sequence, and `integrated` together in one transaction, with integration recorded once. A failed read during this check refuses again and records another uncertain failure. A target that does not contain the commit does not authorise another fast-forward. A dry run does not settle an uncertain integration.

For outcomes that reading cannot settle, inspect the owner, then use:

```text
switchboard resolve --lease <lease-id> --read-failure <entry-sequence> --effect-outcome not_happened --note "Inspected the owner and established no effect happened"
```

Use `happened` instead when that is the outcome established. `--task <task-id> [--attempt <n>]` can select the attempt instead of `--lease`. The required sequence names one unsettled `effect_uncertain` entry in that attempt, not an approval for other failures. A claimed integration still needs the recorded target to contain the exact intended commit before `finish` can continue; claiming it happened never authorises repeating it. The operator confirmation records the sequence and established outcome, with a required explanatory note. It never performs the effect. It refuses while the worker or dispatcher may still be running, including on the final recheck; stop confirmation remains a separate operation.

An uncertain lease return is not retried. If Treehouse confirms absence from the recorded pool, `finish` or `discard` can complete the existing `lease_returned` record without returning the lease again. An operator confirmation of `happened` also needs that absence; it cannot overrule a listed lease or a pool Switchboard cannot observe. Only an operator confirmation of `not_happened`, scoped to the failure and its return UUID, permits a fresh return intent and confirmation on a later `finish`. Every unsettled failure must be reconciled before further effects.

`status` shows the latest recorded failure, including its sequence and diagnostics; JSON uses `latestReadFailure` and lists every unsettled failure and sequence in `unsettledReadFailures`. An unreconciled uncertain failure sets next action `reconcile_owner` and `changeable: false`. The diagnostic remains visible after a successful retry or a completed return record. A dry run changes no external owner, but still records failed-read diagnostics with the attempt.

## Validated worker results

The immutable `validated_result` runtime observation belongs to the attempt's launch row. It records the validated result content, the SHA-256 digest of the source file's bytes, its source path, `validationVersion: 1` and `validatedAt`. It is committed after observing the worker's successful exit and before dispatch records completion or checks retention. The first record wins; subsequent validation cannot replace it.

Dispatch and finish use this content for the reported outcome, work references and exact integration commit. Status includes the recorded report and reports discrepancies with the current result file. A changed, missing or unreadable file is diagnostic only, never replacement evidence. Existing worker, task, retention and process-ownership gates still apply. For an older attempt without the observation, finish applies the existing result checks and records the result before checking retention; a dry run validates without writing. Explicit operator output acceptance remains separate.

## Transaction boundaries

Every write starts with `BEGIN IMMEDIATE`. SQLite uses WAL, `synchronous = FULL`, `fullfsync` and a zero busy timeout. Writers retry busy transactions asynchronously up to `databaseRetryMs`; a timeout changes nothing. No transaction calls Git, Treehouse, GitHub or a worker. Each command closes its database before exit.

Dispatch checks capacity (`maxAttempts`, default 1), readiness, definition revision and task exclusion while reserving the attempt, its immutable specification, number, first entry and any request record in one transaction. The task stays queued. Lease acquisition follows outside the transaction. A second transaction checks readiness and the stored definition revision again, starts the task and records `task_started`. A changed definition halts without launching and keeps the lease. Refused or uncertain lease acquisition leaves the task queued. No separate task-store operation can start a task. `status` still reports an in-flight task with no attempt, worker or lease because the legacy task import can preserve that state without attempt files.

Recording an outcome writes `task_recorded` and closes the attempt in the same transaction as its task change. The task changes only if it is still in flight and has not been held since starting, including a hold subsequently released. Otherwise `applied: false` records the disagreement and preserves the operator's decision. `finish` and `discard` compare the expected task state, hold and hold revision before changing the task and recording their entries together. If an outcome transaction fails, it changes nothing; `finish` can still check a completed worker result and record the task as done, without an uncertain-update state.

## Confirmations

Every confirmation has one form: the attempt identity, `fact`, `confirmedBy`, `confirmedAt` and `scope`. `confirmedBy` is always the trusted host's caller, never a request argument or display label. Supervisor acceptance requires passing exact-commit evidence; only a person can confirm a lease return or discard. Other [caller permissions and fixed limits](../../objectives.md#callers-and-permissions) apply inside operations too. Facts and scopes are:

- `output_accepted`: the exact commit.
- `no_processes`: the lease ID and one return's UUID. A later return needs a new confirmation.
- `discard`: the lease ID.
- `worker_stopped`: the lease ID and, when known, session ID.
- `lease_returned`: the output branch and, when known, lease ID.
- `owner_read_reconciled`: one `failureSequence`, the established `outcome` (`happened` or `not_happened`), and the return UUID when the failure followed a return intent.

Confirmation records, not old `acceptedBy` or `noProcessesConfirmedBy` entry fields, carry the caller's decision. A worker-stop confirmation is not an observed process exit, and neither proves that background processes are gone.

## Pruning

Pruning checks external owners before archiving. Its transaction compares the observed entries and confirmations, writes an archive summary, keeps the request record pointing to that summary, removes the attempt and its entries, and records runtime directories to delete. Retained attempt numbers never go away, so output-branch names are never reused. Directory deletion follows outside the transaction. The archive records `archivedBy` from its host caller. Its `cleanup` map, keyed by directory, keeps append-only cleanup evidence with its own sequences, times and `askedBy` callers: `deletion_started`, `owner_read_failed` (the same failure payload as live attempt entries), and `deletion_confirmed` with the directory and the uncertain failure sequences its observed absence settles. A read failure before any effect is retryable; one after archiving or a deletion intent requires reconciliation. A later prune reads the directory again. Absence completes pending deletion without repeating it; if an earlier deletion is uncertain and the directory still exists, prune refuses rather than repeating a potentially partial removal. The operator must inspect and remove that directory manually, then run prune again. Diagnostics remain in the archive after cleanup. There is no prune lock or stale lock to remove. Summaries live in `archived_attempts`, not archive files.

## Importing the old files

Stop every Switchboard process using the database, then run:

```text
switchboard import --attempts --config <config.json> --json
```

The database must already contain the tasks and must have no attempts, reservations or retained attempt numbers. The import refuses open attempts, workers that may still be running and fresh dispatcher heartbeats. It uses `VACUUM INTO` to make a unique staging copy, imports and compares entries, confirmations, reservations, numbers and archive summaries, rechecks the sources and settled state, then replaces the closed database. A failure removes its staging files; another run starts afresh. Keep all writers stopped throughout, including other imports.

The source paths are the old `attempts/<context hash>/<task hash>/<number>/<sequence>.json`, `request-ids/<context hash>/` and `archive/<context hash>/` under `runtimeRoot`. The import includes reservations without attempts and hidden `.<number>.pruned` markers. Old `task_recorded` entries gain the category their recorded hold reason ends with; old confirmation fields and runtime stop confirmations become scoped records. An unrecognisable category refuses import rather than guessing. Old files are never changed or removed by import. Worker result files, Pi session logs and artefacts stay at their recorded paths.

A database whose attempts were imported before runtime records moved into the database has attempts but no runtime records. For it, run `switchboard import --runtime --config <config.json> --json`, with every Switchboard process stopped as above. It refuses unless every attempt is settled, no worker may still be running, no dispatcher heartbeat is fresh and no control request was claimed without an answer, and it refuses a database that already has runtime records. Through a `VACUUM INTO` staging copy, compared with the files before the original is replaced, it records a launch row, the observed exit, the startup observation and any operator stop confirmation for each attempt's runtime directory. Old activity logs are not imported; they stay on disk.

The store is not protected from a malicious worker running as the same operating-system user.
