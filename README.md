# Switchboard

Foreground dispatch of one ready task to one worker in a leased workspace. The [architecture](docs/architecture.md) and [Phase 1 PRD](docs/phases/01-basic-dispatch/PRD.md) define the intended behaviour.

## Current status

This repository contains the specifications, integration investigations and the first Pi RPC runtime adapter foundation. It does **not** yet provide `switchboard dispatch --once` or enable live dispatch.

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
- `src/workspaces/`: the workspace-provider interface and the Treehouse adapter (acquire and inspect only).
- `src/infra/`: shared subprocess handling.
- `tests/`: runtime framing, lifecycle, identity, discovery and result-failure tests; attempt-log creation races; tasks-axi and Treehouse adapter behaviour.
- `investigations/`: separate provider/runtime capability probes with their own prerequisites. They are not run by the root test command.

Pi's executable, Node runtime, model configuration and credentials are supplied explicitly by the eventual application configuration. The task-store and workspace adapters, the attempt log and a real end-to-end dispatch remain required before live dispatch. Do not point this unfinished foundation at real work expecting Phase 1 guarantees.

## Decisions

- [tasks-axi owns task state](docs/adr/0001-tasks-axi-is-task-source-of-truth.md).
- [Treehouse owns workspace leases](docs/adr/0002-treehouse-owns-workspace-leases.md).
- [Pi Durable is deferred and continuously reconsidered](docs/adr/0003-pi-durable-for-durable-orchestration.md).
- [TypeScript/Node.js and required host platforms](docs/adr/0004-typescript-and-node-for-switchboard-cli.md).
- [Pi RPC subprocess and result file](docs/adr/0005-pi-rpc-worker-and-result-file.md).
- [Switchboard attempt log](docs/adr/0006-switchboard-attempt-log.md).
