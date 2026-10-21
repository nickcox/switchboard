# ADR-0007: Switchboard keeps its tasks and records in one SQLite database

Status: accepted on 21 October 2026; not yet implemented. Supersedes [ADR-0001](0001-tasks-axi-is-task-source-of-truth.md) and [ADR-0006](0006-switchboard-attempt-log.md).

## Context

Simplicity of the whole system is the deciding criterion: the amount of code, and the number of separate programs, stores and records that must agree. At the end of Phase 2, Switchboard depends on four external programs (tasks-axi, Treehouse, Git and Pi) and keeps its own state in several kinds of file: the attempt log as one file per entry, request-ID reservation files, the prune lock, stop and steer request files with claim files, and the runtime records. Tasks live in a separate markdown backlog with its own lock file.

Three kinds of complexity follow from that:

- **Tasks and attempts can disagree.** Starting a task and creating its attempt, or recording an outcome and its log entry, are changes to two stores. Each is read back after a write that may have applied without confirmation, and the gaps have their own handling: the "task update unconfirmed" state, the finding for a task in flight with no attempt, worker or lease, the hold made of three writes, and copying the attempt's summary into the task body.
- **The same mechanism is implemented several times on files.** Exclusive creation, owner records, staleness and clean-up by hand appear in the attempt log, the reservations, the prune lock, the request claims and the runtime directory. The Phase 3 PRD would add a context lock and a dispatcher claim.
- **Reading many small files is slow,** and starting tasks-axi as a separate process for every task-store call is slower. The test suite starts it about 2,700 times, which accounts for most of the time Windows CI takes.

A search on 21 October 2026 found no JavaScript or TypeScript library that stores tasks with dependencies and holds and is safe to change from several processes. The libraries found were job queues with retries, workflow engines that replay code, graphs of async functions in one process, and issue trackers that are separate programs. A trial with Node's built-in `node:sqlite` passed every check: readiness as one query, dispatch and outcome recording as single transactions, eight processes dispatching at once against a maximum of three starting exactly three attempts, a process killed while holding the write lock leaving no change and no lock behind, and 10,000 log entries read in 12.5 ms.

## Decision

Switchboard keeps its tasks and its own records in one SQLite database, opened with `node:sqlite` in WAL mode with a busy timeout. The database is under the configured runtime root, outside every workspace, on a local filesystem.

**What the database holds:**

- **Tasks:** ID, title, body, repository, kind, state (`queued`, `in_flight` or `done`), hold reason, position in the order of work, and the tasks each one is blocked by. A task is ready when it is queued, not held, and every task it is blocked by is done. Ready tasks are taken in order of position. These are tasks-axi's rules, unchanged.
- **Attempts and their log entries,** with the same meaning as ADR-0006: an attempt's entries are appended and never edited, and the log records which task, lease, session, commits and outcome belong together. `prune` still removes only whole finished attempts, after archiving a summary.
- **Request-ID reservations,** as a unique column of the attempt.
- **What a dispatcher writes about the workers it supervises:** the launch binding, the dispatcher heartbeat, the observed or confirmed exit, activity events, and stop and steer requests with their claims and results.
- **Claims held by long-running processes,** such as the Phase 3 background dispatcher, as rows with an owner and a heartbeat.

**What stays a file:** only what the worker or Pi writes itself: the worker's result file, Pi's session logs and the worker's artefacts, in each attempt's runtime directory.

**Transactions replace locks.** A change that touches tasks and attempts together is one transaction: for example, dispatch counts active attempts, selects a task, creates the attempt and its first entry and starts the task in one transaction, so the Phase 3 attempt maximum needs no separate lock. Every write transaction starts with `BEGIN IMMEDIATE`, so concurrent writers wait in turn instead of failing partway. When a process dies, SQLite rolls back its unfinished transaction and releases its lock, so a short lock can never be left behind. A claim held for longer than one transaction, such as the background dispatcher's, is a row with a heartbeat, and a stale heartbeat is still reported for the operator to resolve, never taken over automatically.

**Operators and agents manage tasks through Switchboard.** `switchboard task` commands cover what the tasks-axi command is used for today: add, show, list, ready, change the title, body, repository or kind, hold and release, block and unblock, record as done and reopen, each with `--json`. The supervisor in Phase 4 uses the same operations.

**Moving existing work.** A one-off import reads an existing tasks-axi backlog, using tasks-axi's own parser as a library, and an existing file-based attempt log, and writes both into the database. After the import, Switchboard no longer depends on tasks-axi or on `@toon-format/toon`.

**Unchanged:** Treehouse owns leases ([ADR-0002](0002-treehouse-owns-workspace-leases.md)), Pi is the worker runtime ([ADR-0005](0005-pi-rpc-worker-and-result-file.md)), and every safety rule about returning leases and worker processes still holds. Leases are still a separate owner, so attempts and leases can still disagree, and that reconciliation stays.

## Consequences

- **Fewer moving parts.** The external programs are Treehouse, Git and Pi. Switchboard's state is one database plus the files workers write.
- **Code that goes:** the tasks-axi adapter and its output decoding; the file mechanics of the attempt log, reservations, prune and request files; the prune lock; and the handling of a task update that could not be confirmed, in `dispatch`, `finish`, `discard`, `status` and the state classification. The attempt summary no longer needs copying into the task body, because `status` reads it from the attempt.
- **Code that is added:** the database module and schema, the `task` commands, and the import.
- **Principles 1, 3, 5 and 8 are reworded.** Switchboard becomes the owner of work and readiness (1). Tasks are a fact Switchboard now holds, alongside attempts (3). Changes within the database are atomic, so compensation is needed only across Switchboard, Treehouse and the runtime (5). The task store remains an interface, and this database is its implementation (8).
- **The Phase 3 PRD changes.** "Exclusive claims" and "one context lock" become transactions and claim rows, and "requests to a running process" becomes request rows. The Pi Durable comparison's first limit still holds: the ready order of project tasks is not a queue of dispatch requests, and Pi Durable's tasks do not model project work ([ADR-0003](0003-pi-durable-for-durable-orchestration.md)).
- **`node:sqlite` is at stability 1.2, release candidate, in Node 26.7,** so its interface may change. The Node version is pinned, the database code is kept in one module, and `better-sqlite3`, a native module, is the fallback.
- **The database must be on a local filesystem.** SQLite's locking cannot be relied on over network or synced folders. The runtime root already has this requirement.
- **Durability matches today's files.** WAL with `synchronous = NORMAL` keeps every commit through a process crash; the newest commits may be lost on power failure. The current files are not flushed with `fsync` either.
- **The records are no longer plain files.** `status --json` and an export command replace reading them with `cat`.
- **Not protected from a malicious worker,** as before: a worker running as the same user could open the database, just as it could edit the files.

## Alternatives considered

- **tasks-axi as a library instead of a separate process.** Removes the process starts and keeps tasks-axi's rules, but keeps two stores that can disagree and every file mechanism.
- **SQLite for Switchboard's records only, with tasks staying in tasks-axi.** Removes the file mechanisms but keeps tasks and attempts in separate stores.
- **An existing library or tracker.** None found that fits; see Context. The Phase 1 assessments of `br` and tasks.md found neither ready to adopt.
- **`better-sqlite3` now.** A mature native module, but it adds a compiled dependency on every platform, while `node:sqlite` is built into the pinned Node version.

See [architecture](../architecture.md) and [principles](../principles.md).
