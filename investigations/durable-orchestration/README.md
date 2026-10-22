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

At the end of steps 1–2, steps 3–7 remained: shared fake adapters/counters and refusal contracts, A/B implementations, full interruption matrix (including SIGKILL, lost acknowledgements and concurrent clients), real disposable Pi/Treehouse integrations, ownership enforcement, upgrade/reopen, storage durability and supported-platform qualification, code-removal estimates and a decision proposal. Step 3 is recorded below. No automatic recovery policy or worker containment has been added. A working checkpoint happy path neither selects Durable nor justifies retaining Switchboard-owned execution.

## Step 3 – shared scenario contract

Added on 22 October 2026. This completes the common test-scenario step only. Neither design A nor design B is implemented by this addition. The earlier dependency qualification and its pinned 1.3.0 release remain unchanged.

### Inputs and outcomes

`scenario/contract.ts` is the typed, engine-independent contract. A request supplies a non-empty stable `requestId`, a `taskId` and a frozen delivery contract: exact output branch, required evidence names, required deliverable names and acceptance gate (`review` or `forge_merge`). A repeated ID must identify the same inputs and the same attempt, including after a client loses its response. Changed inputs refuse with `request_conflict`. An accepted task cannot be dispatched again merely by supplying a fresh request ID.

The fixture, not request or worker arguments, supplies context identity, configured capacity, clock, readiness, owner observations and scoped operator approvals. `FakeOwners` is test control infrastructure, not a model-facing tool. The abbreviated worker result has the full scenario identity (context, task, attempt, lease and session), outcome, exact branch/commit and named evidence/deliverables. It is a deliberately small fake contract, **not** a replacement for production `WorkerInput`/`WorkerResult` schemas or actual Git retention checks. The step 3 exerciser imports no production code and changes none. Step 4's Design A imports existing application operations, as recorded below.

| Common step | Inputs and domain checks | Outcome and acknowledgement |
| --- | --- | --- |
| 1. Reserve | Stable caller ID, frozen delivery, current readiness and context maximum; capacity admission and task exclusion must be serialised by the domain owner | One attempt; `reserved`. Invalid, conflicting, unready or full requests have no acquisition or launch |
| 2. Acquire | Context/task/attempt correlation supplied to the workspace owner | One exact lease/session binding; `workspace`. A lost acquisition response requires owner inspection or `acquisition_uncertain`, never blind reacquisition |
| 3. Start and launch | Recheck readiness after acquiring; record start before launch; use the recorded binding | `started`, then one launch (`launched`) and one initial prompt (`prompted`). Uncertainty refuses as `possibly_running`; restart never grants permission to adopt, relaunch or reprompt |
| 4. Observe | Positive external exit receipt plus result identity, completed outcome, commit/branch and every required evidence/deliverable | Validated `result`, or `invalid_result`. Missing exit remains `waiting/worker`; no process seen is not proof of success |
| 5. Wait | Review or forge evidence for the **exact result commit**; the test/operator drives it, not a model | `waiting/review`, rejected review, or one `review` acknowledgement despite duplicate signals. No lease return or task acceptance merely because the worker completed |
| 6. Finalise | Recheck current owner readability, retained commit, clean workspace and unexpired operator approval scoped to attempt/lease/commit. Record done before return; recheck authority and retention before returning and require explicit no-processes confirmation | `accepted`, `done`, external exact-identity return, `returned`, then `completed`. Approval, task completion and lease return are separate facts; partial completion remains visible |

`ScenarioDriver` exposes `submit`, `advance`, `inspect` and `cancel`, without Durable types. Submission or advancement returns `waiting` (worker/review), `completed`, or `refused` with stable code, non-empty operator next action and an attempt ID when known. `inspect` presents domain facts and active/capacity counts, not engine-private tables. Cancellation requests are observable separately from exit; `cancelled` always retains an unresolved lease and never counts as termination evidence.

All refusal codes and their next actions are enumerated in `refusalActions`:

| Codes | Required response |
| --- | --- |
| `invalid_request`, `request_conflict` | Correct the input or reuse the original frozen request |
| `not_ready`, `capacity` | Inspect readiness or wait for domain capacity; no external effect on refused admission |
| `acquisition_uncertain`, `possibly_running` | Inspect the external owner; preserve the lease; never acquire, launch or prompt again blindly |
| `invalid_result`, `review_rejected` | Inspect result/evidence or ask the operator to review retained work |
| `approval_required`, `process_confirmation_required` | Obtain current, correctly scoped operator authority; worker/model arguments cannot provide it |
| `not_retained`, `owner_unknown` | Repair retention or inspect the unknown owner before a protected action |
| `finalisation_uncertain` | Inspect integration/return owners instead of repeating a possibly completed effect |
| `cancelled`, `host_unavailable` | Inspect cancellation/host/storage state and confirm termination separately; no automatic replacement worker |

A later design may recover by inspecting owner evidence and acknowledging the discovered effect, or refuse with the corresponding action. It must not turn an uncertain receipt into another destructive or publishing call. These are scenario codes, not changes to production CLI reason codes.

### Independent fake owners and storage

`scenario/owners.ts` supplies fake workspace acquisition/return, worker launch/prompt/exit/cancellation and forge review/merge operations. Each invocation writes a **new**, exclusive, flushed JSON receipt in `owners/effects/<random-id>.json`. Receipts include effect kind, attempt correlation and the relevant identity, result or exact commit. Reads and counters scan those files afresh. Counters never consult the execution design's acknowledgements, checkpoints or claimed outcome. In particular, calling launch or prompt twice leaves count **2**; the adapter does not hide duplicate calls through idempotency. Duplicate review signals likewise remain independently visible.

Each fixture uses sibling directories under `.investigation/durable-orchestration/<unique-run>/`:

- `owners/` – external effect receipts and atomically replaced `controls.json`; survives killing or deleting the execution host.
- `host/` – execution-design storage, disposable independently of the owners. The in-process exerciser has no durable execution state; the kill-test child writes only a canary here.

The adapter rejects lexically overlapping owner/host roots. These are test-owned paths without symlinks, not a production filesystem security boundary. `controls.json` belongs to the test/operator: readiness, owner readability, retained commit, cleanliness and approvals. Approvals name the operator, attempt, lease, commit, expiry and separate acceptance/no-processes facts. Request arguments and worker output cannot modify them.

Ordinary effect receipts use Node's `writeFile(..., { flag: "wx", flush: true })`; control updates flush a temporary file before rename. No directory fsync, atomic owner/application commit, filesystem-failure recovery or power-loss guarantee is claimed. A kill during an uninstrumented file write could leave an unreadable receipt, which must be treated as unknown rather than permission to repeat an effect. The tests kill only at explicitly reported before/after boundaries. This storage does not qualify Durable's backend or supersede the durability limitations recorded above.

### Interruption protocol

`interruptionPoints` enumerates **38** names:

- `<effect>:effect:before` and `:after` for `acquire`, `launch`, `prompt`, `worker_exit`, `review`, `merge`, `return`, `cancel`.
- `<acknowledgement>:ack:before` and `:after` for `reserved`, `workspace`, `started`, `launched`, `prompted`, `result`, `review`, `accepted`, `done`, `returned`, `cancelled`.

Effects are bracketed in the fake adapter; acknowledgements use `acknowledge(name, interrupt, record)`. A/B must put the actual domain-record or execution checkpoint write inside `record`, not report an acknowledgement before it commits. Domain facts and engine progress are still distinct owners; this hook does not make their writes atomic. Additional engine checkpoint boundaries should be named and tested in those implementations rather than mislabelled as external effects.

`pauseAt(point)` sends an IPC marker and stops at that exact boundary until its parent kills it. `interruptions.test.ts` forks `interruption-child.ts`, waits for the marker, reads independent receipts, sends **SIGKILL**, joins the child, deletes all `host/` storage and reads the same receipts through a new adapter. It checks the expected 0/1 counts for every effect. All 38 named points are exercised, including launch/prompt success before acknowledgement and return success before acknowledgement. Child processes have bounded waits and are killed/joined on test failure too. There is no detached host or graceful close that could conceal the interruption.

These tests qualify boundary placement and survival of fake evidence, **not A/B recovery**. The in-process domain acknowledgements are volatile; killing that runner is intentionally not a restartable implementation. The parent never tries to reconstruct it or rerun its worker.

### Shared assertions and hand-off

`scenario/assertions.ts` checks request/attempt uniqueness, capacity, independently counted acquisitions/launches/prompts/returns/merges, exact identity correlation, validated output, retained unresolved leases and successful finalisation. It counts effects even if no matching acknowledgement appears in host state. `scenario/common-tests.ts` exports `defineCommonTests(name, createFixture)`, which imports neither execution implementation. It exercises both review gates, lost client responses/retries, frozen request conflicts, admission at maxima 1 and 2, waiting without exit, invalid results, duplicate/rejected review, missing/stale/wrong-scope/model approvals, retention, process confirmation, cancellation, and readiness/approval changes between steps. Duplicate review assertions also count the shared acknowledgement hooks, not just a final boolean.

For step 4, implement `ScenarioDriver` separately for A and B, then register **the same** `defineCommonTests("A", createA)` and `defineCommonTests("B", createB)`. Each fixture must supply the same fake owners and controlled clock, honour `maxAttempts` and the supplied interruption hook, expose domain facts via `inspect`, and close/join its host before cleanup. Neither design may derive counters from its own execution state or manufacture operator approval from workflow inputs. `assertSafe`, `assertRetained`, `assertRefused` and `assertSuccessful` are also reusable by the later process-recovery harness.

`scenario/reference.ts` is only a trivial in-process contract exerciser. Its promise queue serialises admission within that process; it has no database, transport, claim, persisted wait or restart mechanism and must not be counted as design A. It preserves a conservative unresolved outcome around an uncertain external call and never retries that call. The fake merge is driven only by the fixture/operator; the runner never requests a merge. The separate-process children in this step are execution-host kill targets, **not** real external workers. Lightweight worker lifecycle/containment evidence, two real CLI clients, host exclusivity, storage failures, reopen/upgrade, deadlines and the full recovered-operation matrix remain steps 4–5; real Pi/Treehouse runs remain step 6. No A/B simplification or adoption conclusion follows from this contract suite.

### Commands and results

From the repository root:

```sh
npm install --ignore-scripts
npm ci --prefix investigations/durable-orchestration --ignore-scripts
npm run check --prefix investigations/durable-orchestration
npm test --prefix investigations/durable-orchestration
npm run check
npm test
```

The isolated check uses the repository's existing development compiler with the local `tsconfig.json`; no runtime dependency was added or upgraded. Production test/check scripts and `src/` are unchanged. Temporary fixtures are removed after each test; retained manual diagnostics must also stay under `.investigation/`.

On macOS with Node **v26.7.0**, the shared suite passes against the in-process exerciser, and every named kill point preserves exactly the expected owner receipts after deleting host storage. These are single runs per boundary, not repeated reliability or power-loss experiments. The existing Durable smoke test is still included. Validation passed: the isolated check and all **69** investigation tests (38 kill boundaries, 30 scenario/adapter tests and the existing smoke test), repository `npm run check`, and repository `npm test` (**419** tests: 417 passed, two skipped, zero failed). The earlier 403-test baseline above is historical. Linux/Windows kill semantics and real integrations have not been qualified here.

## Step 4 – Design A: Switchboard-owned execution

Implemented on 22 October 2026, starting from **`eb7fd53b989242ac67d9a0e1ba3e63a4be27ba09`**. This implements **A only**, not B, the recovered-process failure matrix, real Pi/Treehouse integration or an architecture recommendation. The previous sections are historical findings from steps 1–3. No production source, dependency, authoritative task record, Treehouse lease, Git publication or merge was changed. Only disposable fixture tasks are created and mutated. No model or agent is launched.

`design-a/driver.ts` implements `ScenarioDriver` directly, without inheriting from the in-process reference. The exact same `defineCommonTests("A", create)` suite now runs against an on-disk application database and the shared independent owners. Both review and simulated-forge-merge paths complete all six steps and pass `assertSuccessful`. Missing/stale/scoped approvals, model-controlled arguments, readiness changes, invalid results, duplicate review and capacity refusals use the same assertions as the reference. The fake forge's merge is still a fixture/operator action, never an orchestration action.

### What is already Switchboard code

These operations are **imported and executed**, not copied or reimplemented in the prototype:

| Responsibility | Existing code actually used |
| --- | --- |
| Database schema, WAL and flushed commits, asynchronous busy retries | `Database` through `SqliteTaskStore.open`; retains `synchronous = FULL`, `fullfsync = ON`, `checkpoint_fullfsync = ON` |
| Fixture task creation/reading, dependency readiness and operator holds | `SqliteTaskStore` |
| Context-unique caller reservation, capacity and per-task exclusion | `AttemptStore.reserveAttempt`; admission remains in its `BEGIN IMMEDIATE` transaction |
| Revalidate readiness and start task plus entry atomically | `AttemptStore.startReservedTask` |
| At-most-one launch permission and runtime identity binding | `RuntimeStore.claimLaunch` and `bindingSchema`; the immutable production launch row is written **before** calling the worker owner |
| Observe exit, release the current invocation's worker claim | `RuntimeStore.recordObservation` and `releaseClaim`; a reopened invocation does not adopt another invocation's claim |
| Validate the translated fake report under the production delivery schema | `validateWorkerResult`, in addition to the shared `validResult` check (which also checks the scenario-only attempt ID) |
| Close worker capacity and hold work for review without overwriting operator edits | `AttemptStore.recordOutcome`, with `review_required`; a waiting review does not consume capacity |
| Assess recorded facts and external observations; decide acceptance, finishing and return | `assessAttempt`, `checkCanAcceptOutput`, `checkCanFinish`, `checkCanReturnLease` |
| Record scoped output acceptance and no-processes confirmation; record task done and exact lease return | `AttemptStore.appendConfirmed`, `finishAttempt`, `append`, including expected-record and expected-task checks |

The prototype does **not** call all of `dispatchOnce` or `finish`. They currently combine foreground ordering, concrete runtime/retention reads and operations the comparison needs to separate. Calling them wholesale would either bypass the shared wait scenario or require a production refactor solely for the experiment. The existing store transactions and safety operations are practical reuse points. Actual Pi RPC transport, `WorkerSupervisor`, Git retention, layered finalisation policy and Treehouse adaptation remain production inputs, not claimed replacements.

### What the prototype adds

- **Foreground composition, not a daemon:** `SwitchboardScenario.submit` reserves, acquires, revalidates, claims a launch and prompts once. `advance` inspects exit/review evidence and executes finalisation. The fixture supplies readiness changes, review signals and explicit calls to advance; there is no model polling, stored schedule or automatic retry. The promise queue serialises calls within an invocation, while the existing database transaction enforces admission capacity.
- **A small typed step runner:** `steps.ts` runs accept/done/return steps, checking whether each happened using application facts. It has no saved position, graph, undo or automatic replay; unexpected failures name the stopped step. Each protected action reads fresh owner controls and production assessment facts. Acceptance, task completion and lease return remain separate facts.
- **A contract/application adapter:** `store.ts` translates the abbreviated fake result and fake lease observations into production schemas and assessment inputs. It also freezes the shared request's exact output branch and gate, fields the existing `requested` entry does not fully represent. Shared fake owner controls stand in for actual Git retention and scoped operator approval expiry; these are not new production rules.
- **Conservative uncertainty markers:** acquisition/prompt/cancellation intents are inserted before effects; the existing launch row and lease-return intent protect launch and return. A retry finds the same attempt, cached response or a specific unresolved refusal. A lost acknowledgement never leads to another acquisition, launch, prompt or return. Return is read back from the independent exact-identity receipt before recording `lease_returned`. A pending return intent causes inspection/refusal rather than a repeated external call, even if this is more conservative than production's current finish reconciliation.
- **A lightweight real child:** `process-owners.ts` and `worker-child.ts` replace only the fake worker, keeping fake workspace and forge owners. The child independently records its one prompt and writes its result under `owners/workers/`, outside host storage. It deliberately waits after writing the result. The parent records positive exit evidence only after observing the actual child exit; result-file presence alone leaves the attempt waiting. Review and explicit scoped no-processes approval are still required afterwards. The test kills/joins any remaining child on cleanup; this is not an agent, containment implementation or proof about tool descendants.

A fresh invocation never reattaches to an external worker. If its initial prompt was acknowledged but no exit is observed, `advance` and new dispatch refuse `possibly_running`, regardless of spare capacity. A positive identity-checked exit receipt may be validated on an explicit later advance; that is result recovery, not worker adoption. Acquisition, launch or prompt uncertainty remains an operator refusal. Ordinary storage/adapter exceptions produce `host_unavailable` with an error and operator action; an already committed uncertainty response remains discoverable on retry.

### Design A's persistent ownership

Every application and prototype table is in `host/switchboard.db`. There is no second engine store and no cross-store application/checkpoint transaction. External receipts are still separate commits and must be inspected; SQLite cannot make their effects atomic with domain records.

| Record | Authority and purpose |
| --- | --- |
| Production `tasks`, `dependencies`, `attempt_numbers`, `attempts`, `attempt_entries`, `confirmations` | Switchboard: project readiness, stable request/attempt identity, capacity, immutable start/outcome/acceptance/return facts and exact operator scopes. No duplicate full `Attempt` object is saved by A |
| Production `launches`, `worker_claims`, `worker_observations` | Switchboard runtime boundary: one immutable launch permission/binding, process ownership claim and positive direct-child exit observation. This prototype does not populate activity/control-request tables or run a heartbeat loop |
| `prototype_requests` | Prototype application adapter: immutable shared input and stable scenario attempt UUID. Written before reservation; a refused admission can leave input without an attempt. It freezes inputs but is not a second capacity reservation |
| `prototype_facts` | Prototype application adapter: only fields absent from the existing application records – session correlation before launch, acquisition/prompt/cancellation intents and acknowledgements, full validated abbreviated report and exact-commit review acknowledgement. Immutable names per request; no workflow cursor. The report is copied here because shared fake exit receipts replace worker files; production should read retained worker files, not add a second report ledger |
| `prototype_responses` | Prototype response cache: last returned typed outcome for caller retry. Never grants acceptance, approval or return authority; advancing recomputes from current facts and owners |
| `owners/effects/`, `owners/controls.json` | Independent fake workspace/worker/forge owners and fixture/operator authority. Counters are scanned from their exclusive flushed receipts, never derived from the application tables |
| `owners/workers/` in the child test | External synthetic worker: independent prompt log and result file. Not execution-host progress or acceptance authority |

`store.ts` creates only prototype-local tables alongside the existing schema in disposable databases; it does not implement or authorise a production migration. Writes across several application calls can still be interrupted between transactions. The corresponding external intents and positive receipts permit conservative inspection/refusal, not an exactly-once claim or a power-loss qualification.

### Further production work, not implemented here

Production A would still need the Phase 3 extraction of shared dispatch/finalisation operations, the foreground/background dispatch loop, dispatcher claims and controls, heartbeat supervision, interval checks, status/diagnostics, policy definitions and forge adaptation. The prototype's several-attempt path uses one invocation's live ownership set; it is **not** the production cross-process fresh/stale/future-heartbeat blocking rule. The production transaction enforces its maximum, but two real CLI clients and the full dispatcher lifecycle remain matrix work.

The supplemental schema is a disposable shortcut, not a proposed second domain model. Production integration would put missing frozen contract/review/intent facts at the appropriate application/runtime boundary, retain worker-owned reports as files, and use the existing real retention and authority operations rather than fake controls. It would wire the real runtime supervisor and adapters into the shared operations without the fabricated workspace paths used here. There is no host transport, detached process, daemon startup, exclusive-context dispatcher claim, automatic restart, platform qualification, upgrade migration or storage-failure injection in this implementation.

The application bridge and deterministic composition are new code, not an estimate of code Durable would remove. Physical line counts (including comments and blank lines) are reproducible with `wc -l investigations/durable-orchestration/design-a/*.ts`:

| Added code | Lines |
| --- | ---: |
| Driver and step runner | 301 |
| Application/schema translation bridge | 195 |
| Synthetic process adapter and child | 107 |
| A-specific tests, including shared-suite registration | 206 |
| Total | 809 |

No production adapter implementation was copied: `store.ts` is new translation/glue and `process-owners.ts`/`worker-child.ts` are new test-only adaptation. Some step ordering and approval/retention guards intentionally overlap existing `dispatch.ts`/`finish.ts`; production would extract and share them. The 149-line reference exerciser is not used by A and must not be presented as its execution-code cost. There is no production deletion or net code-saving claim from this successful path.

### Commands and evidence

From the repository root:

```sh
npm install --ignore-scripts
npm ci --prefix investigations/durable-orchestration --ignore-scripts
npm run check --prefix investigations/durable-orchestration
npm test --prefix investigations/durable-orchestration
# A only, including the real child lifecycle test:
node --test --test-timeout=30000 investigations/durable-orchestration/design-a/driver.test.ts investigations/durable-orchestration/design-a/process.test.ts
npm run check
npm test
```

All generated state is under ignored `.investigation/durable-orchestration/design-a-*`; every fixture closes its database and joins its child before removing the directory. The test-runner child is ordinary foreground-owned test infrastructure, not a detached execution host.

On macOS/Darwin arm64, Node **v26.7.0**, the isolated TypeScript check and all **107** investigation tests passed: **38 A tests** (the unmodified 28 shared assertions, nine application/uncertainty/reopen tests and one real-child test), plus the existing 69 tests. A's four lost-effect-acknowledgement tests inject adapter exceptions after acquisition, launch, prompt and return, reopen the database and verify unchanged independent counters after retry. They are **not** SIGKILL recovery tests. The 38 existing SIGKILL boundary tests still qualify the shared owner fixture/reference, not A's recovery. Each suite invocation runs each case once; development reruns are not a repeated crash/reliability study.

Repository validation also passed: `npm run check`; `npm test` – **419** tests, **417 passed**, two platform-specific skips, zero failures. These successful paths and narrow reopen checks do not select A or B. Design B, A/B hard-kill and concurrent-client matrix runs, deadlines, exclusive host ownership, interrupted upgrade/reopen, storage faults/power loss and real Pi/Treehouse integrations remain later work. No claim of descendant termination or permission for automatic workspace return follows from the child test.

## Step 4 – Design B release qualification

Added on 22 October 2026. The preceding 1.3.0 results are historical. **B uses the latest published release, 1.4.0**, checked with `npm view @earendil-works/pi-durable version dist --json` before implementation. The investigation's own manifest and lockfile now pin Durable, Chord and pi-ai to **1.4.0**; production dependencies are unchanged. No provider is registered and no model is called.

```text
https://registry.npmjs.org/@earendil-works/pi-durable/-/pi-durable-1.4.0.tgz
sha512-EtIyXH1MBSXdJSkodmy+CYXuwfve3gPrD4GNCZ0XmuRWLPupwRlNQ7fdaXjRcLoKb6SWkT/yEzK+sMmrqvYK+Q==
upstream: 4a080252f06caf63a525d7873c5d94d3c23887e0 (tag v1.4.0)
```

The npm [attestation endpoint](https://registry.npmjs.org/-/npm/v1/attestations/@earendil-works%2fpi-durable@1.4.0) contains a SLSA provenance payload naming that commit, repository `https://github.com/earendil-works/pi`, tag and `.github/workflows/build-binaries.yml`. `git ls-remote --tags https://github.com/earendil-works/pi.git '*1.4.0*'` agrees. This is metadata inspection, not independent verification of the attestation signature. npm verifies the locked tarball integrity on installation.

Read the installed README, 1.4.0 changelog, [matching specification](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/docs/spec.md), and matching `test/examples/{12-tasks,13-recovery,24-child-tasks}.ts` before implementing B. The source examples were inspected, not silently substituted for the published runtime. The relevant specification contracts are:

| Feature | 1.4.0 specification | Consequence for B |
| --- | --- | --- |
| Deterministic tasks and commits | §§4–5.2: explicit phases, full replacement checkpoints, effects outside the Session transaction; an interrupted phase reruns from its top | B needs no conversation input or generation task. Application intents/fences and independent owner inspection remain necessary around effects |
| Durable waits | §5.6: `runtime.sleepUntil()` stores `sleeping`, `until` and the next checkpoint, resolves when stored, and ends the invocation. Returning `sleeping` from `runtime.commit()` is equivalent and atomic with document writes | B uses the latter to publish an observable response and persist the next worker/review check together. No custom application deadline or live invocation is held during a wait |
| Wake ownership | §§2.2, 5.6: reopen retains sleeps; due work needs scheduling enabled. `onWake` disables engine sleep timers and reports `active`/earliest `at`; the host must arm its own alarm and call `resume()` | Normal B keeps its Node host running and uses Durable's timer. Controlled-clock fixtures use `onWake` and explicit clock advancement/resume instead. Neither mechanism starts a stopped process; an operator must start the host |
| Crash-loop guard | §5.4: each surviving running task accrues a restart; default limit five without a changed task state parks it as `blocked/restart_limit`, reports `task_parked`, excludes it from active wake work. Graceful close does not count; memos or document-only commits do not reset it | B exposes public inspection/reports, never resets the limit or automatically invokes `retryTask`. A parked task needs operator diagnosis; retrying a workflow is not authority to relaunch a worker. All simultaneously running tasks can accrue counts, not only a culprit |
| SQLite upgrade | §11.2 and changelog: opening migrates to schema 2 in one transaction, rebuilding the task table for `sleeping`; 1.3.0 cannot reopen it | B uses a fresh, separate disposable `durable.db`. Production would need an offline backup, compatible definitions and an explicit no-downgrade rollout. Unfinished-work upgrade qualification remains an adoption gate; no production migration is authorised |
| Deduplication and authority | §§2.2, 6: conversation submission request IDs do not deduplicate arbitrary task creation | B commits its caller-ID-to-task index with task creation, and retains Switchboard's transactional request/attempt reservation. An engine completion is not task acceptance |
| Close and failure | §§2.2, 10.1: close seals, signals and joins invocations but supplies no external-worker termination evidence; a storage error fails the Session without retry, and a thrown operation may have committed | Host errors remain visible and leases retained; request retries retain their ID. No shared-file or in-process atomicity is assumed |

The baseline restart probe was rerun against the installed **1.4.0** package with `node --test investigations/durable-orchestration/smoke.test.ts`. It passed: task **7** reopened pending at `finish`, with request `baseline-1`, and became terminal with `checkpoint recovered`; the independent log contains `prepare` once and `finish` once. The only probe source adjustment is the now-required explicit `checkpointWhen` on its document. The deliberate exit remains status 75 without `Harness.close()`. This is still JSONL process-restart evidence, not a power-loss or SQLite upgrade claim.

B uses SQLite's documented default **WAL / synchronous NORMAL** in its engine store, not the application's FULL settings. This deliberately exposes the release's default adoption constraint. The earlier JSONL fsync caveat still applies to the smoke probe. Domain exclusion facts remain in the FULL application database; if an engine checkpoint is lost after an external effect, those facts and independent receipts must cause inspection/refusal rather than a second effect. Neither backend is power-loss qualified by these tests.
