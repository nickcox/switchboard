# Configuration

`--config <path>` selects a JSON configuration file. Otherwise Switchboard uses `$SWITCHBOARD_CONFIG`, then `./switchboard.json`. Every configured path is absolute. The [README example](../README.md#running-it) shows the repository, delivery and worker settings.

## Tasks and database

- `runtimeRoot`: retained local storage outside every Treehouse workspace, holding runtime records and, by default, `switchboard.db`.
- `databasePath`: optional absolute override for the database file, also outside every recyclable workspace. Contexts sharing this path share task IDs and order.
- `databaseRetryMs`: how long a writer retries a busy database asynchronously, default 5000 milliseconds. Zero refuses immediately. Refusals use the stable `busy` reason and apply no change.
- `maxAttempts`: maximum open attempts in this context, default 1. Dispatch enforces capacity and task readiness inside the reservation transaction. An attempt stops counting when it records an outcome, halts or is resolved. A possibly running worker with a fresh dispatcher heartbeat (less than 30 seconds old) blocks only its own task and counts towards this maximum. A missing, unreadable, stale or future heartbeat blocks dispatch for the whole context until the operator confirms the worker stopped with `resolve --worker-stopped`. A launch logged before its runtime launch row exists blocks only its own task.
- `maxAttemptsPerTask`: maximum lifetime reservations for one task across all contexts sharing the database, default 3. This is separate from concurrent context capacity (`maxAttempts`). Ordinary dispatch and reservations starting from earlier output check it inside the reservation transaction. Halting, discarding, returning a lease or pruning does not restore an attempt. Replaying a request ID still returns its original reservation at the limit. Review earlier attempts before increasing this setting; it does not authorise automatic retries.
- `tasks.repo`: repository used to select ready and in-flight tasks. Task commands accept `--repo` to override it. Reading a named task is database-wide.

The old `tasks.file` setting is removed. Switchboard never silently reads a backlog instead of the database. The database uses Node.js 26.7's built-in SQLite, WAL, `synchronous = FULL`, `fullfsync` and a zero busy timeout. Every write transaction starts with `BEGIN IMMEDIATE`. The current schema is version 9: it holds tasks and dependencies, acceptance criteria, attempts and entries, scoped confirmations, durable request records, archives, pending deletions, retained attempt numbers, runtime records, immutable attempt specifications, validated results and review-task targets. Older schemas migrate automatically on opening. Worker result files, Pi sessions and artefacts remain separate.

Use local storage, not network or synced folders. Switchboard probes exclusive creation in the database's directory and refuses linked or non-canonical paths. Do not copy an open database without its WAL; stop Switchboard first or use SQLite backup tooling. Restoring a backup is not an ordinary restart: [ADR-0007 requires dispatch to stay fenced until application identities and external owners have been reconciled](adr/0007-one-sqlite-database.md#decision). A full operator disaster-recovery procedure is still required.

## Provider availability

Loading configuration validates its shape without opening providers. Task commands open only the database. Other inspection and finalisation commands read external owners only when needed – a missing Git or Treehouse executable leaves the affected observations unknown, without hiding local task or runtime records. Unknown evidence never permits a change.

`status`, `finish` and `discard` do not open Pi or check its installation. Only dispatch checks the Pi entrypoint and opens the workspace provider eagerly, including for a dry run, before reserving an attempt or request ID. Commands close their database on success or failure, including a failure while opening a later provider.

## Output checks

`checks` is an optional top-level array, empty by default. Each entry has a unique nonempty `name`, a nonempty `command` array (the executable followed by its arguments), and a positive integer `timeoutMs` no greater than 2147483647. Configuration loading rejects invalid entries and duplicate names.

```json
{
  "checks": [
    { "name": "types", "command": ["npm", "run", "check"], "timeoutMs": 120000 },
    { "name": "tests", "command": ["npm", "test"], "timeoutMs": 300000 }
  ]
}
```

Before accepting output, `finish` runs these commands sequentially in the attempt's workspace, without a shell or stdin, using the operator's environment (not `worker.environment`). Executables can be absolute paths or found on `PATH`. Shell syntax is passed literally; on Windows, choose an executable that can be started without a shell. Checks run only after the worker's exit was observed or its stop confirmed, with a clean workspace whose HEAD is the exact commit being accepted. Uncommitted and untracked files refuse finish without starting checks; ignored files are allowed. The same input is checked again between commands and before acceptance, so checks that change tracked files, create untracked files or move HEAD prevent acceptance. A dry run checks the input but runs no commands and records no check results.

Each completed command appends an immutable attempt fact: name, exact commit, exit code (null for a signal), whether its time limit was reached, duration in milliseconds, and the last 2000 characters of each output stream. Output and failure diagnostics use the same credential redaction as failed owner reads. `status` and `finish`, in text and JSON, show the latest result for the output commit, with failed or not-run checks and their output highlighted. The records survive later commits; a passing result for the exact commit is reused by name, while failed and not-run checks are tried again on the next finish. Checks for another commit always run again.

**Checks are advisory for the operator.** A nonzero exit or a time limit does not refuse finish: acceptance, integration and task recording continue. A command that cannot start or whose result cannot be read is recorded as `not_run`, with owner-read diagnostics, and is advisory too. It does not establish an uncertain acceptance or integration effect. A later finish retries it while the workspace lease is retained. Returning the lease does not prove that descendants started by a check have stopped; `--no-processes` still requires the operator's confirmation. Current context configuration supplies the checks, not the worker's reported test evidence. Independent review is recorded separately; the acceptance evidence check below is mandatory for a supervisor caller.

## Independent review

A review uses the existing task kind and delivery-contract selection, not a separate runtime. Configure its contract explicitly, for example:

```json
{
  "delivery": {
    "baseRef": "main",
    "byTaskKind": {
      "review": {
        "kind": "artefact",
        "acceptance": "independent_deliverable",
        "requiredDeliverables": ["report"]
      }
    }
  }
}
```

`review --task <id> [--attempt <n>]` creates a queued review task (latest attempt by default), with the source attempt's stored criteria and instructions. It refuses without a configured review contract, recorded retained output or a stopped source worker. Dispatch the returned task ID as usual; context capacity and the per-task attempt limit still apply. The source lease can stay retained. A manually added task of kind `review` still uses its configured contract, but is not linked to another attempt and produces no review record against one.

The review task's target is immutable and scoped to this context. Reservation copies it into the attempt specification and rechecks the source and retained commit. Dispatch uses the same exact starting-commit support as continuations, with a separate worker session. A result must report every criterion and a Git work reference named `reviewed-output` with the exact source branch and commit, as well as the review contract's evidence and deliverables. Findings are recorded against the source in the review outcome transaction; all criteria must be met and the completed review's deliverables retained for a `passed` verdict. An invalid or missing result provides no review record. A changed recorded output cannot receive findings for the old commit. A missing or archived source refuses creation or dispatch; keep its records until review completes.

`status` shows the reviews matching the attempt's recorded output commit. A review is another worker's judgement, not proof, and neither it nor configured checks automatically accepts or integrates the source output.

### Acceptance evidence and repair

`status` and `finish` report `acceptanceEvidence` in JSON: the exact `commit`, when recorded, and a `permission` with `allowed`, or a refusal's `reason`, `detail`, `nextAction` and `evidence`. Text output says whether acceptance evidence is sufficient. A supervisor caller must pass the safety check `checkAcceptanceEvidence` before acceptance: every currently configured check must have a latest recorded result of `passed` for that exact commit, and the latest review of that commit must have passed. With no checks configured, a passed review is still required. A missing commit, missing or failed check, or missing or failed review gives insufficient evidence. Worker-reported test claims are not a substitute. Evidence for an earlier commit never applies to a later commit, including a rebase, even if its tree is unchanged. Other safety checks still decide whether the worker stopped, output is retained and integration is permitted.

This report is advisory for a person: ordinary `finish` and explicit `finish --accept-output` keep their existing acceptance behaviour. It is enforced inside the operation for a supervisor, in addition to the objective's permissions and the other safety checks. A dry run reports only recorded evidence, not a prediction that planned checks will pass. After running checks, finish reports the updated evidence for the commit it is accepting.

After a failed review, release the source task's hold (or reopen it if done), then request `dispatch --once --task <source-task-id> --from-attempt <source-attempt-number> --note "Repair the review findings"`. Dispatch starts a separate attempt at the exact recorded, reviewed commit, not a later source branch head. The handover includes recorded reviews and latest check results for that commit, including findings, exit statuses and output, alongside the earlier worker's summary, criterion report and evidence. It does not copy the earlier attempt's whole log or findings and checks for other commits. A changed recorded output needs its own review; a continuation always starts from the source's current recorded output. No repair is started automatically, and the existing readiness, stopped-worker, retention and attempt-limit checks still apply.

## Keeping the computer awake

`keepAwake` is a top-level setting, enabled by default:

- `true`: run the platform's default command while a worker runs. macOS uses `caffeinate -i -w {pid}`, preventing idle sleep on battery and mains power. Linux uses `systemd-inhibit --what=idle:sleep --why="Switchboard worker running"` with a command that waits for the dispatcher to exit. Windows uses PowerShell's `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` and waits for the dispatcher to exit.
- `false`: do not start a keep-awake command.
- `{ "command": ["program", "arg", "{pid}"] }`: run an operator-supplied command instead. The nonempty array gives the program and its arguments, without shell interpretation. Programs can be absolute paths or found on the dispatcher's `PATH`; the command inherits the dispatcher's environment, not `worker.environment`. Every `{pid}` occurrence is replaced with the dispatcher's process ID.

A custom command must keep running until stopped, hold its power assertion for that whole time, and exit when `{pid}` exits so a crashed dispatcher cannot leave the computer awake. Switchboard stops it when the worker finishes, including failed launches, interruptions and exceeded limits, with a normal termination signal on macOS and Linux or by ending its process tree on Windows.

If the command cannot start or exits early, dispatch continues. The attempt's activity records a warning that the computer may sleep, together with the command's output. Linux requires `systemd-inhibit` and permission to take an inhibitor; hosts without them warn rather than refuse work. The command prevents idle system sleep, not display sleep. **Closing a laptop's lid can still put it to sleep and suspend workers.** Sleep is not evidence that workers have exited; they may continue after waking. It does not protect against explicit sleep, shutdown or loss of power.

## Tasks-axi import

Run `switchboard import --tasks-axi <backlog.md> [--archive <done-archive.md>] --config <config.json> --json` once, before any other command creates the database. The default archive is `done-archive.md` beside the backlog. The import reads both files through tasks-axi 0.2.6's `MarkdownStore.list` and keeps task order, state, hold reason and dependencies. It reports dependencies on missing tasks, which it drops, and holds with a date, which it converts: one still in force becomes an ordinary hold, and one whose date has passed is dropped. It compares every stored field, the count and the ready list with the source before activating the file. Duplicate IDs, cycles or a failed comparison refuse activation.

The import refuses unless every attempt is settled, every worker's exit was observed or confirmed, and no dispatcher's heartbeat is fresh, and checks this again before activating. Each run writes its own staging file beside the database and removes it unless it was activated, so a failed import can simply be run again. Activation links the staging file into place and fails if a database already exists, so an activated database is never replaced, and two imports at once activate at most one. Keep the old backlog and archive until satisfied; the import never changes either file. After importing, remove `tasks.file` from the configuration.

This migration moves tasks only. Commands read attempts from the database, not old files. If file-based attempt records exist, import them separately before dispatching again.

## Attempt import

Run `switchboard import --attempts --config <config.json> --json` against the existing task database. Stop every Switchboard process using that database first, and keep it stopped throughout; do not run imports concurrently. The import refuses unless every old attempt is settled, no worker may still be running and no dispatcher heartbeat is fresh. It also refuses a database that already has attempts, reservations or retained attempt numbers.

A unique staging database is copied with `VACUUM INTO`, populated, and compared with the source: each attempt's entries and confirmations, request-ID reservations (including those without attempts), pruned numbers and archive summaries. Tasks and dependencies are preserved and checked too. Any schema migration is applied to the copy, not the original database. Only after validation and another settled-state check does the import close both databases and replace the original file. A failed run removes its staging files; rerunning starts afresh. Older outcome categories and confirmation fields are converted once by import, not interpreted by commands.

A database whose attempts were imported before runtime records moved into the database has attempts but no runtime records. For it, run `switchboard import --runtime --config <config.json> --json`, with every Switchboard process stopped as above. It refuses unless every attempt is settled, no worker may still be running, no dispatcher heartbeat is fresh and no control request was claimed without an answer, and it refuses a database that already has runtime records. Through a `VACUUM INTO` staging copy, compared with the files before the original is replaced, it records a launch row, the observed exit, the startup observation and any operator stop confirmation for each attempt's runtime directory. Old activity logs are not imported; they stay on disk.

The old attempt, reservation and archive files are never changed or removed. Result files, Pi sessions and worker artefacts remain at their recorded paths. Keep the old files until satisfied. See [attempt records](phases/01-basic-dispatch/attempt-log.md) for transaction boundaries, confirmation scopes and pruning.

## Task commands

All commands accept `--json` and `--config`. Success exits 0, a store refusal exits 1 with a stable `reason`, and usage or configuration errors exit 2.

```text
switchboard task add <id> <title> [--body <text> | --body-file <path>] [--repo <name>] [--kind <kind>]
switchboard task show <id>
switchboard task list [--state queued|in_flight|done] [--repo <name>]
switchboard task ready [--repo <name>]
switchboard task update <id> [--title <text>] [--body <text> | --body-file <path>] [--repo <name>] [--kind <kind>]
switchboard task hold <id> --reason <one-line reason>
switchboard task release <id>
switchboard task block <id> --by <blocker-id>
switchboard task unblock <id> --by <blocker-id>
switchboard task done <id> [--note <text>]
switchboard task reopen <id>
```

IDs contain letters, digits, `.`, `_` and `-`, and are never reused. New tasks go after all existing tasks. Hold reasons have 1–200 characters. Self-dependencies, missing blockers and cycles are refused atomically. See the [task-store contract](task-store.md) for readiness and decisions made during an attempt.
