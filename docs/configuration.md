# Configuration

`--config <path>` selects a JSON configuration file. Otherwise Switchboard uses `$SWITCHBOARD_CONFIG`, then `./switchboard.json`. Every configured path is absolute. The [README example](../README.md#running-it) shows the repository, delivery and worker settings.

## Tasks and database

- `runtimeRoot`: retained local storage outside every Treehouse workspace, holding runtime records and, by default, `switchboard.db`.
- `databasePath`: optional absolute override for the database file, also outside every recyclable workspace. Contexts sharing this path share task IDs and order.
- `databaseRetryMs`: how long a writer retries a busy database asynchronously, default 5000 milliseconds. Zero refuses immediately. Refusals use the stable `busy` reason and apply no change.
- `tasks.repo`: repository used to select ready and in-flight tasks. Task commands accept `--repo` to override it. Reading a named task is database-wide.

The old `tasks.file` setting is removed. Switchboard never silently reads a backlog instead of the database. The database uses Node.js 26.7's built-in SQLite, WAL, `synchronous = FULL`, `fullfsync` and a zero busy timeout. Every write transaction starts with `BEGIN IMMEDIATE`. Schema version 1 contains tasks and dependencies; later migrations add attempt and runtime tables.

Use local storage, not network or synced folders. Switchboard probes exclusive creation in the database's directory and refuses linked or non-canonical paths. Do not copy an open database without its WAL; stop Switchboard first or use SQLite backup tooling.

## Tasks-axi import

Run `switchboard import --tasks-axi <backlog.md> [--archive <done-archive.md>] --config <config.json> --json` once, before any other command creates the database. The default archive is `done-archive.md` beside the backlog. The import reads both files through tasks-axi 0.2.6's `MarkdownStore.list` and keeps task order, state, hold reason and dependencies. It reports dependencies on missing tasks, which it drops, and holds with a date, which it converts: one still in force becomes an ordinary hold, and one whose date has passed is dropped. It compares every stored field, the count and the ready list with the source before activating the file. Duplicate IDs, cycles or a failed comparison refuse activation.

The import refuses unless every attempt is settled, every worker's exit was observed or confirmed, and no dispatcher's heartbeat is fresh, and checks this again before activating. Each run writes its own staging file beside the database and removes it unless it was activated, so a failed import can simply be run again. Activation links the staging file into place and fails if a database already exists, so an activated database is never replaced, and two imports at once activate at most one. Keep the old backlog and archive until satisfied; the import never changes either file. After importing, remove `tasks.file` from the configuration.

This migration moves tasks only. Existing attempt logs, reservations and runtime files remain readable in their original locations; their database migration follows separately. Import checks their current settled state before reading and again before activation.

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
