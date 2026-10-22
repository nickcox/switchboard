# Durable orchestration investigation

## Scope and baseline

Steps 1 and 2 of the [comparative prototype plan](../../docs/phases/03-multiple-workers-and-runtimes/pi-durable-orchestration-prototype.md), recorded on 22 October 2026. This is dependency qualification and an implementation inventory, not the A/B comparison or an adoption recommendation. There were no earlier findings in this directory.

The implementation inspected is Switchboard commit **`431cc85d672cabbf1107a66a01627e378b25fd53`**. Source at that commit takes precedence over the older status text in the Phase 3 PRD and ADR-0007: the database migration, shared worker supervisor, observation/assessment split and operation-specific safety checks already exist. Several-attempt dispatch semantics, the background dispatcher and the finalisation step runner do not.

No production dependency, `src/` change, task mutation, Treehouse operation, worker agent, publish or merge is part of this probe. Dependencies and prototype code are local to this directory. All generated state is under the ignored repository `.investigation/durable-orchestration/` directory.

### Existing operations

Classification is by responsibility, not by whole module: **domain policy** defines what may happen; **external adaptation** calls an owner or interprets its evidence; **execution machinery** orders work and stores execution progress. Mixed operations are split below rather than assigning their safety checks to the engine.

| Existing operation/responsibility | Class | Code and records | Design A | Design B |
| --- | --- | --- | --- | --- |
| Add/read/list/ready/update/hold/release/block/unblock/done/reopen project tasks; readiness, dependencies and order | Domain policy | `src/tasks/{store,sqlite,cli}.ts`; `tasks`, `dependencies` | Keep | Keep; Durable tasks are not project tasks |
| Select work, resolve a delivery contract, check capacity and reserve an attempt; revalidate readiness and start it; record an outcome atomically with task state | Domain policy | `src/dispatch/dispatch.ts`, `src/attempts/store.ts`, `src/runtime/contracts.ts`; `attempts` including context-unique `request_id`, `attempt_numbers`, `attempt_entries` | Keep | Keep transactional application operations and caller request IDs; engine admission is not domain admission |
| Run dispatch preflight, acquisition, start, launch, observation and finalisation in order; return an existing request result | Execution machinery | `dispatchOnce`/`inspect` in `src/dispatch/dispatch.ts`; attempt entries and runtime observations, no saved workflow position | Keep existing foreground composition; later share a loop | Replace the composition with checkpointed task phases calling the same operations; add request-to-workflow correlation and cross-store reconciliation |
| Acquire/list/inspect/identity-check/return a workspace | External adaptation | `src/workspaces/{provider,treehouse}.ts`, `src/infra/command.ts`; Treehouse lease plus recorded identity in attempt entries | Keep | Keep; no blind reacquisition after uncertainty |
| Launch isolated Pi, verify session, send initial prompt once, speak RPC, observe child exit and validate result file | External adaptation | `src/runtime/pi/`, `src/runtime/contracts.ts`, `src/infra/`; immutable binding, observations, `result.json`, sessions and artefacts | Keep | Keep; a recovered phase is not permission to launch or prompt again |
| Supervise a live worker, heartbeat, budget, activity, shutdown, forward claimed stop/steer/follow-up requests once | Execution machinery | `src/runtime/{supervisor,heartbeat,requests,activity,store,records}.ts`; `worker_claims`, `control_requests`, `worker_activity`, `worker_observations` | Keep shared `WorkerSupervisor` (already extracted) | Retain process/channel ownership and observations; candidate reduction of orchestration waits only, not replacement by Durable cancellation |
| Read owners; classify attempts; present status/watch and resolve stopped workers/returned leases | External adaptation (reads), domain policy (assessment and resolution), execution machinery (presentation/watch) | `src/dispatch/{observe,assess,status,watch,resolve,state,select}.ts`; unknown observations remain unknown; scoped confirmations | Keep all three boundaries | Keep reads, pure assessment, permission checks and reporting; add public engine-state reporting, not private-table inspection |
| Decide acceptance, integration, discard, lease return and pruning; check exact output retention and operator confirmations | Domain policy | `src/dispatch/{safety,policy,finish,prune}.ts`, `src/workspaces/retention.ts`; contract, `confirmations`, attempt entries | Keep | Keep, including fresh approval/owner checks immediately before effects |
| Inspect Git refs and retained artefacts; fast-forward an exact commit; return an exact lease with read-back | External adaptation | `src/workspaces/{retention,integration,treehouse}.ts`; Git refs, retained files, Treehouse leases | Keep | Keep; engine checkpoints cannot establish that an effect happened |
| Compose finish/discard with intent entries and read-back; archive/prune and complete deferred directory deletion | Execution machinery | `src/dispatch/{finish,prune}.ts`, `src/attempts/prune.ts`; `lease_return_started`, `lease_returned`, integration facts, archives and pending deletions | Keep; replace repeated composition with proposed small step runner | Replace execution ordering with Durable phases where useful; keep domain facts, deletion reconciliation and external-effect uncertainty checks |
| Database access, schema migrations, async busy retry; settled legacy imports | Execution machinery (storage), external adaptation (legacy decoding) | `src/database.ts`, `src/tasks/import.ts`, `src/attempts/{import,runtime-import}.ts`; schema version 4 | Keep | Keep application storage boundary and imports; add separate Durable storage, not a second task lifecycle |

The current transactional maximum is implemented (`AttemptStore.reserveAttempt`), but `dispatchOnce` still refuses **all** new dispatch while any earlier worker may be running, even with a fresh heartbeat. Setting a higher maximum alone does not implement Phase 3's relaxed blocking semantics.

### Proposed Phase 3 mechanisms

These are inventory/planning statements, not implemented A/B results.

| Mechanism in the Phase 3 PRD | Class | A: retain/replace/add | B: retain/replace/add |
| --- | --- | --- | --- |
| One database and transactions instead of short locks | Execution machinery | Already present; retain `Database` and transactional stores | Retain for domain atomicity; add engine store with its own commit boundary |
| Launch rows/fences, immutable for the attempt | Execution machinery enforcing a domain safety rule | Already present in `launches` and runtime storage; retain | Retain the exclusion/fence; no engine task replay may bypass it |
| Long-lived claims and heartbeats | Execution machinery | Worker claims exist; add an exclusive context dispatcher claim | Worker ownership evidence remains; add exclusive host ownership. Durable has no cross-process storage lock |
| Requests addressed to claims, first claim versus withdrawal | Execution machinery | Worker stop/message protocol exists; extend to dispatcher pause/resume/stop | Candidate host transport replaces dispatcher control delivery; retain worker at-most-once forwarding or prove an equivalent protocol |
| Separate reading, deciding and reporting; safety checks from facts | External adaptation / domain policy / execution machinery respectively | Already present; retain | Retain; task status is not authority |
| Scoped operator confirmations | Domain policy; persistence is execution machinery | Already present for existing operations; add publish/rebase scopes and consistent caller attribution | Same application records and checks; checkpoint arguments cannot grant approval |
| Shared finalisation operations and one step runner (no saved position or automatic replay) | Domain policy for permission; execution machinery for composition | Retain checks, extract operations and add typed planner/runner around existing `finish`/`discard` paths | Retain/extract operations; replace proposed runner with Durable task definitions/checkpoints, plus reconciliation around every external effect |
| Finalisation policy kinds as definitions | Domain policy | Refactor current manual/local-merge composition; add pull-request definition | Same definitions and checks; engine only executes the selected steps |
| Several attempts up to a maximum; fresh heartbeat blocks only its own task, uncertain worker blocks context | Domain policy; reservation is execution machinery | Retain transactional maximum; add relaxed blocking and approved rebase handling | Host may bound runnable workflows, but keep domain capacity admission and uncertain-worker refusal in application operations; do not equate engine task count with active attempts |
| Single foreground/background dispatch loop; detached host, pause/stop and diagnostics | Execution machinery | Extract start/supervise from foreground dispatch; add context claim, lifecycle and controls | Add one context execution host, client transport, request admission/lookup, ownership, startup/shutdown and failure reporting; foreground CLI submits/inspects/optionally waits rather than owning a second host |
| Periodic readiness/forge checks; no stored schedule in candidate A | Execution machinery | Add volatile loop intervals (30 seconds / five minutes by default) | Candidate persisted waits in a timed-wait-capable release; pinned 1.3.0 cannot supply these. Host wake/start responsibility remains |
| Pull-request publication, merge interpretation and retention | Domain policy / external adaptation | Add scoped `--publish`, GitHub adapter/policy and PR identity facts; never merge automatically | Same policy/adapter/facts; Durable cannot replace GitHub authority or operator approval |
| Runtime-neutral supervision and Claude ACP | Execution machinery / external adaptation | Supervisor extraction exists; add capabilities/profile/ACP qualification | Same work; not supplied by Durable and outside this probe |

### Record ownership and removal boundary

| Persistent record | Authoritative owner and purpose | A | B |
| --- | --- | --- | --- |
| `tasks`, `dependencies` | Switchboard database: project work, state, holds, ordering and readiness | Retain | Retain |
| `attempt_numbers`, `attempts` (including request reservations), `attempt_entries` | Switchboard database: attempt identity, caller deduplication and immutable domain/effect facts | Retain | Retain; do not copy an entire workflow journal into these entries |
| `confirmations` | Switchboard database: operator, fact, time and exact scope | Retain | Retain and revalidate; not engine-owned approvals |
| `launches`, `worker_claims` | Switchboard database: launch/fence exclusion, immutable input/session binding, current process ownership and heartbeat | Retain; add context claim | Retain worker safety evidence; add host ownership. Any reduction needs matrix evidence, not just a single-host assumption |
| `worker_observations`, `worker_activity`, `control_requests` | Runtime storage boundary in Switchboard database: observed session/exit, diagnostic activity, once-only control claims/results | Retain | Retain initially; possible transport reduction is unproven, not a claimed removal |
| `archived_attempts`, `pending_attempt_deletions` | Switchboard database: retained summary, non-reused attempt numbers, recoverable filesystem cleanup | Retain | Retain unless a later experiment proves a smaller ownership arrangement |
| Lease and workspace identity | Treehouse: allocation/return; Switchboard records correlation, not a duplicate lease ledger | Retain | Retain |
| Git refs and forge PR state | Git/GitHub: actual branch integration/publication/merge; application entries record inspected facts | Retain; add PR correlation | Same |
| Worker result, Pi sessions and artefacts | Worker/Pi files: claims, transcript and deliverables; Switchboard validates them, they are not acceptance authority | Retain | Retain |
| Dispatcher claim/control records and diagnostic log | Switchboard host: exclusive context ownership and operator control; log never authorises actions | Add | Replace candidate dispatcher protocol with explicit execution-host protocol; still enforce exclusivity |
| Durable task records, checkpoints, memos, submissions and documents | Durable store: execution progress only; no project-task acceptance, lease or process-termination authority | No Phase 3 store; separate supervisor store later | Add one exclusively owned store per context plus stable domain request/attempt-to-workflow correlation |

B's credible removal candidate is bespoke step ordering/progress/wait coordination, not domain operations, adapters or all attempt records. Exact deletions and line-count savings cannot be claimed before steps 3–5 of the plan. A would not add a checkpoint-position table. B must not retain both a full Switchboard execution journal and a full Durable execution journal merely to make status work.

A Durable commit and an application database transaction are not atomic, even in one process or one SQLite file. After a lost response, reuse the caller request ID, inspect the reservation/attempt and external owner, and return a specific unresolved state if necessary. Never turn an engine retry into another acquisition, worker launch or initial prompt. A host restart must preserve conservative refusal for possibly live workers; neither task cancellation nor direct-child exit proves all tool processes stopped. Lease return still requires the operator's scoped no-processes confirmation.

## Dependency qualification

### Tested release and provenance

The baseline deliberately tests the **published `@earendil-works/pi-durable` 1.3.0** discussed by ADR-0003, not mutable `main` or source merely labelled 1.3.0. `package.json` pins it exactly; `package-lock.json` pins all transitive packages and records the tarball integrity:

```text
sha512-2aD0xead1LH0BBwUBxex28in/PpUJEwyaEiW/nLoTFUcZ/lDYEl6LHX6mGZKJG8tUHzERwJyysDgy0ruidt84w==
https://registry.npmjs.org/@earendil-works/pi-durable/-/pi-durable-1.3.0.tgz
```

Directly imported `@earendil-works/chord` and `@earendil-works/pi-ai` are also explicitly pinned to 1.3.0. No model provider is installed in the harness registry and no model is called.

The npm provenance payload identifies upstream commit **`71023aec1546d6d677a65669c5665c0927ce0dd0`**, tag `v1.3.0`, workflow `.github/workflows/build-binaries.yml`. `git ls-remote --tags https://github.com/earendil-works/pi.git '*1.3.0*'` agrees. This was a metadata inspection, not independent cryptographic attestation verification. The package's bundled README was read, together with the following matching-revision documents (the tarball omits the specification and example files):

- [Normative specification](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/docs/spec.md), especially §§2.2, 4–6 and 10.1–11.
- [12-tasks.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/12-tasks.ts): explicit state-machine phases, effect sandwich and a payment keyed by task ID.
- [13-recovery.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/13-recovery.ts): SQLite close/reopen, checkpoint/memo inspection and resumed ticks.
- [24-child-tasks.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/24-child-tasks.ts): child ownership, fail-fast waits, cancellation and reopen.

The recovery example stores a memo before printing. That can suppress duplicate printing but a crash after the memo and before printing can omit the print. It is not proof of exactly-once external effects, and must not be copied as a worker-launch protocol.

### What this revision supplies

| Area | Published 1.3.0 documentation/examples and inspected API | Implication |
| --- | --- | --- |
| Tasks | `defineTask`, versioned input/checkpoints, explicit phases, `runtime.commit`, terminal receipts, memos; named extensions supply code on every open | Deterministic tasks need no model. A phase can rerun from its start; external effects require idempotency, inspection or interruption/refusal |
| Waits | Stored `waiting` state joins task IDs with `allSettled`/`failFast`; `waitForTask`/submission waits start scheduling. `runtime.sleep(until, context)` is an invocation-local timer | No persisted `sleeping` state, `sleepUntil`, wake-deadline API or host wake callback in the pinned package. A saved deadline plus custom phase logic is not the later scheduler feature |
| Request IDs | Submission `requestId` deduplicates within a conversation before writes; reusing it for another submission type rejects | Not a context-wide domain request reservation and not task-creation deduplication. Keep Switchboard request IDs stable across client retries and recovery |
| Storage | One process per store, no cross-process locking. JSONL uses main commit markers and task/document sidecars, retains history in memory. SQLite defaults to WAL / `synchronous = NORMAL` | Host must enforce exclusivity. Neither backend's defaults establish ADR-0007's power-loss guarantee |
| Recovery | Open changes surviving running tasks to pending with the saved checkpoint; missing/incompatible definitions block rather than disappear; explicit `resume()` or a progress-wait call enables scheduling | Inspection alone does not run work. Install definitions and check external uncertainty before enabling scheduling |
| Shutdown/errors | Close signals and joins invocations but writes no completion outcome. Storage failure fails/closes the session and rejects waits, with no automatic retry. Aborts are durable requests with bottom-up handlers | Report failures and unfinished work; never infer worker termination or permission to return a lease from engine cancellation |

### Source-only at the ADR checkpoint, and release availability now

[ADR-0003](../../docs/adr/0003-pi-durable-for-durable-orchestration.md) correctly distinguishes published 1.3.0 from later source commit `02726086d11c2911aa872959e308b90d69182392`, still labelled 1.3.0. At that source checkpoint, persisted sleeps (`runtime.sleepUntil`), stored sleep deadlines and host wake reporting existed only in unreleased source relative to the published package. They are absent from the tested tarball, not absent from every revision bearing that version number.

**Availability changed since that ADR inspection:** during this run `npm view @earendil-works/pi-durable dist-tags --json` returned `latest: 1.4.0`. A separate download/desk inspection of the published 1.4.0 tarball finds `sleepUntil`, persisted `sleeping` checkpoints, `now`/`setTimer`, `wake()` and `onWake` in its README/types. Therefore those features must **not** now be described as globally unreleased. No feature is claimed here to remain source-only across all currently published releases. This source comparison is not a source experiment, and 1.4.0 was not installed as the probe dependency or runtime-tested. Before the later timed-wait matrix, qualify and pin that newer release separately, including its changed restart behaviour; do not silently substitute it for this baseline. The historical source-only finding constrains 1.3.0, while current release availability removes a blanket “unavailable in npm” adoption objection. No ADR is changed or design selected by this task.

### Storage settings and limits

The smoke program uses `openNodeJsonlStorage(..., { fsync: true })`. The package README describes this briefly as flushing before the commit marker. The matching specification §11.3 is more precise: affected sidecars are flushed before appending the main marker, but ordinary publication does **not** explicitly flush `main.jsonl`. An acknowledged tail commit can disappear on power/host failure. Main is flushed before destructive reclamation; non-empty replacement files are flushed before rename. Inspected compiled JSONL code agrees with this distinction.

Thus this file backend, even with `fsync: true`, is **not qualified as equivalent** to Switchboard's `synchronous = FULL`, `fullfsync = ON`, `checkpoint_fullfsync = ON` application database. A surviving external effect with a lost execution record still requires inspection/refusal, not replay. This test establishes process-restart recovery at an acknowledged checkpoint only, not power-loss durability, filesystem failure handling, schema upgrade safety or exclusive ownership.

## Minimal restart probe

`smoke.ts` defines one two-phase deterministic task and a session document holding its ID. Task creation and ID recording share one Durable commit. It uses file storage, no conversation inputs or generation tasks, and no Switchboard imports.

1. A fresh process creates the task; its `prepare` phase appends an independent diagnostic line, commits the `finish` checkpoint with a stable sample request ID, then calls `process.exit(75)` without closing the harness.
2. A second process reopens the same JSONL directory, checks the original task is pending at `finish` with that request ID, then waits for its terminal receipt. Only `finish` runs.
3. A third process reopens read-only at the harness level, verifies the terminal receipt and no live tasks, then closes.

`smoke.test.ts` runs these processes sequentially with bounded timeouts, verifies the same task ID and exactly one line for each phase in a file outside Durable storage, and removes its unique temporary directory. The diagnostic log is deliberately not an exactly-once external-effect implementation: crashes around its append are not tested. This is neither a worker lifecycle test nor the common scenario/failure matrix from steps 3–6.

From the repository root, on Node.js **26.7.0**:

```sh
npm install --ignore-scripts
npm ci --prefix investigations/durable-orchestration --ignore-scripts
npm test --prefix investigations/durable-orchestration
npm run check
npm test
```

For a retained manual run, use a fresh directory (do not run two processes against it concurrently):

```sh
mkdir -p .investigation/durable-orchestration/manual
node investigations/durable-orchestration/smoke.ts start .investigation/durable-orchestration/manual
# Expected exit status 75, deliberately, without harness.close().
node investigations/durable-orchestration/smoke.ts resume .investigation/durable-orchestration/manual
node investigations/durable-orchestration/smoke.ts inspect .investigation/durable-orchestration/manual
```

### Results

On macOS, Node `v26.7.0`, the automated probe passed: task ID 7 resumed from `{ status: "pending", checkpoint: { phase: "finish", requestId: "baseline-1" } }`, the independent phase log contained `prepare` once and `finish` once for task 7, and the terminal outcome was `{ status: "completed", result: "checkpoint recovered" }`. These numbers are one fixture's IDs, not production identity semantics.

Repository validation: `npm run check` passed; `npm test` passed with 403 tests, 402 passed, one skipped, zero failed. The isolated probe is intentionally not added to the production test script. A separate strict TypeScript check of both probe files also passed using the repository compiler:

```sh
node_modules/.bin/tsc --noEmit --strict --target esnext --module nodenext --allowImportingTsExtensions --skipLibCheck investigations/durable-orchestration/smoke.ts investigations/durable-orchestration/smoke.test.ts
```

### Remaining work, not conclusions

Steps 3–7 remain: shared fake adapters/counters and refusal contracts, A/B implementations, full interruption matrix (including SIGKILL, lost acknowledgements and concurrent clients), real disposable Pi/Treehouse integrations, ownership enforcement, upgrade/reopen, storage durability and supported-platform qualification, code-removal estimates and a decision proposal. No automatic recovery policy or worker containment has been added. A working checkpoint happy path neither selects Durable nor justifies retaining Switchboard-owned execution.
