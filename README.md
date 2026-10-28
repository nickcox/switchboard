# Switchboard

Foreground dispatch of one ready task to one worker in a leased workspace. The [architecture](docs/architecture.md) and [Phase 1 PRD](docs/phases/01-basic-dispatch/PRD.md) define the intended behaviour.

## Current status

Phase 1 is implemented: `switchboard dispatch --once` sends one ready Switchboard task to one Pi worker in a Treehouse-leased workspace, and `status`, `resolve`, `watch`, `stop` and `steer` inspect and control attempts. It has been tested with disposable fixtures and a synthetic Pi worker, and in real runs with a Pi worker (`openai-codex` / `gpt-6.1-sol`) against disposable repositories: a code task held for review with its commit retained, a `scout` task whose report was retained and recorded as done, and a worker steered while it ran. The [verification record](docs/phases/01-basic-dispatch/verification.md) gives the evidence for each acceptance criterion. An independent [review](docs/phases/01-basic-dispatch/review-2026-10-20.md) on 20 October 2026 found safety gaps, including that two dispatches started a moment apart could launch two workers for the same task; all of its findings are fixed.

The worker is a separate Pi process using Pi's standard RPC mode and a worker-written `result.json`, with no custom Pi extension, external supervisor or Pi Durable dependency.

**Phase 1 never returns workspaces automatically.** Observing Pi's process exit does not prove that background processes started by its tools have stopped, so Switchboard preserves every lease and leaves its return to the operator. See the [runtime notes](docs/phases/01-basic-dispatch/runtime-integration.md#unresolved-process-ownership-gate).

**Platforms.** Real dispatch has been verified on macOS only. The test suite also passes on Linux and Windows in CI, and `dispatch` prints a warning on any platform other than macOS.

## Trust and limits

- **Workers are trusted, not sandboxed.** They run as the operator's operating-system user. Private Pi settings and environment allowlists control configuration and inherited variables; they do not stop access to the user's files or credentials. Leased workspaces isolate working copies, not permissions.
- **Usage limits are checked by observation and can be exceeded.** Switchboard requests a stop when reported usage exceeds `maxCost` or `maxTokens`; it cannot impose a hard provider-side spending cap. A request can exceed a limit before the next observation, failed usage snapshots are skipped, and subscription providers may report zero cost.
- **Result validation is not independent verification of the work.** Schema, identity and retention checks validate the worker's report and references, not its claims of correctness or test success. Review and independent checks remain the operator's responsibility.
- **Restoring a backup is not an ordinary restart.** External workers and effects may survive records rolled back by a restore. [ADR-0007 requires dispatch to remain fenced until application identities and external owners have been reconciled](docs/adr/0007-one-sqlite-database.md#decision). A full operator disaster-recovery procedure is still required; do not blindly resume a restored database or supervisor backup.
- **A direct child's exit does not show that every process a worker started has stopped.** Stop requests and valid results do not establish that either. Lease return still requires the operator's `--no-processes` confirmation; dispatch never returns leases automatically.

## Development

Use Node.js 26.7.0 (see `.node-version`) and npm. From this directory, using PowerShell:

```powershell
npm ci --ignore-scripts
npm run check
npm test
```

Node.js runs the TypeScript source directly, with no build step. The tests use a synthetic Pi worker and disposable SQLite task stores, verify imports with tasks-axi's parser, and run `treehouse` and `git` against disposable repositories, so both must be on `PATH`. They do not launch Pi agents, call a model, touch real repositories or Treehouse pools, or change a real task store. Fixture data is kept under the ignored `.investigation/` directory. CI runs the same commands on macOS, Linux and Windows (`.github/workflows/test.yml`).

- `src/runtime/contracts.ts`: provider-independent worker input and result schemas.
- `src/runtime/records.ts`, `store.ts`, `activity.ts` and `requests.ts`: runtime records in the database (launch rows, claims, observations and activity) and stop requests and messages for a running worker.
- `src/runtime/pi/`: Pi-specific RPC transport, launch instructions and result-file validation.
- `src/attempts/store.ts`: transactional attempts, entries, scoped confirmations and archives ([format](docs/phases/01-basic-dispatch/attempt-log.md)); `import.ts` migrates settled file-based records.
- `src/database.ts`: the versioned SQLite database, durability settings and asynchronous busy retries.
- `src/tasks/`: the task-store interface, SQLite implementation, operator commands and tasks-axi 0.2.6 import.
- `src/workspaces/`: the workspace-provider interface, the Treehouse adapter (acquire and inspect only) and the read-only Git retention check.
- `src/infra/`: shared subprocess handling and executable lookup.
- `src/dispatch/`: dispatch, `status`, `resolve`, `watch`, `stop` and `steer`, and the structured result format with its reason and next-action codes (`result.ts`). `observe.ts` reads owner evidence, `assess.ts` derives the state and facts without I/O, and `safety.ts` decides each operation. `status.ts` presents the assessment and adds optional activity summaries and transcript paths; mutation commands do not call it.
- `src/config.ts` and `src/cli.ts`: the configuration file and the `switchboard` command.
- `tests/`: unit and end-to-end tests, including a fault injected at each dispatch boundary and dispatcher crashes after leasing, after the in-flight update and after launch.
- `investigations/`: separate probes and the [real dispatch demo](investigations/real-dispatch/README.md), with their own prerequisites. They are not run by the test command.

## Running it

To try Switchboard without setting up a project, [`investigations/real-dispatch/`](investigations/real-dispatch/README.md) builds a fresh disposable demo and runs one real dispatch.

Otherwise, create a configuration file with absolute paths. For example, `switchboard.json`:

```json
{
  "contextId": "my-project",
  "runtimeRoot": "/Users/me/.switchboard/my-project",
  "tasks": { "repo": "my-project" },
  "workspaces": { "repository": "/Users/me/code/my-project", "poolRoot": "/Users/me/.switchboard/my-project/pool" },
  "delivery": {
    "baseRef": "main",
    "byTaskKind": {
      "scout": { "kind": "artefact", "acceptance": "independent_deliverable", "requiredDeliverables": ["report"] }
    }
  },
  "worker": {
    "piEntrypoint": "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    "provider": "openai-codex",
    "model": "gpt-6.1-sol",
    "thinking": "high",
    "maxCost": 5
  }
}
```

Tasks and attempts live in `<runtimeRoot>/switchboard.db`, not a workspace backlog. Attempt creation, task start and outcome recording use transactions; `maxAttempts` (default 1) is enforced across dispatch processes. Older database schemas migrate automatically on opening. Outcomes never append summaries to task instructions – attempt records retain the evidence and preserve operator edits to the body. Confirmations name their attempt and exact scope, such as an accepted commit or one lease return. Optional `databasePath` overrides this absolute path; it must be on a local filesystem supporting exclusive creation, outside every recyclable workspace. See [configuration](docs/configuration.md).

Create tasks with `switchboard task add <id> "<title>" --body-file <instructions.md>`, or migrate a settled tasks-axi backlog with `switchboard import --tasks-axi <backlog.md>`. The import includes `done-archive.md` beside the backlog (`--archive` overrides it), reports missing dependencies, validates fields and readiness before activation, and never changes the old files. Stop every Switchboard process for this database first. Task import never replaces an activated database. To migrate old attempt files into a database that already contains its tasks, stop every writer and run `switchboard import --attempts`. It validates a `VACUUM INTO` staging copy before replacing the closed database, refuses existing database attempts and leaves the old files unchanged. Do not run imports concurrently. Legacy attempt files and archive summaries are read only for import; Switchboard no longer writes or prunes them. An imported in-flight task may have no attempt files, so `status` still flags a task with no attempt, worker or lease for the operator to reconcile.

`switchboard task` also provides `show`, `list`, `ready`, `update`, `hold --reason`, `release`, `block --by`, `unblock --by`, `done --note` and `reopen`, all with `--json`. Update takes `--title`, `--body` or `--body-file`, `--repo` and `--kind`. IDs are shared across contexts using the same database; ready work is filtered by repository. Operators cannot mark tasks in flight.

Each task has a `definitionRevision`, increased atomically when its title, instructions, repository or kind changes, but not for holds, releases, dependencies or state changes alone. Reservation stores an immutable attempt specification: that revision and task text, repository and context, base ref and output branch, resolved delivery contract, and non-secret runtime settings with their configuration sources. Credentials and the environment are not copied. Acquisition records the lease, workspace, backing repository and actual starting commit separately. The worker uses only these stored inputs. A definition changed during acquisition holds the attempt as `task_definition_changed` without launching and keeps its lease; the result says how to continue. Changes after start apply only to later attempts. `status --json` shows the stored specification and allocation even after configuration changes or a restart. Older attempts migrate from their runtime bindings, with missing provenance marked `unknown`; incomplete specifications stay inspectable and resolvable but cannot launch. See the [task-store contract](docs/task-store.md#definition-revisions-and-attempt-specifications).

`git` and `treehouse` must be on `PATH` for dispatch. Inspection reports unavailable owners as unknown; task commands need only the database. `status`, `finish` and `discard` work without Pi installed. Then, in PowerShell:

```powershell
npm run switchboard -- status --config ./switchboard.json
npm run switchboard -- dispatch --once --config ./switchboard.json
```

- **Dry runs.** `dispatch --once --dry-run` runs the same preflight and selection checks, including `--task <id>`, and reports the selected task and resolved delivery contract, or the same refusal as dispatch. It creates no attempt, acquires no lease, changes no task and launches no worker. Add `--json` for a structured result.
- **Delivery contracts.** A task's `kind` selects its delivery contract from `byTaskKind`. A task with no kind uses the default, which holds completed code for review. Artefact references may name readable regular files or directories within the assigned artefact directory, including that directory itself. Directories need at least one readable regular file, and every file is checked. Empty directories, unreadable targets, dangling or escaping links, link cycles and targets inside recyclable workspaces fail retention with an explanatory finding.
- **Long runs.** `dispatch --once` prints each tool call as the worker makes it and stays in the foreground until the worker finishes. Run it under tmux or `nohup` for long tasks, because closing its terminal ends the dispatcher.
- **Thinking.** Optional `worker.thinking` pins Pi's reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Switchboard checks the reported level before prompting and fails on a mismatch, including model capability clamping. If omitted, Pi selects the level from its settings. Each session's reported startup level is retained and shown beside usage in `status`.
- **Selecting an attempt.** `watch`, `stop`, `steer`, `finish` and `discard` act on one attempt, given as `--lease <lease-id>` or as `--task <task-id>`, which selects the task's latest attempt; add `--attempt <n>` to select an earlier one. `status` shows each attempt's task and lease ID.
- **Watching.** From another terminal, `watch --lease <lease-id>` follows a worker's activity, and `status` shows its last activity, usage, transcript path and whether it has gone quiet. Observed usage above `maxCost` or `maxTokens` triggers a stop request, subject to the [limits above](#trust-and-limits).
- **Stopping and steering.** `stop --lease <lease-id>` asks the dispatcher that owns a worker to stop it. `steer --lease <lease-id> "<message>"` passes it a message, and `--after` waits until it finishes its current work. A request that no running dispatcher takes is withdrawn and reported as undelivered.
- **A worker that may still be running.** If `status` reports one, check it has stopped, then run `resolve --lease <lease-id> --worker-stopped`. That attempt then stops blocking dispatch.
- **A lease in a pool that is no longer listed.** Adding or changing the repository's `origin` remote moves Treehouse to a new pool. `status` reports leases left in the old pool as unknown, and their tasks are not dispatched again. Return each one through Treehouse by its workspace path, then run `resolve --lease <lease-id> --lease-returned`. If acquisition never learned the lease ID, use `resolve --task <task-id> --lease-returned` instead. This selects the task's latest attempt; add `--attempt <n>` to select an earlier one.
- **An unfinished attempt.** A task whose latest attempt never recorded an outcome, for example because its dispatcher was killed, is not dispatched again, and `status` asks you to confirm it stopped. Once its dispatcher has stopped and any lease it acquired is returned, run `resolve --task <task-id> --lease-returned`.
- **Finishing and discarding.** Dispatch preserves every workspace lease. After reviewing the work, `finish --lease <lease-id>` integrates the exact accepted commit under the context's finalisation policy (`manual`, or `local-merge`, which fast-forwards the target branch) and records the task as done. It retains the lease and reports the command to return it. The text and JSON `summary` say whether the lease was retained or returned, matching JSON `lease` (`preserved` or `none`). The task's dependents become ready, and the retained lease does not block other tasks. Once you have checked that no worker process remains, run `finish --lease <lease-id> --no-processes` to return the lease, skipping completed steps; adding that flag to the first run completes all four steps together. If a worker failed, was interrupted or went over budget after committing, `finish --lease <lease-id> --accept-output` accepts the output branch's current head as your decision, recorded with its commit in the attempt log, without requiring a worker result. The branch must exist in the backing repository and advance the attempt's starting commit, and the workspace must have no uncommitted or untracked files. Acceptance is remembered if finishing fails partway, so an ordinary `finish` can complete the remaining steps. `discard --lease <lease-id> --confirm --no-processes` returns the lease of work you do not want and holds its task unless it was already done, in which case it stays done. `--no-processes` is your confirmation that no worker process remains in the workspace, which Switchboard cannot check; `--dry-run` shows what either command would do. The policy comes from `~/.config/switchboard/policy.json`, the repository's `.switchboard/policy.json` on the base branch and the `finalisation` object in the configuration, and `status` shows the result.
- **Failed owner reads.** `finish` and `discard` report `owner_read_retryable` when an owner read fails before any effect was attempted, naming the owner. Run the same command again to read it again. After an effect or a recorded return intent, a failed read reports `reconciliation_required`: inspect the owner and reconcile the outcome, rather than repeating the effect. A later command can record an already completed return once Treehouse confirms the lease is absent; it never returns that lease again. Each failed read keeps bounded command diagnostics with the attempt, including on a dry run, without copying the environment. `status` shows the latest recorded failure; `status --json` exposes it as `latestReadFailure`. See the [attempt records](docs/phases/01-basic-dispatch/attempt-log.md#failed-owner-reads).
- **Recorded worker results.** After observing a successful worker exit, Switchboard validates the result and stores its content, the SHA-256 digest of the source file, its path, validation version and time in the database. Dispatch, finish and retention use that immutable record. `status` shows the recorded report; a later changed, missing or unreadable file is reported as a discrepancy and never adopted. An older attempt without a recorded result is validated and recorded before finish checks retention; a dry run checks it without writing. These checks validate the worker's report, not independent acceptance of its work. Explicit `finish --accept-output` remains a separate operator decision.
- **Request IDs.** `dispatch --request-id <id>` reserves the ID within its context in the same transaction as the attempt. Repeating it returns the original attempt, even after pruning; automatic selection never selects another task on replay. The record fingerprints the caller's explicit task selection (including automatic selection), not later task or configuration changes. Different explicit inputs refuse as `request_input_mismatch`. Request records never expire. Historical requests whose explicit inputs were not retained remain reserved and require inspection rather than a new launch; conflicting historical mappings refuse migration.
- **Pruning old records.** `prune --older-than <days>` archives each eligible finished attempt in the database, removes its entries, keeps its request-ID record pointing to the archived summary, and schedules its runtime directory (including sessions and artefacts) for deletion in one transaction. Directory deletion follows outside it; another prune completes interrupted cleanup. Unfinished, leased, possibly running and unknown attempts are preserved. Age is measured from the last entry. `--dry-run` lists removals without writing. Retained attempt numbers prevent reuse of output-branch names; no prune lock needs clearing. Pruning does not change tasks, leases or Git refs; save any runtime artefacts you still need first.
- `--json` prints the structured result of any command.

## Not yet done

- A real dispatch on Linux and Windows.

## Decisions

- [One SQLite database owns tasks and records](docs/adr/0007-one-sqlite-database.md) (tasks, attempts and runtime records implemented).
- [Treehouse owns workspace leases](docs/adr/0002-treehouse-owns-workspace-leases.md).
- [Pi Durable is provisionally selected for supervisor continuity, subject to adoption checks](docs/adr/0003-pi-durable-for-durable-orchestration.md).
- [TypeScript/Node.js and required host platforms](docs/adr/0004-typescript-and-node-for-switchboard-cli.md).
- [Pi RPC subprocess and result file](docs/adr/0005-pi-rpc-worker-and-result-file.md).
- [Switchboard attempt log](docs/adr/0006-switchboard-attempt-log.md).

## Licence

[MIT](LICENSE).
