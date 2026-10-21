# Switchboard

Foreground dispatch of one ready task to one worker in a leased workspace. The [architecture](docs/architecture.md) and [Phase 1 PRD](docs/phases/01-basic-dispatch/PRD.md) define the intended behaviour.

## Current status

Phase 1 is implemented: `switchboard dispatch --once` sends one ready Switchboard task to one Pi worker in a Treehouse-leased workspace, and `status`, `resolve`, `watch`, `stop` and `steer` inspect and control attempts. It has been tested with disposable fixtures and a synthetic Pi worker, and in real runs with a Pi worker (`openai-codex` / `gpt-6.1-sol`) against disposable repositories: a code task held for review with its commit retained, a `scout` task whose report was retained and recorded as done, and a worker steered while it ran. The [verification record](docs/phases/01-basic-dispatch/verification.md) gives the evidence for each acceptance criterion. An independent [review](docs/phases/01-basic-dispatch/review-2026-10-20.md) on 20 October 2026 found safety gaps, including that two dispatches started a moment apart could launch two workers for the same task; all of its findings are fixed.

The worker is a separate Pi process using Pi's standard RPC mode and a worker-written `result.json`, with no custom Pi extension, external supervisor or Pi Durable dependency.

**Phase 1 never returns workspaces automatically.** Observing Pi's process exit does not prove that background processes started by its tools have stopped, so Switchboard preserves every lease and leaves its return to the operator. See the [runtime notes](docs/phases/01-basic-dispatch/runtime-integration.md#unresolved-process-ownership-gate).

**Platforms.** Real dispatch has been verified on macOS only. The test suite also passes on Linux and Windows in CI, and `dispatch` prints a warning on any platform other than macOS.

## Development

Use Node.js 26.7.0 (see `.node-version`) and npm. From this directory, using PowerShell:

```powershell
npm ci --ignore-scripts
npm run check
npm test
```

Node.js runs the TypeScript source directly, with no build step. The tests use a synthetic Pi worker and disposable SQLite task stores, verify imports with tasks-axi's parser, and run `treehouse` and `git` against disposable repositories, so both must be on `PATH`. They do not launch Pi agents, call a model, touch real repositories or Treehouse pools, or change a real task store. Fixture data is kept under the ignored `.investigation/` directory. CI runs the same commands on macOS, Linux and Windows (`.github/workflows/test.yml`).

- `src/runtime/contracts.ts`: provider-independent worker input and result schemas.
- `src/runtime/records.ts`, `activity.ts` and `requests.ts`: runtime-owned records, the worker activity log, and stop requests and messages for a running worker.
- `src/runtime/pi/`: Pi-specific RPC transport, launch instructions and result-file validation.
- `src/attempts/log.ts`: the append-only attempt log ([format](docs/phases/01-basic-dispatch/attempt-log.md)).
- `src/database.ts`: the versioned SQLite database, durability settings and asynchronous busy retries.
- `src/tasks/`: the task-store interface, SQLite implementation, operator commands and tasks-axi 0.2.6 import.
- `src/workspaces/`: the workspace-provider interface, the Treehouse adapter (acquire and inspect only) and the read-only Git retention check.
- `src/infra/`: shared subprocess handling and executable lookup.
- `src/dispatch/`: dispatch, `status`, `resolve`, `watch`, `stop` and `steer`, and the structured result format with its reason and next-action codes (`result.ts`).
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

Tasks live in `<runtimeRoot>/switchboard.db`, not a workspace backlog. Optional `databasePath` overrides this absolute path; it must be on a local filesystem supporting exclusive creation, outside every recyclable workspace. See [configuration](docs/configuration.md).

Create tasks with `switchboard task add <id> "<title>" --body-file <instructions.md>`, or migrate a settled tasks-axi backlog with `switchboard import --tasks-axi <backlog.md>`. The import includes `done-archive.md` beside the backlog (`--archive` overrides it), reports missing dependencies, validates fields and readiness before activation, and never changes the old files. Stop every Switchboard process for this database first. An activated database is never replaced by import.

`switchboard task` also provides `show`, `list`, `ready`, `update`, `hold --reason`, `release`, `block --by`, `unblock --by`, `done --note` and `reopen`, all with `--json`. Update takes `--title`, `--body` or `--body-file`, `--repo` and `--kind`. IDs are shared across contexts using the same database; ready work is filtered by repository. Operators cannot mark tasks in flight.

`git` and `treehouse` must be on `PATH` for dispatch and reconciliation. Then, in PowerShell:

```powershell
npm run switchboard -- status --config ./switchboard.json
npm run switchboard -- dispatch --once --config ./switchboard.json
```

- **Dry runs.** `dispatch --once --dry-run` runs the same preflight and selection checks, including `--task <id>`, and reports the selected task and resolved delivery contract, or the same refusal as dispatch. It creates no attempt, acquires no lease, changes no task and launches no worker. Add `--json` for a structured result.
- **Delivery contracts.** A task's `kind` selects its delivery contract from `byTaskKind`. A task with no kind uses the default, which holds completed code for review.
- **Long runs.** `dispatch --once` prints each tool call as the worker makes it and stays in the foreground until the worker finishes. Run it under tmux or `nohup` for long tasks, because closing its terminal ends the dispatcher.
- **Thinking.** Optional `worker.thinking` pins Pi's reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Switchboard checks the reported level before prompting and fails on a mismatch, including model capability clamping. If omitted, Pi selects the level from its settings. Each session's reported startup level is retained and shown beside usage in `status`.
- **Selecting an attempt.** `watch`, `stop`, `steer`, `finish` and `discard` act on one attempt, given as `--lease <lease-id>` or as `--task <task-id>`, which selects the task's latest attempt; add `--attempt <n>` to select an earlier one. `status` shows each attempt's task and lease ID.
- **Watching.** From another terminal, `watch --lease <lease-id>` follows a worker's activity, and `status` shows its last activity, usage, transcript path and whether it has gone quiet. `maxCost` and `maxTokens` stop a worker that exceeds them.
- **Stopping and steering.** `stop --lease <lease-id>` asks the dispatcher that owns a worker to stop it. `steer --lease <lease-id> "<message>"` passes it a message, and `--after` waits until it finishes its current work. A request that no running dispatcher takes is withdrawn and reported as undelivered.
- **A worker that may still be running.** If `status` reports one, check it has stopped, then run `resolve --lease <lease-id> --worker-stopped`. That attempt then stops blocking dispatch.
- **A lease in a pool that is no longer listed.** Adding or changing the repository's `origin` remote moves Treehouse to a new pool. `status` reports leases left in the old pool as unknown, and their tasks are not dispatched again. Return each one through Treehouse by its workspace path, then run `resolve --lease <lease-id> --lease-returned`. If acquisition never learned the lease ID, use `resolve --task <task-id> --lease-returned` instead. This selects the task's latest attempt; add `--attempt <n>` to select an earlier one.
- **An unfinished attempt.** A task whose latest attempt never recorded an outcome, for example because its dispatcher was killed, is not dispatched again, and `status` asks you to confirm it stopped. Once its dispatcher has stopped and any lease it acquired is returned, run `resolve --task <task-id> --lease-returned`.
- **Finishing and discarding.** Dispatch preserves every workspace lease. After reviewing the work, `finish --lease <lease-id> --no-processes` integrates it under the context's finalisation policy (`manual`, or `local-merge`, which fast-forwards the target branch), records the task as done and returns the lease. If a worker failed, was interrupted or went over budget after committing, `finish --lease <lease-id> --accept-output --no-processes` accepts the output branch's current head as your decision, recorded with its commit in the attempt log, without requiring a worker result. The branch must exist in the backing repository and advance the attempt's starting commit, and the workspace must have no uncommitted or untracked files. Acceptance is remembered if finishing fails partway, so an ordinary `finish` can complete the remaining steps. `discard --lease <lease-id> --confirm --no-processes` returns the lease of work you do not want and holds its task unless it was already done, in which case it stays done. `--no-processes` is your confirmation that no worker process remains in the workspace, which Switchboard cannot check; `--dry-run` shows what either command would do. The policy comes from `~/.config/switchboard/policy.json`, the repository's `.switchboard/policy.json` on the base branch and the `finalisation` object in the configuration, and `status` shows the result.
- **Pruning old records.** `prune --older-than <days>` archives a summary of each eligible finished attempt under `<runtimeRoot>/archive/`, then removes its attempt-log entries, runtime directory (including sessions and artefacts) and matching request-ID reservation. Unfinished, leased, possibly running and unknown attempts, including those in pools no longer listed, are preserved. Age is measured from the last attempt-log entry. `--dry-run` lists removals without writing; interrupted cleanup can be completed by running prune again. Only one prune runs at a time; if one was interrupted, the refusal names the lock directory to remove. Archived summaries and small directory markers preserve attempt numbering. Pruning does not change tasks, leases or Git refs; save any runtime artefacts you still need first.
- `--json` prints the structured result of any command.

## Not yet done

- A real dispatch on Linux and Windows.

## Decisions

- [One SQLite database owns tasks and records](docs/adr/0007-one-sqlite-database.md) (task migration implemented; record migration follows).
- [Treehouse owns workspace leases](docs/adr/0002-treehouse-owns-workspace-leases.md).
- [Pi Durable is deferred and continuously reconsidered](docs/adr/0003-pi-durable-for-durable-orchestration.md).
- [TypeScript/Node.js and required host platforms](docs/adr/0004-typescript-and-node-for-switchboard-cli.md).
- [Pi RPC subprocess and result file](docs/adr/0005-pi-rpc-worker-and-result-file.md).
- [Switchboard attempt log](docs/adr/0006-switchboard-attempt-log.md).

## Licence

[MIT](LICENSE).
