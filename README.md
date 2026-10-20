# Switchboard

Foreground dispatch of one ready task to one worker in a leased workspace. The [architecture](docs/architecture.md) and [Phase 1 PRD](docs/phases/01-basic-dispatch/PRD.md) define the intended behaviour.

## Current status

Phase 1 is implemented: `switchboard dispatch --once` sends one ready tasks-axi task to one Pi worker in a Treehouse-leased workspace, and `status`, `resolve`, `watch`, `stop` and `steer` inspect and control attempts. It has been tested with disposable fixtures and a synthetic Pi worker, and in real runs with a Pi worker (`openai-codex` / `gpt-6.1-sol`) against disposable repositories: a code task held for review with its commit retained, a `scout` task whose report was retained and recorded as done, and a worker steered while it ran. The [verification record](docs/phases/01-basic-dispatch/verification.md) gives the evidence for each acceptance criterion. An independent [review](docs/phases/01-basic-dispatch/review-2026-10-20.md) on 20 October 2026 found safety gaps that must be fixed before Phase 1 is complete. Its critical finding, that two dispatches started a moment apart could launch two workers for the same task, is fixed; others remain.

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

Node.js runs the TypeScript source directly, with no build step. The tests use a synthetic Pi worker, run the pinned tasks-axi CLI against disposable stores, and run `treehouse` and `git` against disposable repositories, so both must be on `PATH`. They do not launch Pi agents, call a model, touch real repositories or Treehouse pools, or change a real task store. Fixture data is kept under the ignored `.investigation/` directory. CI runs the same commands on macOS, Linux and Windows (`.github/workflows/test.yml`).

- `src/runtime/contracts.ts`: provider-independent worker input and result schemas.
- `src/runtime/records.ts`, `activity.ts` and `requests.ts`: runtime-owned records, the worker activity log, and stop requests and messages for a running worker.
- `src/runtime/pi/`: Pi-specific RPC transport, launch instructions and result-file validation.
- `src/attempts/log.ts`: the append-only attempt log ([format](docs/phases/01-basic-dispatch/attempt-log.md)).
- `src/tasks/`: the task-store interface and the tasks-axi 0.2.6 adapter.
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
  "tasks": { "file": "/Users/me/code/my-project/TASKS-backlog.md", "repo": "my-project" },
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

`git` and `treehouse` must be on `PATH`. Then, in PowerShell:

```powershell
npm run switchboard -- status --config ./switchboard.json
npm run switchboard -- dispatch --once --config ./switchboard.json
```

- **Dry runs.** `dispatch --once --dry-run` runs the same preflight and selection checks, including `--task <id>`, and reports the selected task and resolved delivery contract, or the same refusal as dispatch. It creates no attempt, acquires no lease, changes no task and launches no worker. Add `--json` for a structured result.
- **Delivery contracts.** A task's tasks-axi `kind` selects its delivery contract from `byTaskKind`. A task with no kind uses the default, which holds completed code for review.
- **Long runs.** `dispatch --once` prints each tool call as the worker makes it and stays in the foreground until the worker finishes. Run it under tmux or `nohup` for long tasks, because closing its terminal ends the dispatcher.
- **Thinking.** Optional `worker.thinking` pins Pi's reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Switchboard checks the reported level before prompting and fails on a mismatch, including model capability clamping. If omitted, Pi selects the level from its settings. Each session's reported startup level is retained and shown beside usage in `status`.
- **Watching.** From another terminal, `watch --lease <lease-id>` follows a worker's activity, and `status` shows its last activity, usage, transcript path and whether it has gone quiet. `maxCost` and `maxTokens` stop a worker that exceeds them.
- **Stopping and steering.** `stop --lease <lease-id>` asks the dispatcher that owns a worker to stop it. `steer --lease <lease-id> "<message>"` passes it a message, and `--after` waits until it finishes its current work. A request that no running dispatcher takes is withdrawn and reported as undelivered.
- **A worker that may still be running.** If `status` reports one, check it has stopped, then run `resolve --lease <lease-id> --worker-stopped`. That attempt then stops blocking dispatch.
- **A lease in a pool that is no longer listed.** Adding or changing the repository's `origin` remote moves Treehouse to a new pool. `status` reports leases left in the old pool as unknown, and their tasks are not dispatched again. Return each one through Treehouse by its workspace path, then run `resolve --lease <lease-id> --lease-returned`. If acquisition never learned the lease ID, use `resolve --task <task-id> --lease-returned` instead. This selects the task's latest attempt; add `--attempt <n>` to select an earlier one.
- **An unfinished attempt.** A task whose latest attempt never recorded an outcome, for example because its dispatcher was killed, is not dispatched again, and `status` asks you to confirm it stopped. Once its dispatcher has stopped and any lease it acquired is returned, run `resolve --task <task-id> --lease-returned`.
- **Returning leases.** Every outcome preserves the workspace lease. Return it through Treehouse after reviewing the work and confirming the report's retention check.
- `--json` prints the structured result of any command.

## Not yet done

- A real dispatch on Linux and Windows.

## Decisions

- [tasks-axi owns task state](docs/adr/0001-tasks-axi-is-task-source-of-truth.md).
- [Treehouse owns workspace leases](docs/adr/0002-treehouse-owns-workspace-leases.md).
- [Pi Durable is deferred and continuously reconsidered](docs/adr/0003-pi-durable-for-durable-orchestration.md).
- [TypeScript/Node.js and required host platforms](docs/adr/0004-typescript-and-node-for-switchboard-cli.md).
- [Pi RPC subprocess and result file](docs/adr/0005-pi-rpc-worker-and-result-file.md).
- [Switchboard attempt log](docs/adr/0006-switchboard-attempt-log.md).

## Licence

[MIT](LICENSE).
