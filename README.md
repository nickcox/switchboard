# Switchboard

Foreground dispatch of one ready task to one worker in a leased workspace. The [architecture](docs/architecture.md) and [Phase 1 PRD](docs/phases/01-basic-dispatch/PRD.md) define the intended behaviour.

## Current status

This repository contains the specifications, integration investigations and a walking skeleton of Phase 1: `switchboard dispatch --once` and `switchboard status` work end to end against tasks-axi, Treehouse and Pi. They have been tested with disposable fixtures and a synthetic Pi worker, and once with a real Pi worker (`openai-codex` / `gpt-6.1-sol`) against a disposable repository: the task was held for review with its commit retained on the output branch. Several Phase 1 requirements remain (see [Not yet done](#not-yet-done)).

The runtime uses a separate Pi process, standard RPC and a worker-written `result.json`, with no custom Pi extension, external supervisor or Pi Durable dependency. It validates identity and result data, retains runtime-owned input/exit facts, and refuses same-lease relaunch. One real Pi run against a disposable repository has passed.

**Phase 1 never returns workspaces automatically.** Observing Pi's direct child exit does not prove that detached tool subprocesses stopped, so the adapter always reports `workerTermination: unverified`. Phase 1 finalises the task on direct-child exit, preserves every lease and leaves return to the operator. Automatic return waits until process ownership is verified. See [runtime implementation notes and the Pi Durable comparison](docs/phases/01-basic-dispatch/runtime-integration.md).

macOS is the initial verification target. Linux and Windows are required future platforms, not currently verified runtime integrations.

## Development

Use Node.js 26.7.0 (see `.node-version`) and npm. From this directory, using PowerShell:

```powershell
npm ci --ignore-scripts
npm run check
npm test
```

Node.js runs the TypeScript source directly, with no build step. The root tests use synthetic RPC subprocesses for the Pi runtime, run the pinned tasks-axi CLI against disposable stores, and run `treehouse` and `git` against disposable repositories, so both must be on `PATH`. They do not launch Pi agents, call a model, touch real repositories or Treehouse pools, or change a real task store. Fixture data is retained under the ignored `.investigation/` directory.

- `src/runtime/contracts.ts`: provider-independent worker input and result schemas.
- `src/runtime/records.ts`: runtime-owned input bindings, discovery and observed direct-child exit records.
- `src/runtime/pi/`: Pi-specific RPC transport, launch instructions and result-file validation.
- `src/attempts/log.ts`: the append-only attempt log ([ADR-0006](docs/adr/0006-switchboard-attempt-log.md)).
- `src/tasks/`: the task-store interface and the tasks-axi 0.2.6 adapter.
- `src/workspaces/`: the workspace-provider interface, the Treehouse adapter (acquire and inspect only) and the read-only Git retention check.
- `src/infra/`: shared subprocess handling and executable lookup.
- `src/dispatch/`: the dispatch policy operations, `status`, and the structured result format with its reason categories and next-action codes (`result.ts`).
- `src/config.ts` and `src/cli.ts`: the configuration file and the `switchboard` command.
- `tests/`: runtime framing, lifecycle, identity, discovery and result-failure tests; attempt-log creation races; tasks-axi and Treehouse adapter behaviour; dispatch and the CLI end to end with the synthetic worker; a fault injected at each dispatch boundary, checked against the same invariants; and dispatcher crashes after leasing, after the in-flight update and after launch.
- `investigations/`: separate provider/runtime capability probes with their own prerequisites. They are not run by the root test command.

## Running it

To try Switchboard without setting up a project, [`investigations/real-dispatch/`](investigations/real-dispatch/README.md) builds a fresh disposable demo and runs one real dispatch.

Otherwise, create a configuration file with absolute paths. For example, `switchboard.json`:

```json
{
  "contextId": "my-project",
  "runtimeRoot": "/Users/me/.switchboard/my-project",
  "tasks": { "file": "/Users/me/code/my-project/TASKS-backlog.md", "repo": "my-project" },
  "workspaces": { "repository": "/Users/me/code/my-project", "poolRoot": "/Users/me/.switchboard/my-project/pool" },
  "delivery": { "baseRef": "main" },
  "worker": {
    "piEntrypoint": "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    "provider": "openai-codex",
    "model": "gpt-6.1-sol"
  }
}
```

Then, in PowerShell:

```powershell
npm run switchboard -- status --config ./switchboard.json
npm run switchboard -- dispatch --once --config ./switchboard.json
```

If `status` reports that a worker may still be running, check it has stopped and run `npm run switchboard -- resolve --lease <lease-id> --worker-stopped --config ./switchboard.json`; that attempt then stops blocking dispatch. `--json` prints the structured result. `git` and `treehouse` must be on `PATH`. Every outcome preserves the workspace lease; return it through Treehouse after reviewing the work and confirming the report's retention check.

## Not yet done

- Per-task delivery contracts. Every task uses the configured defaults, which hold completed code for review.
- Linux and Windows.

## Decisions

- [tasks-axi owns task state](docs/adr/0001-tasks-axi-is-task-source-of-truth.md).
- [Treehouse owns workspace leases](docs/adr/0002-treehouse-owns-workspace-leases.md).
- [Pi Durable is deferred and continuously reconsidered](docs/adr/0003-pi-durable-for-durable-orchestration.md).
- [TypeScript/Node.js and required host platforms](docs/adr/0004-typescript-and-node-for-switchboard-cli.md).
- [Pi RPC subprocess and result file](docs/adr/0005-pi-rpc-worker-and-result-file.md).
- [Switchboard attempt log](docs/adr/0006-switchboard-attempt-log.md).
