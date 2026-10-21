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

Not yet run on Linux or Windows.
