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

## Step 4 – Design B: Durable-owned execution

Implemented from Switchboard **`7bff959a5749b0785601e872851123634af8a965`**, on macOS/Darwin arm64 and Node **v26.7.0**. This is B's common scenario and execution host, not a production integration or the complete step 5 failure matrix. The original A implementation is unchanged. There are no `src/` changes, production dependencies, real task mutations, real Treehouse operations, agent launches, model calls, publishing or merging. All task-store mutations here are disposable fixture work.

### Execution and application boundary

`design-b/engine.ts` installs one versioned deterministic Durable task definition with phases `reserve → acquire → start → launch → prompt → observe → review → accept → done → return`. Each admitted caller request has one task; task creation and its caller-ID index entry share a Durable commit. This is **not** `Conversation.submit()` deduplication. Request input is frozen, checked for conflicts and correlated with the application reservation by the original caller ID. Both review and simulated-forge-merge gates use the unmodified `defineCommonTests` suite, through actual HTTP clients.

`design-b/operations.ts` supplies the domain operations and adapter calls, rather than inheriting from A's driver or running its step runner. It reuses `design-a/store.ts` as the **same application bridge**: production `SqliteTaskStore`, `AttemptStore`, `RuntimeStore`, `validateWorkerResult`, `assessAttempt` and operation-specific safety checks still own readiness, transactional capacity, task exclusion, start, result interpretation, review hold, exact confirmations and finalisation. Durable does not define those rules. The current production foreground `dispatchOnce` and `finish` are not called wholesale for the same reason as in A: their concrete adapters and composition do not expose the shared scenario's individual operations. Production integration still needs that extraction, not another copy of policy.

Worker/review waits commit an observable response and a persisted `sleeping` checkpoint together in **Durable**, then release the invocation. The default polling interval is **250 ms**, deliberately short for a fixture, not a recommended forge API interval. Normal hosts use Durable's scheduler/timer; fixture clocks use `onWake` and explicit `advance` to move the engine clock to a stored deadline and call `resume()`. Approval expiry still uses the fixture-supplied domain clock; both clocks are `Date.now` in the ordinary host. `advance` waits for another committed response; it does not implement the workflow or own a worker. Normal execution continues when no client is connected. No model is asked what to do while waiting. Read/permission waits may run again; an external-effect error is terminal and is never automatically retried.

Each acquisition and prompt has an application intent before its external call; launch has the existing immutable launch row; return has its application intent, fresh permission check and exact-owner read-back. Recovered pre-worker phases inspect independent receipts and refuse acquisition/worker uncertainty rather than automatically launch, adopt or reprompt. A recovered worker wait without positive exit evidence becomes `possibly_running`, including on a retried submit, and blocks new domain admission even with spare capacity. A positive identity-validated exit receipt may supply result recovery; it is not worker adoption. Review/finalisation recovery checks current controls, exact-commit review/merge evidence, retention, scope and expiry again. A newly rejected review blocks acceptance even after an accepted review checkpoint. A lost return acknowledgement remains uncertain, not permission to call return twice.

`design-b/host.ts` is one foreground execution host for one disposable context root (the shared scenario's context ID is `scenario`). It alone opens both databases and holds worker handles through its owner adapter. `ProcessOwners` and its real synthetic child are imported from A, not copied. The child independently records its prompt and result outside host storage and deliberately remains alive after writing its result. B observes its positive exit before validating completion, then still requires review and scoped operator no-processes approval. Shutdown joins the host's known synthetic child without manufacturing a successful exit receipt or returning its lease. This is no containment or descendant-termination claim.

### Persistent ownership in B

The following is the complete record boundary for this prototype; unused production schema is identified rather than counted as another active execution journal.

| Record/location | Authoritative owner and purpose |
| --- | --- |
| `config.json` | Fixture/operator: host capacity configuration. The public request API cannot set capacity, readiness or approval. Production would validate context identity and configuration compatibility across starts |
| `host/owner/claim.json` and its exclusively created directory | Host: exclusive context ownership, random owner ID, PID and start time. Created **before either storage opens**. A claim surviving a crash blocks all replacement hosts; age or a dead-looking PID never permits takeover |
| `host/owner/endpoint.json` | Host: routing to its loopback port and bearer token, correlated by owner ID. Published only after storage and transport are ready; removed only after transport, engine and known worker handles close. It is not an attempt or approval record |
| `host/switchboard.db`: `tasks`, `dependencies` | Switchboard application: project-task readiness, dependencies, operator edits and final state, never inferred from a Durable outcome |
| `attempt_numbers`, `attempts`, `attempt_entries`, `confirmations` in that database | Switchboard application: stable caller/attempt reservation, maximum and per-task exclusion, frozen contract, immutable start/outcome/acceptance/return facts and exact operator scopes. Changes that belong together use existing application transactions |
| `launches`, `worker_claims`, `worker_observations` | Switchboard runtime boundary: immutable launch exclusion/binding, ownership of this invocation's channel, positive exit evidence. A restart does not adopt a previous claim. Heartbeat/activity/control-request loops are not simulated by this prototype |
| `prototype_requests` | Shared application bridge: original shared input and scenario attempt UUID, written before reservation. It freezes additional fake-contract fields absent from the production entry schema; it is not another capacity counter |
| `prototype_facts` | Shared application bridge: session correlation, acquisition/prompt/cancellation intents and acknowledgements, the abbreviated validated fake result, exact-commit review acknowledgement. These are domain/adaptation facts, **not a workflow cursor**. The result copy is an inherited fake-file shortcut; production should read retained worker-owned files rather than add this report ledger |
| `prototype_responses` | Created by the reused bridge but **empty in B**. B never writes A's application response cache. A specific test verifies this; all execution response publication is engine-owned |
| Other application schema (`worker_activity`, `control_requests`, archives, pending deletions and schema bookkeeping) | Existing Switchboard storage. No activity/control/archive/prune records are populated by B; schema/migration metadata still belongs to the application. No second dispatcher-control journal is added |
| `host/durable.db`: `tasks` | Durable: task input, current phase/poll checkpoint, persisted sleep deadline, abort mark, restart count and terminal execution receipt. No whole `Attempt`, project-task state, approval or process-termination assertion is copied into the checkpoint |
| `documents` / `document_revisions`: `investigation.b.requests` | Host integration through Durable: caller-ID-to-task correlation and latest response/revision. Mapping creation is atomic with task creation; response changes are atomic with the next engine checkpoint. A response is presentation/execution progress, not domain acceptance |
| Built-in Durable root `conversations` and `pi.agent`, `pi.live`, `pi.inbox`, `pi.provider`, `pi.usage` documents | Durable: its required root and built-in metadata, created by `root()`. No agent model/provider is configured; no generation, tool task or user submission is admitted. `entries` and `submissions` remain empty |
| `durable_schema`, `durable_metadata`, `record_ids` | Durable: backend schema version, ID/sequence allocation and immutable identity namespace; not Switchboard attempt numbering. Indexes are derived storage access paths, not another authority |
| SQLite WAL/SHM files | Their respective backend: commit/recovery implementation, not an extra application record. Application FULL settings and engine NORMAL settings remain distinct |
| `owners/effects/`, `owners/controls.json` | Independent fake workspace/worker/forge owners and test/operator authority, as in step 3. Receipts/counters survive host loss. Only these controls can supply scoped operator approvals; request arguments cannot |
| `owners/workers/<attempt>/prompts.jsonl`, `result.json` in child tests | External synthetic worker: its independently recorded prompt and claimed report. Host checkpoints cannot create positive termination or acceptance evidence |
| `*.json` request files in CLI tests | Caller: immutable retry inputs, not another reservation or execution journal |
| Release probe `durable.db`, `invocations.jsonl`; baseline JSONL probe storage/log | Durable owns probe execution/checkpoints; the independent diagnostic files count invocations. Separate fixtures, not B's application/worker records |

The input contract exists in both the Durable task input and `prototype_requests` so either side can detect an incompatible request after a lost cross-store response. The latest typed outcome exists in the engine response document and its terminal receipt for queryability. Neither is a second full application lifecycle. B does **not** write A's response cache or a second checkpoint-position table. The domain result and review facts remain application-owned even when a phase checkpoint advances past them.

There are **three independent commit boundaries**: application transactions, Durable commits, and external owner effects. They are not atomic together. Sharing a SQLite file or process would not change the APIs' transaction boundaries. If task creation commits but reservation does not, its original input can safely ask the application to reserve by the same ID; if reservation/effect facts commit but the next checkpoint does not, B reads them and conservatively refuses an uncertain effect. A full application record plus an engine checkpoint is justified only where they record different facts. Losing either entire database is not automatically repaired. No power-loss, corruption-repair or cross-store exactly-once claim follows.

### Host and CLI cost

| Concern | Implemented cost and limitation |
| --- | --- |
| Transport | Loopback HTTP POST with bounded 64 KiB JSON commands, a private bearer endpoint, structured outcomes and 15-second transport deadlines. `submit`, `inspect`, `advance`, `wait`, `cancel`, `diagnostics`, `shutdown` are explicit commands. Clients load no Durable runtime and open no database. The runtime is dynamically imported only by host/init. Same-user files/token are hygiene, not a security sandbox or remotely authenticated service |
| Admission and deduplication | One in-host command line serialises mutations; the existing application transaction independently enforces the maximum. Two actual CLI processes at maximum 2 admit two attempts and refuse a third. No custom queue of ready project tasks is added; requests refused at capacity retain a discoverable terminal engine result |
| Lost clients | An actual aborted HTTP submit, paused after the prompt acknowledgement, leaves one admitted attempt and one prompt; retrying the same ID finds it. Client disconnect/time-limited wait does not cancel Durable work. A wait timeout returns the last waiting observation, not success; a transport timeout is uncertain and requires the original ID on retry |
| Exclusivity | Atomic directory creation before open; canonical fixture-root check; immutable owner identity and private endpoint. Two host processes are refused. No heartbeat, stale takeover or service installation. After SIGKILL, the retained claim is the visible failure and an operator must confirm the old host/workers stopped before removing that **fixture** claim. Production needs an equivalent context claim protocol and diagnostics, not just SQLite file locking |
| Startup | Explicit `host` command, open application storage, install definitions, open/reconcile Durable, resume its scheduler, bind transport and publish endpoint. There is no automatic host start/restart, daemon detachment or OS service. A persisted deadline cannot start Node; the operator supplies process availability |
| Shutdown | Seal transport and join admitted requests; close Durable (signal/join invocations, preserve checkpoints), close application storage, then join handles through the host's adapter before releasing its own claim. Generic `shutdown` reports `workerTermination: unverified`, `leases: retained`. Closing Durable is not sending worker cancellation; `cancel` separately durably aborts the task and its handler records/delivers the once-only worker cancellation request. Neither action grants lease-return authority |
| Failure reporting | Startup/ownership failures go to stderr with exit 2. CLI transport failures return `host_unavailable` plus an operator action; a refusal exits 2. Task adapter errors produce a persisted failed execution receipt and response; `onReport` is available in `diagnostics`. Parked/blocked tasks appear through public `Harness.inspect()`, not private-table queries. Reports are in-memory diagnostics, **not** a retained crash log; a process death may leave only its claim, domain facts, checkpoints and owner evidence. Production still needs a diagnostic sink and operator recovery/retry tooling |
| Storage/event-loop cost | Two separately owned local SQLite files and extra checkpoint/response commits. Engine defaults use synchronous SQLite calls and a 5-second busy timeout; exclusivity avoids ordinary engine contention but production must consider blocked event-loop diagnostics. The application retains its existing async busy retries. Rewriting the small session request-index document is a fixture shortcut, not a scalable unbounded registry/pruning policy |

One measured macOS run of `host.test.ts`, with other B tests running concurrently, reported **328 ms host startup**, **107 ms repeated-request CLI round trip** (includes a fresh Node client), and **136 ms CLI shutdown plus process join**. These are one fixture observation, not performance guarantees or an A/B benchmark. The tests print fresh JSON timings on every run. CLI failure codes, second-host refusal, optional waiting, hard host loss and post-shutdown unavailability are tested separately from workflow success.

### What B removes, retains and duplicates

No production code is deleted by this investigation. B actually omits **A's custom `steps.ts` runner** and A's foreground `submit/advance` workflow composition. Durable supplies phase position, persisted wait deadlines, scheduler wakeup, terminal receipts, abort coordination and restart-loop parking. HTTP clients do not hold a worker channel or create their own per-command execution owner. There is no application-owned workflow cursor, persistent interval scheduler or A-style response-cache record alongside the Durable task.

This reduces the candidate Phase 3 step runner and orchestration-wait machinery, not readiness, capacity admission, domain attempt facts, request IDs, external-effect intents/read-back, launch exclusion, worker ownership, result validation, operator confirmations, retention or real adapters. The host still needs exclusive ownership, startup/shutdown, command transport, diagnostics and recovery policy. The prototype retains a small command serialiser and bounded response-publication wait loop; those are client transport coordination, not a second workflow journal. Production worker stop/steer claims and budget/heartbeat supervision have **not** been shown removable by B. There is no net code-saving or architecture-selection claim from this happy path.

Physical counts include comments and blank lines and can be reproduced with `wc -l investigations/durable-orchestration/design-b/*.ts`:

| New B code | Lines |
| --- | ---: |
| Durable engine/definition and caller-response correlation | 214 |
| Application operations and owner interpretation | 216 |
| Host, client, CLI and fixture-path guard | 235 |
| B scenario/transport/lifecycle/release tests and crash-probe child | 531 |
| Total | 1,196 |

**Duplication count:** zero copied production adapter modules, zero new copies of the **195-line** application bridge or **107-line** synthetic process adapter/child – both are directly imported from A. The shared fake owners/counters and contract suite are unchanged and reused. Conservatively count **all 216 lines of `operations.ts`** as duplicated application/domain/adapter glue overlapping A's driver, rather than pretending it is free engine code; this is an upper bound for the copied/reshaped interpretation and guards, not a claim of 216 text-identical lines or removable policy. It includes worker-result/receipt interpretation, production schema calls and finalisation checks. No real Pi RPC, Git/retention, Treehouse or forge adapter implementation is reproduced. Integration would extract these operations once at the existing application boundary for both designs; that extraction is not a production refactor authorised by this task.

### Reproduce and scope the evidence

From the repository root:

```sh
npm install --ignore-scripts
npm ci --prefix investigations/durable-orchestration --ignore-scripts
npm run check --prefix investigations/durable-orchestration
npm test --prefix investigations/durable-orchestration
# B only (includes the unchanged shared suite through HTTP):
node --test --test-timeout=30000 'investigations/durable-orchestration/design-b/*.test.ts'
# Original restart probe, now on 1.4.0:
node --test investigations/durable-orchestration/smoke.test.ts
npm run check
npm test
```

A manual fixture can be driven in separate terminals without starting any agent:

```sh
# Use a fresh name. init creates only fake owners and disposable project tasks.
node investigations/durable-orchestration/design-b/cli.ts init .investigation/durable-orchestration/b-manual
# Keep this foreground host in one terminal; do not run a second host for the same root.
node investigations/durable-orchestration/design-b/cli.ts host .investigation/durable-orchestration/b-manual
# In another terminal, supply a JSON file with the sampleRequest() contract under .investigation/:
node investigations/durable-orchestration/design-b/cli.ts submit .investigation/durable-orchestration/b-manual .investigation/durable-orchestration/request.json
node investigations/durable-orchestration/design-b/cli.ts inspect .investigation/durable-orchestration/b-manual
node investigations/durable-orchestration/design-b/cli.ts diagnostics .investigation/durable-orchestration/b-manual
node investigations/durable-orchestration/design-b/cli.ts wait .investigation/durable-orchestration/b-manual request-1 1000
node investigations/durable-orchestration/design-b/cli.ts shutdown .investigation/durable-orchestration/b-manual
```

`submit <directory> <request-file> [wait-ms]` also optionally waits. No CLI command fabricates an external worker result, forge signal or operator approval; the shared test fixture drives those through `FakeOwners`. The automated tests are the fully reproducible six-step scenario, including both gates. Fixture databases, request files, owner controls and all generated evidence stay under ignored `.investigation/durable-orchestration/`; each test joins its subprocesses and closes its host before cleanup.

B-specific evidence currently passes **44 tests**: the unchanged **28** shared cases through HTTP; domain/engine separation; actual disconnected submit; exclusive ownership; review reopen/current approval; review rejection after its checkpoint; four adapter lost-acknowledgement exceptions; conservative worker-wait reopen; two separate-process host/CLI cases; two real synthetic-child lifecycle cases; and two release-feature probes. The release sleep test calls `runtime.sleepUntil`, closes/reopens SQLite before the deadline, checks the unchanged deadline, advances a controlled clock beyond it and explicitly resumes under `onWake`. The crash-loop test exits without close in five separate task invocations, then a sixth process finds `restarts: 5`, `blocked/restart_limit`, `task_parked` and inactive wake state, with exactly five independent invocation lines. It does not test CPU/OOM exhaustion or automatically retry a parked task.

The adapter lost-acknowledgement cases are exceptions after acquire/launch/prompt/return effects, followed by reopen and unchanged independent counters; they are **not** hard-kill coverage of every B boundary. The separate-process SIGKILL case covers host loss during a worker wait, stale claim refusal and explicit fixture-operator claim removal only. The earlier 38 SIGKILL boundary tests remain shared-owner/reference evidence, not B's complete recovery matrix. Every case is one run per invocation of the suite, not a repeated reliability study.

Still required before an architecture decision: the full A/B failure matrix and repeat counts, unfinished-work 1.3-to-1.4 SQLite upgrade/reopen and rollback procedure, storage faults/power-loss qualification, missing/incompatible-definition recovery tooling, real forge timing/backpressure, platform qualification and one explicitly authorised real Pi/Treehouse integration per design (step 6). No real agent may be launched under this task's no-other-agents instruction. The conservative claim protocol is not production containment or automatic workspace return. These successful paths neither select B nor establish that its additional host/dependency cost is worthwhile.

Final validation for this step passed on macOS/Node **v26.7.0**: clean isolated `npm ci --ignore-scripts`, isolated TypeScript check and all **151 investigation tests** (including **44 B tests** and the rerun baseline restart probe); repository `npm run check`; repository `npm test` – **419 tests, 417 passed, two platform-specific skips, zero failures**. The root scripts still exclude investigation tests, so both suites were run explicitly. No production source or authoritative task/lease records were changed.

## Step 5 – repeated process-crash failure matrix

Run on **22 October 2026, Darwin arm64, Node v26.7.0**, starting from repository **`a14d813b782515ea1e65f627cc893487d89a9bee`**. This section supersedes the earlier statements that the A/B matrix and unfinished SQLite upgrade remain untested. It does not select an architecture, qualify power-loss durability or complete step 6. No Pi, Treehouse or other agent was launched by this investigation. The only worker executable was A's existing synthetic `worker-child.ts`; workspace, review and forge owners remained disposable fakes. Repository tests separately use their existing disposable Treehouse fixtures, not real workspaces or agents.

### Commands, repeats and retained evidence

From the repository root:

```sh
npm install --ignore-scripts
npm ci --prefix investigations/durable-orchestration --ignore-scripts
npm run check --prefix investigations/durable-orchestration
# All investigation tests, including the matrix; default MATRIX_REPEATS is 3.
MATRIX_REPEATS=3 npm test --prefix investigations/durable-orchestration
# Matrix/dependency probes alone, with independently counted receipts in the report:
MATRIX_REPEATS=3 npm run test:failures --prefix investigations/durable-orchestration
npm run check
npm test
```

The default report is `.investigation/durable-orchestration/matrix-results.jsonl`, appended once per completed case. Use an absolute `MATRIX_REPORT` path to retain it elsewhere; start with an absent report for an unambiguous run. Fixtures remain under ignored `.investigation/durable-orchestration/matrix-*` and `storage-matrix-*`, and are removed after joining their processes. The final run's JSONL and test logs are retained with this task's result artefacts, outside the recyclable workspace. Development runs are not included in its repeat counts.

The final investigation suite passed **473/473 tests**: the existing 151 plus **322 new checks**. The latter comprise **52 cases × 2 designs × 3 repeats = 312**, plus **three dependency probes × 3 repeats and one settings measurement = 10**. Each of the **38 named interruption points** was exercised **three times in each design**, for **228 boundary SIGKILL/reopen checks**. Every matrix row below has separate-process crash coverage; additional probes distinguish graceful shutdown, abrupt `process.exit`, injected storage errors and artificial record rollback. Repository `npm run check` passed; `npm test` passed **419 tests, 417 passed, two platform skips, zero failures**. The isolated TypeScript configuration now includes `failures/**/*.ts`, not just the older suites.

### Harness and ownership qualifications

`failures/host-child.ts` runs the actual A driver or B `ExecutionHost` in a fresh process. Adapter effects and actual application acknowledgement writes use the shared before/after hooks. At the requested hook, the child sends an IPC boundary marker and waits indefinitely; its parent sends **SIGKILL** and joins it, without running close/finally handlers. A separate process first demonstrates that the surviving owner claim blocks replacement. Only then does the fixture operator remove that disposable claim and start a new process. This is not stale takeover, worker adoption or permission to alter a production lease.

The matrix adds A's previously missing **minimal fixture context host claim**: an exclusively created `host/owner/` directory, a flushed PID record before application open, and release only after closing the driver and known child. It has no expiry, heartbeat or automatic recovery. This exclusion lives in the matrix host, not in the reusable A driver; production A would still need its planned dispatcher claim and diagnostics. B uses its existing exclusive `ExecutionHost` claim before opening either store. A second live host and a post-crash replacement are both refused. Neither implementation relies on SQLite's ordinary writer lock to exclude long-lived hosts.

The matrix's small loopback HTTP transport is **test infrastructure**, shared by both designs. Independent `failures/client.ts` CLI processes concurrently submit requests through it. For B, this transport calls the same engine as the existing host API; the earlier B-specific tests still exercise its actual authenticated transport, disconnected HTTP submit and CLI. Do not count the matrix transport as a proposed production A daemon or B transport simplification. Its fixture-only `effect`, `queryOnly` and clock controls are not worker-facing operations.

All acquisition/launch/prompt/return/cancellation counters come from independent owner receipts. Assertions also scan receipt attempt IDs absent from application identity acknowledgements, so a lost workspace acknowledgement cannot hide an orphan acquisition. Actual child cases additionally read its independent PID, prompt log and result file. Every normal recovery case asserts capacity, request uniqueness and at-most-one acquisition, launch, prompt, return and cancellation delivery per attempt. An unresolved refusal has an explicit operator next action; no refusal is treated as completion.

### Full plan matrix – three repeats per case, per design

Point names below expand to both `:before` and `:after` unless stated otherwise. `effect` means the external fake owner wrote its receipt; `ack` means the actual application record write completed. The engine and application still do not commit atomically.

| Plan row | Crash cases and independent evidence | A outcome | B outcome |
| --- | --- | --- | --- |
| Duplicate request, including lost client response | `reserved`, `launched`, `prompted` acknowledgement kills; three concurrent CLI clients and stable-ID retry after killing the host | Same reservation, at most one launch/prompt; interrupted worker state is `possibly_running`. Before the reservation exists, retry can safely create the first attempt | Same application reservation and launch/prompt bound. A surviving task at `reserve` can conservatively reserve then refuse `acquisition_uncertain`, even if no acquisition occurred |
| Concurrent submissions at capacity, including two CLI clients | Three separate CLI processes submit distinct requests against maximum 2, then host is killed and a stable ID retried | Exactly two admitted, third `capacity`, active count 2, still two attempts after restart. Enforced by production `AttemptStore.reserveAttempt`'s `BEGIN IMMEDIATE` transaction; A also serialises its invocation | Same counts and transactional application enforcement. Durable task count is not capacity; the refused request may retain a terminal engine receipt |
| Stop before workspace acquisition, or after effect before acknowledgement | `acquire:effect`, `workspace:ack`, `reserved:ack` | Zero or one independent acquisition, `acquisition_uncertain` if identity was not acknowledged; an acknowledged workspace without launch/exit evidence remains `possibly_running`. No return | Zero or one acquisition. Recovered acquire phase refuses `acquisition_uncertain`, including after the workspace fact committed but before the engine checkpoint did. No blind reacquisition or return |
| Stop before launch, or after launch before acknowledgement | `launch:effect`, `launched:ack`, `prompt:effect`, `prompted:ack`, `started:ack` | `possibly_running`; zero or one launch/prompt and no return. Launch fence survives | Same safety result, with engine recovery layered over the same immutable application launch row |
| Worker finishes before orchestration records result | `worker_exit:effect`, `result:ack`; valid and wrong-session reports delivered while host is stopped; actual-child crash without exit receipt | Positive valid exit/result becomes `waiting/review`; wrong identity gives `invalid_result`. Missing positive exit stays `possibly_running`, even with a result file and a dead direct child | Same validation/refusal. A recovered wait does not adopt the process or infer success from process absence |
| Finalisation succeeds before recording completion | `accepted:ack`, `done:ack`, `return:effect`, `returned:ack` | Accept/done facts can be inspected and continued. Return intent or a surviving return effect without acknowledgement gives `finalisation_uncertain`; return count remains 0 or 1. A committed return is completed | Same result even when the application fact is ahead of the checkpoint. No repeated uncertain return |
| Review delivered twice or around restart | `review:effect`, `merge:effect`, `review:ack`; duplicate signal delivered once before kill and once with no host | No signal leaves visible `waiting/review`; surviving exact-commit signal can complete with current approval. Two receipts produce exactly one application review fact and one return | Same result. Owner signals, not a transient in-memory delivery, preserve unanswered work across host loss |
| Restart during wait, including after deadline | Worker and review wait kills; duplicate-review wait before deadline; `overdue_review_wait` | Review facts survive; explicit `advance` re-reads owners. A has no persisted timer/deadline or autonomous wake mechanism to qualify | Controlled engine clock starts at 1,000,000. Reopen before the saved deadline preserves it exactly; explicit advance moves to it and resumes. Reopen at 1,010,000 makes overdue work runnable during host `resume()`, with no client advance, then records the next review sleep. No signal means still waiting, not success |
| Cancellation or shutdown interrupts active work | `cancel:effect`, `cancelled:ack`; actual synthetic child under kill, cancellation followed by kill, and graceful host shutdown | Cancellation intent excludes redelivery and yields `cancelled`; orchestration shutdown reports termination unverified. No positive exit is manufactured and lease is retained | Abort handler requests cancellation separately from host close. Same retained lease and no inferred termination. Durable abort/close is not proof a worker stopped |
| Second host, storage failure, or workflow cannot resume | Live and stale owner refusal; read-only application writes then kill; corrupt application database after kill; B engine storage and missing-definition probes below | Competing host exits 2. SQLite read-only error returns `host_unavailable`; corrupt database prevents startup with a visible error. No effects or replacement worker | Same host/application results. Missing definitions remain visible `blocked/missing_task`; engine commit failure seals its session. No silent replacement execution |
| Missing/stale/model-claimed approval | Each variant kills host after worker/review evidence and before protected effects, then resumes with a fixed domain clock | All give `approval_required`, with no acceptance or lease return | Same result; model-controlled extra request arguments never populate owner approvals |

The simulated merge is a **fixture/operator forge observation**, not a publishing or destructive action performed by either runner. The finalisation side effect tested here is exact fake lease return, not real Git integration, publication or merge. The actual-child tests exercise lifecycle, not process containment. The child writes a result and waits; loss of its IPC owner makes this simple child exit. Test cleanup observes that PID disappear, but supplies neither design with an exit receipt or no-processes authority. Unknown workers still require operator resolution and retained leases.

### Storage and lost-record experiments – not power-loss tests

Measured on configured live connections, not on fresh raw SQLite connections whose connection-local pragmas would differ:

| Setting | Application store, A and B | Durable 1.4.0 engine store, B |
| --- | --- | --- |
| Journal | WAL | WAL |
| `synchronous` | **FULL (2)** | **NORMAL (1)** |
| `fullfsync` | ON (1) | OFF (0) |
| `checkpoint_fullfsync` | ON (1) | OFF (0) |
| Busy timeout | 0 ms; application async retries | 5,000 ms; synchronous backend wait |
| WAL auto-checkpoint | 1,000 pages | 1,000 pages |

The engine measurement uses Chord's same `openNodeSqliteDatabase` opener called by Durable's `openNodeSqliteStorage`. Inspected published Chord code explicitly sets WAL and NORMAL; there is no synchronous/fullfsync option in this opener's public options (only busy timeout and WAL checkpoint threshold). Sharing a file would not make application and engine commits atomic or configure both connections alike.

ADR-0007 requires flushed FULL commits, plus macOS fullfsync, precisely because surviving effects with lost exclusion records undermine safety. Durable's **default NORMAL does not meet that requirement**: individual acknowledged WAL commits are not flushed as FULL commits are, and recent progress can disappear after power/OS/storage loss. FULL requests a commit flush; fullfsync requests the stronger macOS drive-cache flush. Actual guarantees still depend on SQLite, filesystem and hardware honouring those requests. **SIGKILL results do not verify any of that.** The earlier JSONL `fsync: true` caveat also stands: affected sidecars are flushed but ordinary main commit markers are not explicitly flushed. Owner receipt files are flushed, but their directories are not fsynced. None of these fixtures qualifies power-loss behaviour.

Two explicit **artificial rollback** experiments, repeated three times per design, clarify the consequences without pretending to simulate power failure:

1. Preserve domain fences, but restore B's engine database to a clean pre-request offline copy. Retrying the same ID refuses `acquisition_uncertain`; application reservation, workspace identity and exclusion facts prevent another launch/prompt. A has no engine store: deleting only its response cache yields `possibly_running` with the same one launch/prompt. Presentation/checkpoint loss alone is not permission to repeat an effect.
2. Restore **all** host databases to their clean pre-request copies while leaving external receipts intact. **Both prototypes launch and prompt twice for the same caller request across two generated attempt IDs.** This deliberately unsupported disaster case is asserted as a demonstrated hazard, not counted as safe crash recovery. The fake owner can enumerate old receipts but neither submit path reconciles an entirely lost domain identity namespace before admission. Stable caller IDs alone cannot deduplicate against records that no longer exist. Whole-store rollback, lost domain fences or a restored backup therefore require fencing dispatch and external-owner/operator reconciliation before any submission; neither design supplies that disaster-recovery procedure. ADR-0007's FULL domain store must not be weakened on the strength of these process tests.

B's two engine commit-failure probes wrap the published storage API, throwing once **before** or **after** the underlying checkpoint commit. Both report `session_failed`, reject pending/later calls and make no automatic retry. The independent `prepare` effect survives in both. A separate inspection-only process finds checkpoint `prepare` when the write did not commit and `finish` when it did. It does not resume either task or repeat the effect. This tests the API's ambiguous-failure contract, not disk-full recovery, torn writes or actual device failure. The application read-only test uses SQLite `PRAGMA query_only`, and the corrupt-database test replaces an offline disposable file with invalid bytes; both are synthetic faults.

### Unfinished upgrade/reopen and definition availability

The investigation now additionally pins npm aliases **`durable-1-3` → `@earendil-works/pi-durable@1.3.0`** and **`pi-ai-1-3` → `@earendil-works/pi-ai@1.3.0`**, solely for the offline upgrade probe. B and the ordinary smoke/scenario tests still use **1.4.0**. The 1.3.0 Durable tarball integrity is the same one recorded in step 2; all alias/transitive integrity hashes are in the local lockfile. No production dependency changed.

Three independent runs created unfinished SQLite work using the published 1.3.0 engine, committed checkpoint `finish`, and abruptly exited 75 without close. With all writers stopped, the test copied the complete database/WAL file set. Opening 1.4.0 without the task definition migrated the backend but preserved unfinished work as public `blocked/missing_task`; installing the matching definition on another open completed `finish` once without rerunning `prepare`. Reopening the migrated database with 1.3.0 was refused (`Durable SQLite schema version 2 is newer than supported version 1`). Offline replacement from the pre-upgrade complete backup reopened under 1.3.0 at `finish`; it was **not resumed**, because external effects from after the backup remained and needed reconciliation.

This qualifies one unfinished deterministic task and one supported schema transition, not every workflow/document version or arbitrary task-code migration. Rollout still needs a stopped-writer backup, compatible definitions and an explicit no-downgrade decision. Restoring an old backup and blindly resuming is unsafe, as the lost-record experiment demonstrates. The existing release crash-loop probe also still passes: five abrupt no-progress invocations park at `blocked/restart_limit` with `task_parked`; it is not reset automatically.

### Operator hand-off for `durable-real-runs-p5b`

Step 6 is deliberately **not run here**. The operator's separate task should:

- Run one explicitly authorised real Pi/Treehouse attempt per design in disposable workspaces, retaining the output branches, exact bindings, result files, session evidence and simulated review state. Do not publish or merge.
- Count actual RPC launch and initial prompt delivery independently. Retry a stable caller ID after a lost client response and verify the same reservation; never re-prompt or relaunch after uncertainty. A recovered workflow alone is not launch authority.
- Inspect Treehouse's real lease identity after an acquisition response is lost. Record the unresolved state and operator action rather than using the fake owner's receipt directory as proof of real discoverability.
- Check real result/identity/commit retention after worker exit and around host loss. Confirm direct-child exit is distinct from tool descendants; a worker-written result file alone must not establish success or no remaining processes.
- Exercise a host restart during the simulated review wait and duplicate review delivery. B's host must be explicitly restarted by the operator; persisted deadlines cannot start Node. Check current scoped approval and retained output again before finalisation.
- Test shutdown/cancellation visibility without assuming agent termination, and retain every lease until the existing checks pass and the operator explicitly confirms no worker/tool process remains. Do not apply the fixture claim-removal procedure to a live worker.
- Retain the evidence outside recyclable workspaces. Report actual runtime/platform differences, adapter discovery limitations and any refusal that needs manual resolution. Do not interpret synthetic return, controlled-clock success or the NORMAL backend as qualification for automatic recovery/return or power-loss safety.

### Conclusion and remaining boundaries

The matrix supports conservative process-crash recovery in **both** prototypes; it does not show that Durable removes the application exclusion/intent/authority mechanisms. B additionally retains cross-store reconciliation and host availability obligations, while supplying persisted waits and blocked-task visibility. A's minimal context claim added by this harness is additional custom execution machinery, not existing production capability. No net code-removal estimate or design selection follows from this step alone.

Remaining adoption checks include real integrations, supported-platform evidence beyond macOS, real owner discovery and descendant containment limits, storage/device/power-loss qualification, broader task/document migration and operator disaster-recovery tooling. Step 7 must weigh these results with the earlier ownership and code-cost tables. No ADR, Phase 3 PRD, production source, authoritative task record or real Treehouse lease was changed.

## Step 6 adapter – operator commands for `durable-real-runs-p5b`

The `real/` adapter is now available for **both** designs. This addition tests it only with `tests/fixtures/pi-rpc.ts` and disposable Treehouse repositories. **No real Pi, model or other agent was launched for this implementation.** The authorised operator must run and evaluate the real integrations separately; the earlier matrix and dependency limitations still apply.

### Prepare and run each design

Run these commands from the repository root, using Node.js 26.7.0, Git and Treehouse on PATH:

```sh
npm install --ignore-scripts
npm ci --prefix investigations/durable-orchestration --ignore-scripts
CLI=investigations/durable-orchestration/real/cli.ts
SOURCE_CONFIG=/absolute/path/to/switchboard.json
INSTRUCTIONS=/absolute/path/to/disposable-task-instructions.md
A=.investigation/durable-orchestration/real-a
B=.investigation/durable-orchestration/real-b
node "$CLI" init "$A" --design A --config "$SOURCE_CONFIG" --instructions "$INSTRUCTIONS"
node "$CLI" init "$B" --design B --config "$SOURCE_CONFIG" --instructions "$INSTRUCTIONS"
```

`init` refuses a non-empty directory. It creates a fresh local Git repository and initial commit, a fixture application database/task containing the given instructions, independent owner controls/receipt storage, and `real.json`. The pool is always `<fixture>/pool`, separate from Switchboard's own pool. No source-config repository, database, task store, runtime root or pool is opened or changed. Only its **worker settings** (Pi entrypoint, provider, model, thinking, shell tool, environment, run time, usage limits and stats interval), `keepAwake`, and default delivery base branch/evidence/deliverable requirements are copied. The fixture supports the default **code** contract, not `byTaskKind` overrides. It always uses simulated review, never publication or merge. The base ref must be a valid local branch name; it names the new fixture's initial branch, not a fetched production ref. Configuration changes after init do not silently change the frozen fixture settings. `real.json` may contain configured environment secrets – keep the fixture private.

For example, disposable instructions can ask for a committed `hello.txt`, a check of its contents, and evidence/deliverable names matching the source config. Do not assign work on an authoritative project. For an offline rehearsal, supply a config whose worker entrypoint is the absolute `tests/fixtures/pi-rpc.ts` path, provider/model are both `fixture`, `keepAwake` is false, and worker environment contains PATH plus `FAKE_PI_SCENARIO=commit-result` and an absolute `FAKE_PI_LOG` under `.investigation/`.

In terminal 1, start **one foreground host** and submit its stable request:

```sh
RUN="$A"                       # Repeat the whole procedure with RUN="$B" afterwards.
node "$CLI" run "$RUN"
```

`run` starts that design's host in the current process, submits `real-request-1` for `real-task-1`, and waits until worker exit leads to review (or a refusal). It leaves the host in the foreground. A Treehouse acquisition uses holder `durable-A:<attempt-uuid>` or `durable-B:<attempt-uuid>`; the output branch is `durable-real/a/attempt-1` or `durable-real/b/attempt-1`. **This command launches the configured Pi and can make chargeable model calls.** It does not launch another host process, daemon, supervisor agent or model for orchestration. `--wait-ms <n>` bounds the client wait only, not the admitted run. Time/token/cost limits come from the copied worker config.

In terminal 2, from the same repository root, set `CLI` and `RUN` again and inspect/retry as needed:

```sh
CLI=investigations/durable-orchestration/real/cli.ts
RUN=.investigation/durable-orchestration/real-a   # Or real-b.
node "$CLI" inspect "$RUN"
node "$CLI" submit "$RUN"                     # Retry the SAME request, never a new attempt.
node "$CLI" wait "$RUN" --wait-ms 60000        # Wait for worker/review or report a refusal.
node "$CLI" inspect "$RUN" > "$RUN/inspection.json"
```

`inspect` reads host state, real Treehouse leases/pool identity, every independent effect receipt/counter and fresh Git retention controls. It still reads external evidence with the host stopped (host state then reports `host_unavailable`). `submit` cannot choose new inputs: it reloads the frozen request. `wait` explicitly advances A; B's existing host also runs its persisted waits autonomously. A timed-out client does not stop or relaunch the worker. Non-host commands exit 2 on a structured refusal (and print it); host/run remain available until stopped. A refused uncertainty requires inspection, not a new request or a reset database.

### Restart at review, record review and approve return

After observing `waitingFor: review`, stop the host and wait for terminal 1 to exit:

```sh
node "$CLI" shutdown "$RUN"
```

`shutdown` seals transport, closes execution storage and asks the adapter to stop/join its known Pi handle. It does not return any lease or claim descendant termination. Once terminal 1 has exited, restart it there with:

```sh
node "$CLI" host "$RUN"
```

`host` reopens the existing application/engine stores without submitting anything. There is no automatic worker adoption or replacement. In terminal 2, `wait` should still report review; inspect the exact result, output branch, session and retained artefacts before deciding:

```sh
node "$CLI" wait "$RUN" --wait-ms 60000
node "$CLI" inspect "$RUN" > "$RUN/inspection.json"
ATTEMPT=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).host.attempts[0].id' "$RUN/inspection.json")
LEASE=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).host.attempts[0].identity.leaseId' "$RUN/inspection.json")
COMMIT=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).host.attempts[0].result.commit' "$RUN/inspection.json")
node "$CLI" review "$RUN" --attempt "$ATTEMPT" --commit "$COMMIT" --decision accepted
node "$CLI" review "$RUN" --attempt "$ATTEMPT" --commit "$COMMIT" --decision accepted
node "$CLI" advance "$RUN"                    # approval_required; no return.
node "$CLI" approve "$RUN" --attempt "$ATTEMPT" --lease "$LEASE" --commit "$COMMIT" --accept
node "$CLI" advance "$RUN"                    # process_confirmation_required; still no return.
```

`review` appends a simulated exact-commit review receipt; delivering it twice must still produce one accepted application transition. `--decision rejected` is also supported. `approve` records operator authority only, scoped to the exact observed attempt, lease and commit, with a default one-hour expiry (`--expires-ms` overrides it). It cannot manufacture a worker result or make Git retention pass. A new approval replaces the old approval for the same scope. Review alone is not acceptance authority; acceptance alone is not no-processes confirmation.

**Only after personally checking that no worker or tool process remains**, grant both facts and finish:

```sh
node "$CLI" approve "$RUN" --attempt "$ATTEMPT" --lease "$LEASE" --commit "$COMMIT" --accept --no-processes --expires-ms 3600000
node "$CLI" advance "$RUN"
node "$CLI" inspect "$RUN" > "$RUN/final-inspection.json"
node "$CLI" shutdown "$RUN"
```

A performs protected steps on `advance`; B may already perform them after the approval arrives. An in-flight B poll can still publish the preceding refusal just after a control update – advance again to observe the next poll; this does not grant permission to repeat an effect. Both must show one acquisition, launch, prompt, exit and return, two review receipts, one scenario application task/attempt, `done` and `returned`, and no remaining real lease. The real return uses `TreehouseProvider.returnLease` with the exact holder/ID/path and `discardChanges: false`, including its listing/read-back checks. The adapter independently rechecks current approval, Git retention and lease identity immediately before returning. No merge, push or publish is performed. Direct-child exit is **not** a no-processes confirmation.

### Lost acquisition response

Use a separate fresh fixture for each design; do not reuse a completed or uncertain database:

```sh
LOST=.investigation/durable-orchestration/lost-a
node "$CLI" init "$LOST" --design A --config "$SOURCE_CONFIG" --instructions "$INSTRUCTIONS"
node "$CLI" run "$LOST" --stop-after-acquire
# Deliberate SIGKILL at workspace:ack:before; expect a non-zero shell status.
node "$CLI" inspect "$LOST" > "$LOST/lost-inspection.json"
```

Repeat with `lost-b` and `--design B`. The interruption writes `interruption.json` and kills the foreground host **after Treehouse granted and the owner receipted the lease, before the design records workspace identity**. No Pi is launched on this path. Inspection must show a real lease with the attempt-naming holder and one acquisition, zero launch/prompt/return receipts, even though application identity is missing. The surviving host claim intentionally blocks a replacement host.

Once the old host has exited and you have confirmed there are no worker/tool processes, remove only this disposable host claim:

```sh
node "$CLI" recover-claim "$LOST" --confirm-host-stopped --confirm-no-processes
node "$CLI" host "$LOST"                       # Foreground terminal 1.
# In terminal 2, set CLI and LOST to the same values:
node "$CLI" submit "$LOST"                     # acquisition_uncertain, same reservation.
node "$CLI" inspect "$LOST"
node "$CLI" shutdown "$LOST"
```

Claim recovery changes no lease, intent, launch fence, task or engine checkpoint. Never use it to bypass a live host. The adapter intentionally offers no automatic reconciliation/return for a lost acquisition acknowledgement; retain the uncertain lease and evidence for separately authorised operator resolution. Do not delete stores and retry, restore an old snapshot and resume, or use a fresh caller ID to hide uncertainty.

### Evidence, ownership and limits

- `host/switchboard.db` remains the unchanged scenario application bridge, including its **synthetic** workspace paths/starting commit and launch bindings. B additionally owns `host/durable.db` with the existing NORMAL durability setting. These are not a production adapter migration.
- `owners/workers/<attempt>/allocation.json` is the actual verified Treehouse allocation. `report.json` is the complete Pi run report, written after execute returns; it names the actual runtime directory, binding, full result, child exit and failure details. Actual launch bindings, heartbeat, activity and exit observations are in **`owners/runtime/switchboard.db`**, with result/session/artefact files under its hashed context/lease directories. A small mirrored runtime fixture task/reservation lets unmodified `RuntimeRecords` and `PiWorker` enforce their own immutable launch fence without conflicting with the scenario's already-claimed synthetic launch row. Neither ledger is replay authority; this is explicit prototype-only duplication, not a proposed production design.
- `owners/effects/*.json` have exactly the shared `FakeOwners` shape. Counters scan these receipts, never checkpoints. The launch receipt is an **intent before execute**, not independent proof of spawn. The prompt receipt follows PiWorker's checked `Worker started` activity note (after RPC disposition `started`). A worker-exit receipt is written only after execute reports a positively observed direct-child exit; a result file or cancelled workflow is insufficient. Invalid/missing results become failed scenario reports and cannot pass acceptance. Review/merge receipts stay simulated; the designs never call a real forge.
- Before finalisation the adapter derives cleanliness/retention from production `checkRetention`, including every reported Git/artefact reference, and checks the real lease listing. Owner control fields cannot fake these checks. Scoped operator approvals still live only in `owners/controls.json`. For fake Pi, the external RPC log and `fixture-launch.json` additionally verify one actual prompt/process launch; real Pi does not supply that fixture log. Inspect its immutable runtime binding, activity/session evidence and the adapter's receipts without treating an intent as proof of successful delivery.
- Only acquisition/return hooks bracket actual Treehouse calls. Launch is deliberately receipted before execute, and prompt hooks bracket the receipt after the worker's started report – they are not new instrumentation inside production RPC. The `workspace:ack:before` stop is the real lost-acquisition test, not a simulated fake lease.
- Stop hosts before copying evidence. Preserve the entire fixture (repository with output branches, pools, both databases/WAL where present, receipts, reports and sessions) outside recyclable workspaces, for example `tar -czf /absolute/retained/real-a.tgz "$A"`. Preserve source-config/instruction provenance without leaking credentials. An evidence copy is **offline evidence**, not a resumable backup: runtime/worktree paths are absolute and restoring old fences can repeat effects. Keep the original until the authorised operator has resolved every retained lease. The script never publishes or merges branches.

Validate without any agent/model calls:

```sh
npm run check --prefix investigations/durable-orchestration
npm run test:real --prefix investigations/durable-orchestration
npm test --prefix investigations/durable-orchestration
npm run check
npm test
```

The real-adapter suite uses only fake Pi and disposable Treehouse fixtures. It covers both full designs, stable-ID retries, actual host process restart at review, duplicate review, missing/no-processes/wrong/stale approvals, actual Git retention, result-file-before-exit refusal, and SIGKILL at the lost-acquisition acknowledgement with `acquisition_uncertain` on retry. It does not qualify actual model/provider behaviour, descendant containment, power loss, automatic recovery or a choice between A and B.

Validation on 22 October 2026, macOS/Darwin arm64, Node.js **v26.7.0**: isolated TypeScript check passed; all **479 investigation tests passed**, including the **six real-adapter tests** and the default three-repeat failure matrix. Repository `npm run check` passed; `npm test` passed with **428 tests, 426 passed, two platform skips, zero failures**. No production source, authoritative task store or non-fixture Treehouse pool was changed. Real model/provider runs remain the separate operator task.
