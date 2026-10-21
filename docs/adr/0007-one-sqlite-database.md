# ADR-0007: Switchboard keeps its tasks and records in one SQLite database

Status: accepted on 21 October 2026, and revised the same day after review; not yet implemented. Supersedes [ADR-0001](0001-tasks-axi-is-task-source-of-truth.md) and [ADR-0006](0006-switchboard-attempt-log.md).

## Context

Simplicity of the whole system is the deciding criterion: the amount of code, and the number of separate programs, stores and records that must agree. At the end of Phase 2, Switchboard depends on four external programs (tasks-axi, Treehouse, Git and Pi) and keeps its own state in several kinds of file: the attempt log as one file per entry, request-ID reservation files, the prune lock, stop and steer request files with claim files, and the runtime records. Tasks live in a separate markdown backlog with its own lock file.

Three kinds of complexity follow from that:

- **Tasks and attempts can disagree.** Starting a task and recording its start, or recording an outcome and its log entry, are changes to two stores. Each is read back after a write that may have applied without confirmation, and the gaps have their own handling: the "task update unconfirmed" state, the finding for a task in flight with no attempt, worker or lease, the hold made of three writes, and copying the attempt's summary into the task body.
- **The same mechanism is implemented several times on files.** Exclusive creation, owner records, staleness and clean-up by hand appear in the attempt log, the reservations, the prune lock, the request claims and the runtime directory. The Phase 3 PRD would add a context lock and a dispatcher claim.
- **Reading many small files is slow,** and starting tasks-axi as a separate process for every task-store call is slower. The test suite starts it about 2,700 times, which accounts for most of the time Windows CI takes.

A search on 21 October 2026 established no suitable JavaScript or TypeScript library for storing tasks with dependencies and holds that several processes can change safely, in the same database as Switchboard's other records. It found job queues with retries, workflow engines that replay code, graphs of async functions within one process, and issue trackers that are separate programs. `hzl-core`, found afterwards, is considered under [Alternatives](#alternatives-considered).

A [trial](../../investigations/sqlite-trial/README.md) with Node's built-in `node:sqlite` passed every check, including readiness as one query, the dispatch order below, eight processes creating attempts at once against a maximum of three creating exactly three, launch exclusion, and a process killed while holding the write lock leaving no change and no lock behind. Its script and recorded environment are in `investigations/sqlite-trial/`.

## Decision

Switchboard keeps its tasks and its own records in one SQLite database, opened with `node:sqlite`. The database is under the configured runtime root, outside every workspace, on a local filesystem. Every use of `node:sqlite` is behind one controlled storage boundary, which may span several source files. The boundary offers the transactional operations Switchboard needs, such as reserving an attempt, starting a reserved task, recording an outcome, claiming a request and archiving an attempt, not generic save and load functions that callers would have to combine correctly. Database constraints enforce uniqueness and references: request IDs within a context, attempt numbers within a task, sequence numbers within an attempt, one launch row per attempt, and one winner for a request's claim or withdrawal. Readiness, acceptance, retention and whether a lease can be returned stay in domain code.

**What the database holds:**

- **Tasks:** ID, title, body, repository, kind, state (`queued`, `in_flight` or `done`), hold reason, position in the order of work, and the tasks each one is blocked by. Switchboard now owns these rules, so they are specified, with what tasks-axi left implicit, in the [task-store contract](../task-store.md). Readiness is unchanged from tasks-axi: a task is ready when it is queued, not held, and every task it is blocked by is done, and ready tasks are taken in order of position.
- **Attempts and their log entries,** with the same meaning as ADR-0006: an attempt's entries are inserted and never changed, and the log records which task, lease, session, commits and outcome belong together.
- **Request-ID reservations,** unique within a context, including any whose attempt was never created.
- **What a dispatcher records about the workers it supervises:** the launch binding, the dispatcher heartbeat, the observed exit or the operator's confirmation that the worker stopped, activity events, and stop and steer requests with their claims and results.
- **The operator's confirmations,** each recorded in one form: the fact confirmed, the attempt, who confirmed it, when, and its scope, such as the commit for accepted output. A confirmation applies only to what it names.
- **Launch rows and claims,** described below.

**What stays a file:** only what the worker or Pi writes itself: the worker's result file, Pi's session logs and the worker's artefacts, in each attempt's runtime directory. The database records their paths.

**Durability.** The database uses WAL with `synchronous = FULL`, so every commit is flushed to storage before it returns, and `fullfsync` on, so that on macOS the flush forces the drive's own cache, as Node's `FileHandle.sync()` already does for the current file-based records. Losing a recently committed attempt, reservation or task change while its external effect (a lease, a launched worker) survives would undermine deduplication and recovery, so nothing weaker is acceptable. A commit takes about 5.5 ms on the trial machine, which Switchboard's write rate can afford.

**Dispatch keeps its order.** Moving to a database does not change when a task starts:

1. In one transaction, dispatch checks capacity and eligibility, then creates the attempt, its first entry and its request-ID reservation. The open attempt reserves the task, so no other dispatch takes it, but the task stays queued.
2. Dispatch acquires the lease, outside any transaction.
3. In one transaction, dispatch checks readiness again, marks the task in flight and records `task_started`.
4. Dispatch launches the worker.

A refused or uncertain acquisition therefore leaves the task queued, with the refusal or the unknown lease recorded in the attempt, as in Phase 1 and Phase 2.

**Transactions replace short locks.** A change that touches several records is one transaction, and no transaction includes a call to Git, Treehouse, GitHub or the worker. Every write transaction starts with `BEGIN IMMEDIATE`. When a process dies, SQLite rolls back its unfinished transaction and releases its lock, so a short lock can never be left behind. The Phase 3 attempt maximum is enforced inside the transaction in step 1, with no separate lock.

**Waiting for the write lock.** `node:sqlite` is synchronous, so a busy timeout would block the waiting process's event loop, delaying its heartbeats and its handling of stop requests. Switchboard therefore opens the database with a busy timeout of zero and retries a busy transaction asynchronously, for up to a configured time. If the database is still busy after that, the operation is refused with a stable reason code and changes nothing.

**Launch exclusion.** Today, a worker's runtime directory, created exclusively, both lets a dispatcher launch and lets `finish`, `discard` or `resolve --worker-stopped` stop a pending launch by creating the directory first. The database keeps that guarantee explicitly:

- Each attempt has exactly one launch row, keyed by the attempt. A dispatcher creates it as permission to launch; `finish`, `discard` or `resolve` creates it as a fence. Both insert into the same key, so exactly one succeeds, and a dispatcher launches only after its insert succeeds.
- A launch row is never removed or changed while its attempt exists. Releasing a claim, a stale heartbeat, or the operator's confirmation that a worker stopped does not remove it.

**Claims.** A process that owns something for longer than one transaction, such as a dispatcher supervising a worker or the Phase 3 background dispatcher, holds a claim: a row with an ID generated for it, its owner's process ID and start time, and a heartbeat refreshed every five seconds. Requests, such as stop and steer, are addressed to a claim by its ID, never to a process ID or a context. A claim with a stale heartbeat is reported for the operator to resolve and is never taken over automatically.

**Pruning.** `prune` removes an attempt's rows and its reservation, writes its archive summary, and records the directories to delete, in one transaction. It then deletes those directories, which cannot be part of a transaction, and removes each record once its directory is gone. A later run finishes any deletion left over. The attempt numbers of pruned attempts remain recorded, so attempt numbers and output-branch names are never reused.

**Operators and agents manage tasks through Switchboard.** `switchboard task` commands cover what the tasks-axi command is used for today: add, show, list, ready, change the title, body, repository or kind, hold and release, block and unblock, record as done and reopen, each with `--json`. The supervisor in Phase 4 uses the same operations.

**Moving existing work.** An import moves an existing tasks-axi backlog and Switchboard's file-based records into a new database:

- **Only when settled.** The import refuses unless no Switchboard process is running for the context and every attempt is settled: none running, possibly running or unfinished. Then no worker, pending launch or claimed but unanswered control request needs moving.
- **What it moves:** every task with its state, hold, dependencies and order, read with tasks-axi's own parser used as a library; every attempt and its entries; launch bindings, observed exits and the operator's stop confirmations; request-ID reservations, including any without an attempt; the attempt numbers of pruned attempts and their archive summaries; and the paths of result files, Pi session logs and artefacts, which stay where they are.
- **Into a new file, validated before use.** The import writes a new database file and compares it with the old records: task count and readiness, and each attempt's entries and state. Only then is the new file activated. Running the import again replaces a file that has not been activated.
- **The old data is kept.** The import never changes or removes the old backlog or files. The operator removes them once satisfied.

- **Old records are converted once.** The import converts older forms to the current schema, for example writing an explicit outcome category where an older `task_recorded` entry has only a hold reason, and normalising old paths and runtime records. The rest of Switchboard reads only the current schema, so no compatibility code remains outside the import.

After the import, Switchboard no longer depends on tasks-axi or on `@toon-format/toon`.

**Unchanged:** Treehouse owns leases ([ADR-0002](0002-treehouse-owns-workspace-leases.md)), Pi is the worker runtime ([ADR-0005](0005-pi-rpc-worker-and-result-file.md)), and every safety rule about returning leases and worker processes still holds. Leases are still a separate owner, so attempts and leases can still disagree, and that reconciliation stays.

## Consequences

- **Fewer moving parts.** The external programs are Treehouse, Git and Pi. Switchboard's state is one database plus the files workers write.
- **Code that goes:** the tasks-axi adapter and its output decoding; the file mechanics of the attempt log, reservations, prune and request files; the prune lock; and the handling of a task update that could not be confirmed, in `dispatch`, `finish`, `discard`, `status` and the state classification. The attempt summary no longer needs copying into the task body, because `status` reads it from the attempt.
- **Code that is added:** the database module and schema, the `task` commands, and the import.
- **Principles 1, 3, 5 and 8 are reworded.** Switchboard becomes the owner of work and readiness (1). Tasks are a fact Switchboard now holds, alongside attempts (3). Changes within the database are atomic, so compensation is needed only across Switchboard, Treehouse and the runtime (5). The task store remains an interface, and this database is its implementation (8).
- **The Phase 3 PRD changes.** Its shared mechanisms become transactions, launch rows, claim rows and request rows. The Pi Durable comparison's first limit still holds: the ready order of project tasks is not a queue of dispatch requests, and Pi Durable's tasks do not model project work ([ADR-0003](0003-pi-durable-for-durable-orchestration.md)).
- **`node:sqlite` is at stability 1.2, release candidate, in Node 26.7,** so its interface may change. The Node version is pinned, the database code is kept in one module, and `better-sqlite3`, a native module, is the fallback.
- **The database must be on a local filesystem.** SQLite's locking cannot be relied on over network or synced folders. The runtime root already has this requirement.
- **The records are no longer plain files.** `status --json` and an export command replace reading them with `cat`.
- **Not protected from a malicious worker,** as before: a worker running as the same user could open the database, just as it could edit the files.

## Alternatives considered

- **tasks-axi as a library instead of a separate process.** Removes the process starts and keeps tasks-axi's rules, but keeps two stores that can disagree and every file mechanism.
- **SQLite for Switchboard's records only, with tasks staying in tasks-axi.** Removes the file mechanisms but keeps tasks and attempts in separate stores.
- **`hzl-core` 3.2.0** (MIT), a TypeScript task ledger for coding agents with dependencies and atomic claiming, stored in SQLite through `libsql`. Not adopted, without a full assessment: it adds a compiled native dependency, an event store with projections, and a claim model with expiry that differs from Switchboard's; and its tasks could share transactions with Switchboard's attempt records only if Switchboard built on its connection and schema.
- **Another existing library or tracker.** None suitable was established; see Context. The Phase 1 assessments of `br` and tasks.md found neither ready to adopt.
- **`better-sqlite3` now.** A mature native module, but it adds a compiled dependency on every platform, while `node:sqlite` is built into the pinned Node version.
- **`synchronous = NORMAL`.** Faster, but a commit may be lost on power failure after its external effect has happened. Rejected; see Durability.

See [architecture](../architecture.md), [principles](../principles.md) and the [task-store contract](../task-store.md).
