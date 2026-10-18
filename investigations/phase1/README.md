# Phase 1 capability probes

These are investigation fixtures, not the Switchboard implementation. Findings and adapter mappings are in [the investigation report](../../docs/phases/01-basic-dispatch/investigation.md). A compact record of the observed results is in [results.json](results.json).

## Requirements

- macOS on Apple Silicon. Other hosts have not been verified.
- Bun 1.3.11, Node.js and Git on PATH.
- Treehouse 3.1.3 on PATH. The probes check its reported version.

The recorded Node.js version is 26.7.0. Pi SDK 1.2.0, tasks-axi 0.2.6, the TOON decoder, types and investigation-only locking candidate are pinned in `package.json` and `bun.lock`. Pi's documented Node.js minimum is 22.19.0; older host configurations were not tested.

From the Switchboard directory, using PowerShell:

```powershell
Push-Location investigations/phase1
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run test
Pop-Location
```

Dependency lifecycle scripts are intentionally disabled. The storage and process probes do not require them. The two blocked scripts in the recorded install belonged to `@google/genai` and `protobufjs`.

## What runs

| File | Checks |
| --- | --- |
| `environment.test.ts` | Selected versions, host and Treehouse executable hash |
| `tasks.test.ts` | Real tasks-axi CLI calls under Node: explicit store addressing, read formats, ordering, transitions, holds and evidence readback |
| `treehouse.test.ts` | Real Treehouse CLI calls: allocation identity, conditional return, slot reuse, exact commit retention, dirty refusal and ignored seed removal |
| `pi-storage.test.ts` | Pi's public `SessionManager` API under Bun: persistence timing, fresh-process discovery and retained synthetic result records |
| `process.test.ts` | Disposable Bun/Node processes: exact cwd, metadata, interruption, termination and native macOS `flock` through Bun FFI |

The lock proof uses Darwin's `O_CLOEXEC` flag when opening the descriptor and checks `FD_CLOEXEC`. It also kills the lock owner while a spawned child remains alive, then verifies that another process can acquire the lock. This proves why acquiring a fresh dispatcher lock must not clear unresolved worker or lease state.

FFI is an investigation mechanism, not a selected production locking dependency. The probe uses only the two fixed `fcntl` arguments needed for `F_GETFD`. Do not add a fixed-signature FFI call to variadic `F_SETFD` on macOS arm64; use a correctly compiled wrapper if that operation is needed.

## Known native-addon incompatibility

`fs-native-extensions@1.5.1` imports under Bun, but calling `tryLock` crashes Bun 1.3.11 at the unsupported libuv function `uv_get_osfhandle`. The same fixture succeeds under Node.js 26.7.0. This package is **not** a usable Bun locking dependency in the tested configuration.

This reproduction is separate from the normal test suite because it intentionally crashes a child Bun process. To reproduce it:

```powershell
Push-Location investigations/phase1
bun run probe:native-addon
Pop-Location
```

The reproduction command succeeds only when the Node control succeeds and the known Bun failure is observed. That exit status means the incompatibility was reproduced, not that native locking works under Bun.

## Isolation and evidence

Each run prints a unique directory beneath the repository's ignored `.investigation/runs/`. Commands use isolated home/config directories and explicitly selected fixture stores and Treehouse roots. They do not inherit task-store overrides, Treehouse settings, Git user configuration or real task/lease identities.

Each fixture Git repository has its own initial and result commits. The probes never commit to the Switchboard checkout. Dirty fixtures and test leases are retained for inspection; no automatic cleanup is performed.

`commands.jsonl` records command arguments, working directories, exit codes and output. Other files record host versions, process observations, Pi storage observations or the opt-in native-addon reproduction. These files are diagnostic evidence, not orchestration state.

No Pi agent or model is launched. The Pi records are explicitly synthetic, written through supported session APIs. No real end-to-end dispatch, runtime result tool, dispatcher policy or complete PRD fault-injection suite is implemented by these probes.
