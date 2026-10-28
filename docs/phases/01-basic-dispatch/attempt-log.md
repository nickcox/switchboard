# Attempt records

Status: commands use `src/attempts/store.ts`, under [ADR-0007](../../adr/0007-one-sqlite-database.md). `src/attempts/log.ts` retains only the legacy file reader for import; commands never use it for storage. `src/attempts/prune.ts` retains only the legacy reservation and archive schemas, with no file writer, lock or pruning operations.

Attempts link tasks, leases, sessions, commits and outcomes. Tasks and attempts share the configured SQLite database, normally `<runtimeRoot>/switchboard.db`, outside every recyclable workspace. Treehouse still owns leases, and runtime observations still decide whether a worker may be running.

## Database records

Schema version 6 holds attempts, entries, separate request records, retained attempt numbers, confirmations, archive summaries, pending directory deletions, runtime records and attempt specifications. Opening an older database migrates it automatically. Version 3 removed the task's obsolete `started_body` snapshot; outcomes leave the current task body untouched, so no splicing is needed to preserve operator edits. Attempt numbers are unique within a context and task; entry sequences start at zero and have no gaps. Request IDs are unique within a context and never expire. Each new request record stores a versioned fingerprint of explicit selection inputs and the selected attempt; archiving switches it to the archived summary. A reservation imported without an attempt has a null attempt number and still prevents reuse of its request ID. Historical requests with unknown explicit inputs remain excluded, and conflicting historical mappings refuse migration. See the [request-record contract](../../task-store.md#request-records-and-pruning).

Each immutable entry has `version: 1`, `contextId`, `taskId`, `attempt`, `sequence`, `kind`, `recordedAt` (an ISO time) and validated `data`. Database references enforce ownership, and a trigger refuses entry updates. Corrections are new entries.

| Kind | Data |
| --- | --- |
| `requested` | Optional `requestId`, the acquisition `pool`, and the resolved delivery `contract` |
| `leased` | `leaseId`, `workspace`, `baseRef`, `outputBranch`, `startingCommit`, and acquisition `pool` |
| `task_started` | No fields |
| `launched` | `sessionId` |
| `operator_request` | Request `id`, `kind`, `sender`, `outcome`, optional `message` and `error` |
| `worker_finished` | Runtime `status`, `runtimeDirectory`, optional `reason`, `detail`, `outcome` and `resultCommit` |
| `retention_checked` | `retained`, `findings` and `notes` |
| `task_recorded` | `outcome` (`done` or `hold`), `reason`, explicit `category`, and `applied` |
| `halted` | `stage`, `reason`, optional `detail` and recovered lease identity |
| `operator_resolved` | `action` (`worker_stopped` or `lease_returned`), optional `note` |
| `output_accepted` | Exact accepted `commit` |
| `integrated` | `policy: local-merge`, `targetBranch` and `commit` |
| `discarded` | Optional `note` |
| `lease_return_started`, `lease_returned` | `leaseId`, `by` (`finish` or `discard`) and the return's unique `returnId` |

Outcome categories are `done`, `review_required`, `not_retained`, `held_by_worker`, `failed`, `interrupted` and `over_budget`. Classification reads the category, never a category inferred from a hold reason. Task instructions are not changed to carry attempt evidence; the result and attempt records retain it.

## Transaction boundaries

Every write starts with `BEGIN IMMEDIATE`. SQLite uses WAL, `synchronous = FULL`, `fullfsync` and a zero busy timeout. Writers retry busy transactions asynchronously up to `databaseRetryMs`; a timeout changes nothing. No transaction calls Git, Treehouse, GitHub or a worker. Each command closes its database before exit.

Dispatch checks capacity, readiness and task exclusion while reserving the attempt, its number, first entry and request ID in one transaction. The task stays queued. Lease acquisition follows outside the transaction. A second transaction checks readiness again, starts the task and records `task_started`. Refused or uncertain lease acquisition leaves the task queued. No separate task-store operation can start a task. `status` still reports an in-flight task with no attempt, worker or lease because the legacy task import can preserve that state without attempt files.

Recording an outcome writes `task_recorded` and closes the attempt in the same transaction as its task change. The task changes only if it is still in flight and has not been held since starting, including a hold subsequently released. Otherwise `applied: false` records the disagreement and preserves the operator's decision. `finish` and `discard` compare the expected task state, hold and hold revision before changing the task and recording their entries together. If an outcome transaction fails, it changes nothing; `finish` can still check a completed worker result and record the task as done, without an uncertain-update state.

## Confirmations

Every operator confirmation has one form: the attempt identity, `fact`, `confirmedBy`, `confirmedAt` and `scope`. Facts and scopes are:

- `output_accepted`: the exact commit.
- `no_processes`: the lease ID and one return's UUID. A later return needs a new confirmation.
- `discard`: the lease ID.
- `worker_stopped`: the lease ID and, when known, session ID.
- `lease_returned`: the output branch and, when known, lease ID.

The CLI flags are unchanged. Confirmation records, not old `acceptedBy` or `noProcessesConfirmedBy` entry fields, carry the operator's decision. A worker-stop confirmation is not an observed process exit, and neither proves that background processes are gone.

## Pruning

Pruning checks external owners before archiving. Its transaction compares the observed entries and confirmations, writes an archive summary, keeps the request record pointing to that summary, removes the attempt and its entries, and records runtime directories to delete. Retained attempt numbers never go away, so output-branch names are never reused. Directory deletion follows outside the transaction; a later prune completes pending deletion. There is no prune lock or stale lock to remove. Summaries live in `archived_attempts`, not archive files.

## Importing the old files

Stop every Switchboard process using the database, then run:

```text
switchboard import --attempts --config <config.json> --json
```

The database must already contain the tasks and must have no attempts, reservations or retained attempt numbers. The import refuses open attempts, workers that may still be running and fresh dispatcher heartbeats. It uses `VACUUM INTO` to make a unique staging copy, imports and compares entries, confirmations, reservations, numbers and archive summaries, rechecks the sources and settled state, then replaces the closed database. A failure removes its staging files; another run starts afresh. Keep all writers stopped throughout, including other imports.

The source paths are the old `attempts/<context hash>/<task hash>/<number>/<sequence>.json`, `request-ids/<context hash>/` and `archive/<context hash>/` under `runtimeRoot`. The import includes reservations without attempts and hidden `.<number>.pruned` markers. Old `task_recorded` entries gain the category their recorded hold reason ends with; old confirmation fields and runtime stop confirmations become scoped records. An unrecognisable category refuses import rather than guessing. Old files are never changed or removed by import. Worker result files, Pi session logs and artefacts stay at their recorded paths.

A database whose attempts were imported before runtime records moved into the database has attempts but no runtime records. For it, run `switchboard import --runtime --config <config.json> --json`, with every Switchboard process stopped as above. It refuses unless every attempt is settled, no worker may still be running, no dispatcher heartbeat is fresh and no control request was claimed without an answer, and it refuses a database that already has runtime records. Through a `VACUUM INTO` staging copy, compared with the files before the original is replaced, it records a launch row, the observed exit, the startup observation and any operator stop confirmation for each attempt's runtime directory. Old activity logs are not imported; they stay on disk.

The store is not protected from a malicious worker running as the same operating-system user.
