# Phase 1 verification

Status: Phase 1 is complete on macOS, as of 19 October 2026. This records the evidence for each [acceptance criterion](PRD.md#acceptance-criteria) and for the PRD's completion condition.

Test names below are from the root suite (`npm test`), which passes under Node.js 26.7.0 on macOS, and in CI on Linux and Windows. The suite uses the real tasks-axi 0.2.6 CLI, Treehouse 3.1.3 and Git against disposable stores and repositories, and a synthetic Pi worker (`tests/fixtures/pi-rpc.ts`) in place of a model. Real runs used [`investigations/real-dispatch/`](../../../investigations/real-dispatch/README.md) with Pi 1.2.0, provider `openai-codex` and model `gpt-6.1-sol`.

## Completion condition

The PRD requires adapter fault tests and at least one real end-to-end dispatch to pass, and the adapter mappings and attempt-log format to be documented.

- **Fault tests:** `tests/dispatch/faults.test.ts` injects a fault at each boundary of the dispatch sequence (criterion 6).
- **Real dispatch:** real runs dispatched a code task, which was held for review with its commit retained on the output branch; a `scout` task, whose report was retained outside the workspace and recorded as done; and a task steered while it ran ([runtime notes](runtime-integration.md#real-pi-run)).
- **Adapter mappings:** tasks-axi and Treehouse in the [integration investigation](investigation.md#tasks-axi-adapter-mapping), which matches the commands the adapters run; Pi in the [runtime notes](runtime-integration.md).
- **Attempt-log format:** [attempt log format](attempt-log.md).

## Acceptance criteria

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | Ready selection | `ready keeps backlog order and excludes blocked, held, in-flight and other repositories` (tasks-axi). `no ready work is a successful no-op`, `a held task is not dispatched again, and naming it explicitly is refused because of its lease` (dispatch). `a task kind with no contract is refused before any change` (contracts) |
| 2 | Identity and isolation | `acquire returns a verified allocation on the requested branch and starting commit` (Treehouse). `RPC worker uses exact cwd/session and standard tools, retains result, and observes child exit` (worker). `completed code work is held for review, retained on its branch, and the lease is preserved` checks the task ID is the lease holder. The real runs checked the same end to end |
| 3 | Ordering | Fault cases `in-flight update refused`, `in-flight update unknown and not applied` and `task stops being ready after leasing` each launch no worker (faults) |
| 4 | Completion | `an independent deliverable that is retained is recorded as done`, `completed code work is held for review…` (dispatch). `a task kind with a report contract is done when its report is retained outside the workspace` (contracts). Both kinds also passed in real runs |
| 5 | Preservation | No Switchboard code runs `treehouse return`: the Treehouse adapter only acquires and inspects. Every fault case checks the lease is kept. Retention findings are distinct for a missing branch or commit, commits on no branch, uncommitted and untracked files, and missing artefacts (`tests/workspaces/retention.test.ts`) |
| 6 | Compensation | Twelve fault cases, including lost acknowledgements after a successful lease, in-flight update and final update, each checked against the same three rules (faults). `a repeated request ID returns the existing attempt without dispatching again` (dispatch), and again after the dispatcher is killed at each crash point (crash) |
| 7 | Concurrency and interruption | `two dispatches started at once never dispatch the same task`, `an operator interruption stops the worker and holds the task once its exit is observed`, `an attempt whose worker exit was never observed blocks the next dispatch` (faults). `concurrent creation across processes has exactly one winner` (attempt log) |
| 8 | Crash limitation | `killed after leasing…`, `killed after the in-flight update…`, `killed after launch…` (crash): each kills a real dispatcher process with `SIGKILL` |
| 9 | Contract and retention | `a reported commit that is not on the output branch is held as not retained` (dispatch). `a report left only in the workspace is not retained, so the task is held` (contracts). `an unknown base is rejected and leaves no lease`, `an existing output branch is rejected and leaves no lease` (Treehouse) |
| 10 | Runtime and store boundaries | Wrong-session results fail (`protocol/lifecycle failure wrong-session…`), `stale exit receipts cannot certify another session`, `idleness without a current agent run cannot satisfy completion`, `a lost prompt acknowledgement never causes a second prompt or launch` (worker and records). `a working directory holding a copy of the store, as a workspace would, does not redirect it`, `environment variables and configuration files cannot redirect the store` (tasks-axi) |
| 11 | Limited persistence | The real runs and the suite use only tasks-axi, Treehouse, the runtime records, the attempt log, configuration and diagnostic output. Pi Durable is not a dependency (`package.json`) |
| 12 | Watching and control | `the worker's activity is recorded and passed to the listener` (worker). `killed after launch…` follows the attempt with `watch` after the dispatcher is killed, until the operator confirms the worker stopped (crash). `a stop request stops the running worker and the task is held as interrupted`, `a steering message reaches the running worker once and is recorded with its sender`, `a request with no running dispatcher is withdrawn and can never be forwarded later` (control). `an attempt that exceeds its usage limit is held as over budget` (activity). A real run steered a worker once, recorded with its sender |

## Not covered

- **Linux and Windows real dispatch.** The suite passes there, but no real dispatch has run, so neither platform is supported yet.
- **Real-worker stop, usage limits and model errors.** These are tested with the synthetic worker only.
- **Process ownership.** Switchboard does not prove that background processes started by a worker's tools have stopped. This is why Phase 1 never returns leases ([runtime notes](runtime-integration.md#unresolved-process-ownership-gate)).
- **Durability after power loss.** Records are flushed when written, but behaviour after host power loss has not been tested.
