# SQLite trial

Evidence for [ADR-0007](../../docs/adr/0007-one-sqlite-database.md): Switchboard's tasks and attempt records in one SQLite database, through Node's built-in `node:sqlite`. The script builds a small version of the schema and checks the behaviour the ADR relies on. It is a trial, not Switchboard's implementation.

## Run

From the repository root, using PowerShell:

```powershell
node investigations/sqlite-trial/trial.ts
```

Each check prints `PASS` or `FAIL`, and the timings are printed last. The exit status is 1 if any check failed. CI runs it on every platform after the test suite. The databases are created under the ignored `.investigation/sqlite-trial/` folder; nothing else is touched.

## What it checks

- **Readiness** as one query: blocked, held and other-repository tasks are excluded, in order of position, and a blocked task becomes ready once its blocker is done. A self-dependency is refused.
- **Dispatch order.** Creating an attempt reserves its task without starting it, so a second dispatch does not take it. Starting the task after the lease is acquired checks readiness again, marks the task in flight and records it in one transaction.
- **No overwriting a newer decision.** Recording an outcome changes the task only if it is still in flight; a task the operator changed in the meantime is left as the operator set it.
- **Atomicity.** A failure partway through a transaction leaves no partial change.
- **The attempt maximum across processes.** Eight processes creating attempts at once, with a maximum of three, create exactly three, for different tasks.
- **Request IDs.** A request ID creates at most one attempt in a context.
- **Launch exclusion.** The dispatcher's permission to launch and a fence from `finish`, `discard` or `resolve` contend for one row per attempt: whichever is created first wins.
- **A process killed while holding the write lock.** Another process cannot write meanwhile; once the holder is killed, its change is gone and the next writer proceeds, with nothing to clean up.
- **Waiting without blocking.** With a zero busy timeout and an asynchronous retry, a process waiting for the write lock keeps running its timers, so heartbeats and stop requests would still be handled.

## Results

Recorded on 21 October 2026 on macOS 27.0.1 (Apple M1 Pro), Node.js 26.7.0, SQLite 3.53.4, with WAL, `synchronous = FULL` and `fullfsync` on:

- All 15 checks passed.
- 10,000 log entries written in one transaction in 33 ms, and read in 9.5 ms.
- One entry per transaction: 5.5 ms each.

On macOS, `fullfsync` makes SQLite flush with `F_FULLFSYNC`, which forces the drive's own cache to storage, as Node's `FileHandle.sync()` already does for the current file-based records. Without it, `FULL` took 0.1 ms per transaction, because plain `fsync` on macOS does not force the drive's cache. On Linux and Windows the setting has no effect.

In CI on 21 October 2026 ([run 39573208432](https://github.com/nickcox/switchboard/actions/runs/39573208432)), with Node.js 26.7.0, every check also passed on GitHub's `ubuntu-latest`, `windows-latest` and `macos-latest` runners, including the process killed while holding the write lock and the asynchronous retry:

| Runner | 10,000 entries written | Read | One entry per transaction |
| --- | --- | --- | --- |
| `ubuntu-latest` | 20 ms | 15.9 ms | 0.27 ms |
| `windows-latest` | 11 ms | 9.8 ms | 0.12 ms |
| `macos-latest` | 13 ms | 8.4 ms | 0.78 ms |

The runners' disks report a flush as complete sooner than the trial machine's, so their per-transaction times are not a guide to durability cost on a workstation.

## Concurrent opens on Windows

In CI the trial's eight-process check failed on Windows in two of three runs, with `disk I/O error` (`SQLITE_IOERR_TRUNCATE`, code 1546) while a process opened the database. `stress.ts` was written to find out why:

```powershell
node investigations/sqlite-trial/stress.ts 200
```

Each round creates a database, then starts eight processes at once that each open it and commit one row. Variants differ in whether WAL is set on every open or only when the database is created, whether memory mapping is off, whether SQLite's own busy timeout is used, whether an I/O error while opening is retried, and whether each process exits straight after committing without closing the database, as the trial's processes did and as a crashed process would. `STRESS_VARIANTS` (a comma-separated list) selects variants.

Results on GitHub's runners on 21 October 2026, Node.js 26.7.0:

- **Processes that close the database:** no failures in any variant on any platform (3,840 to 4,000 opens per variant and platform).
- **Processes that exit without closing it, on Windows:** 29 of 1,600 opens failed with code 1546 when WAL was set on every open, and 31 of 1,600 when it was set only once; 12 and 8 of 800 in an earlier run, with and without SQLite's busy timeout. With the error retried while opening, 0 of 1,600 failed, whether WAL was set on every open or once.
- **Linux and macOS:** no failures in any variant.
- **No reported commit was ever missing.**

So on Windows, a process that exits without closing the database can briefly leave SQLite's shared-memory file in a state in which another process's open fails; a fresh attempt a moment later succeeds. Switchboard's `Database.open` therefore retries this error while opening, within the same time as a busy database, and closes the database when a command exits. `tests/database.test.ts` checks it with the real `Database.open`, and the trial's processes retry the same way.
