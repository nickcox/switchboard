# Pi Durable orchestration comparison and decision proposal

23 October 2026. **Proposal, not a selected design or permission to adopt a dependency.** Completes step 7 of the [prototype plan](pi-durable-orchestration-prototype.md). The [investigation record](../../../investigations/durable-orchestration/README.md) contains the implementation inventory, release qualification, detailed matrix and operator real-run account. No ADR, PRD, production code or recovery policy is changed here.

## Recommendation

**Use a narrower integration:** propose Durable for the reasoning supervisor's conversation, queued inputs, interrupted tool calls and pending decisions only. Keep deterministic attempt execution and finalisation in Switchboard application operations, using A's owner-inspection approach and small, position-free step runner. Do not put each attempt's whole workflow into a Durable task as B does. Do not introduce a second persistent dispatcher queue or checkpoint cursor alongside it.

This is a boundary proposal, not a completed supervisor integration. Neither prototype runs a supervisor agent. Production adoption of the narrower integration remains blocked on the supervisor trial and storage checks below. The evidence supports not selecting full B now; it does not establish that Durable cannot be made suitable for it.

Reasons:

- Both designs preserve process-crash safety using the same application reservation, launch fence, external-effect intents, identity checks and operator authority. B did not remove those mechanisms.
- B demonstrably supplies persisted waits, phase recovery, abort coordination and crash-loop parking. These are real released capabilities, not features missing from npm. However, both designs still need a host, process ownership, diagnostics and external-owner reconciliation.
- In the real run B safely refused a Treehouse read failure but could not continue. The follow-up demonstrates that this was a prototype classification choice: both designs now recover from explicitly classified pre-effect owner-read failures, preserve diagnostics and refuse uncertain effects. B reuses its existing persisted waits without an engine change. This removes that specific recovery gap as a reason to reject B; it does not supply general operator reconciliation or a new real-run result.
- The supervision-first draft needs a new attempt from kept output, exact-commit checks/review, objective permissions/budget and worker questions. Neither A nor B implements them. Checkpointing an old attempt is not this continuation feature. Keeping that policy in shared application operations avoids making either a model conversation or an engine receipt a second task authority.
- A separate Durable supervisor boundary addresses reasoning continuity without also adding per-attempt execution checkpoints. This retains some custom deterministic composition deliberately, rather than claiming to eliminate it.

## Evidence and provenance

The original report inspected workspace baseline **`1c12403c3d7687cf5d657c7a986c751150081a52`**. This revision incorporates the classified-recovery and configured-storage findings through **`1a9ee97ff8ae17fbbcb258ff38a2790248de887b`**; it does not rerun their tests. Earlier implementation baselines and their counts remain in the investigation record; they are not all the same revision. The original inventory used `431cc85d672cabbf1107a66a01627e378b25fd53`.

The changed needs were read from **`phase3-supervision-first` at `047403c894d05fba942898a3bcf134f0aab5f045`**, file **`docs/phases/03-supervisor/PRD.md`** (the branch renames the phase directory). That draft moves concurrency, the background dispatcher, PR policy and ACP to Phase 4, and puts one supervisor, one objective and one worker at a time first. It is an input, not silently substituted for the current PRD.

Evidence labels used below:

- **Common:** `scenario/common-tests.ts`, run unchanged against A and B; shared independent fake owner receipts, both review and simulated merge gates.
- **Matrix:** `failures/matrix.test.ts` and `storage.test.ts`; 52 cases per design, three repeats each, plus three dependency probes repeated three times and one settings measurement. Of these, 38 interruption boundaries × two designs × three repeats are 228 SIGKILL/reopen checks. These are bounded process experiments, not reliability statistics.
- **Release:** B's `release.test.ts` and the storage/upgrade probes. Published Durable **1.4.0**, upstream `4a080252f06caf63a525d7873c5d94d3c23887e0`, locked tarball integrity `sha512-EtIyXH1MBSXdJSkodmy+CYXuwfve3gPrD4GNCZ0XmuRWLPupwRlNQ7fdaXjRcLoKb6SWkT/yEzK+sMmrqvYK+Q==`. The historical 1.3.0 baseline has no persisted timed waits; the isolated aliases retain it for upgrade testing only.
- **Real:** operator's 23 October account in the investigation README, using Pi `openai-codex` / `gpt-6.1-sol`, Treehouse 3.1.4 and disposable repositories from `76de2c6`. This report did not rerun agents. The operator records a private archive at `~/.switchboard/switchboard/evidence/durable-real-runs-2026-10-23.tgz`; it exists on this machine, but this report has not independently audited its contents. It may contain environment secrets and must not be published. The durable record of findings is the committed README, not a claim of independent acceptance verification.

- **Follow-up:** `failures/recovery.test.ts`, `scenario/recovery.test.ts` and `failures/configured-storage.test.ts`; 30 repeated A/B recovery cases, two approval-after-intent cases and three configured-storage restart probes. The investigation record reports 35/35 targeted and 514/514 full investigation tests passing. These use injected owner faults and process restarts, not a rerun of real B or a power-loss test.

## Comparison table

| Criterion | A: Switchboard-owned execution | B: Durable-owned execution |
| --- | --- | --- |
| Safety and recovery | Common and Matrix preserve one reservation and at most one acquire/launch/prompt/return per attempt under tested crashes. Positive validated exit permits result recovery; uncertain acquisition, worker or return requires inspection and often operator resolution. Explicit `advance` reads current facts and skips completed finalisation steps. No autonomous recovery loop | Same bounds, using the same application fences, plus phase checkpoints. Review waits resume at saved deadlines. Early recovered phases can refuse even when no effect occurred. Classified pre-effect read failures now use bounded persisted retry waits; uncertain effects and exhausted retries still require operator resolution. Real B's earlier terminal read failure was not rerun. No automatic worker adoption |
| Custom execution code | 293-line driver plus 22-line runner and shared 62-line recovery classifier. No stored cursor/deadline. Production still needs shared operation extraction, any long-lived host lifecycle, diagnostics and later dispatcher intervals/controls | Replaces A's ordering/runner and supplies persisted sleeps, scheduler, receipts, aborts and restart-limit parking. Adds 215-line engine, 234-line operations glue, the same shared recovery classifier and 235-line host/client/CLI/path boundary. Does not replace worker supervisor, domain transactions, intents or authority |
| State ownership | One FULL application database plus worker files and independent external owners. Prototype adds frozen input/facts/response cache, not a second attempt object or workflow cursor | Same application database plus separate Durable database, still NORMAL in the ordinary prototype host; a public FULL/fullfsync configuration is now demonstrated. Engine owns cursor, deadline, caller-to-task mapping and published response; application response cache stays empty. Three commit boundaries need reconciliation; no cross-store atomicity |
| Host and CLI complexity | Reusable driver is foreground composition. Matrix adds a minimal exclusive fixture host and shared test transport; real adapter adds foreground host/CLI. These are not the planned detached production dispatcher | One explicit context host opens both stores and owns handles; actual HTTP/CLI clients submit, inspect or wait. Bearer endpoint, bounded requests/timeouts, serialisation, start/close and stale-claim refusal are implemented. Client disconnect does not cancel work. No automatic host start, restart or service |
| Visibility | `inspect` exposes domain attempts, waits, refusals and capacity. Possibly running workers and unacknowledged leases remain visible through domain/owner reads. Production needs host diagnostics | Same domain inspection plus public Harness inspection for blocked/missing-definition/restart-limit work and persisted responses. `onReport` is in memory, not a durable diagnostic sink. The follow-up retains classified read failures and command output in application facts across restart; arbitrary engine reports still need a retained diagnostic sink |
| Dependency constraints | Uses existing Node SQLite/domain storage; no deterministic engine dependency. FULL/fullfsync settings measured, not power-loss tested. Long-lived host and cross-platform behaviour still unqualified | Released 1.4.0 waits qualified with controlled clock; unfinished 1.3-to-1.4 SQLite upgrade tested. Default NORMAL fails ADR-0007 equivalence; the released public `SqliteStorage.open()` and caller-configured connection support FULL/fullfsync without an upstream change. Experimental API, synchronous 5-second busy timeout, compatible definitions and no downgrade add rollout constraints |
| Production change | Extract existing dispatch/finish operations rather than ship fake-contract tables; use real runtime/retention/authority boundaries. Add the draft's continuation, objective, check/review and question operations | Same domain work, plus versioned task definitions, request correlation, cross-store recovery, exclusive host transport, failed-task recovery tooling and storage qualification. Real adapter's mirrored runtime ledger must not become production duplication |

## Continuing, rather than only refusing

### A

A makes **some continuation easier now**: after a positive exit/result survives host loss it can validate it and reach review; it can re-read review signals and skip committed acceptance/done steps on an explicit advance. The follow-up explicitly classifies read failures, retains diagnostics and permits another read on a later advance up to three cumulative failures. Exhaustion remains fenced even if the fault disappears; arbitrary exceptions are not retry permission. It does not independently restart scheduling or recover an uncertain live worker. Acquisition/return uncertainty may still need a person.

For the draft's example of a crash leaving useful committed output, A supplies the existing retained-output and stop/exit facts, not a new-attempt operation. Proposed shared operation: validate the earlier attempt's exit or confirmed stop, exact recorded retained commit and current task eligibility; reserve a **new** attempt with a stable new caller ID, new branch/lease/session, parent-attempt/commit correlation and frozen written handover. Check attempt limit, objective scope and aggregate budget transactionally where applicable, and revalidate before effects. Keep the old lease if necessary; do not reuse its worker, branch or prompt. A possibly running worker for the task still blocks it. Checks and independent review must cover the new exact commit before supervisor acceptance. None of this is proven by A's current common scenario.

**Where its supervisor would run:** A's deterministic runner does not host reasoning. Under ADR-0003, a later exclusive context host would run a Durable conversation for the one objective and call A-style operations in-process. Objective, permissions, budget, tasks, attempts, checks/reviews and questions would be application-owned; conversation, queued inputs and pending reasoning/tool work would be Durable-owned in a separate store outside workspaces. This is also the narrower proposal. A plain-notes/reconstruct-on-start alternative is not tested as equivalent to interrupted calls and queued-input recovery.

### B

B makes **wait continuation easier now**: its stored review deadline and phase survive restart; overdue work runs when the restarted host enables scheduling, without a client advance. Duplicate review is reconciled and current approvals are checked again. It does not start a stopped host. Its checkpoints do not resume an external worker, authorise a new attempt or manufacture missing exit evidence.

B now demonstrates **bounded read-failure continuation**, not general end-to-end recovery. The shared application classifier distinguishes explicitly read-only owner failures from uncertain effects and retains command diagnostics. B uses its existing sleeping response path, including after SIGKILL/reopen, without changing the engine. Both designs recheck expired approvals and return exactly once after renewal; failures after return intent require reconciliation and never repeat return. Three cumulative read failures exhaust the budget. Missing definitions, restart-limit parking, exhausted reads and uncertain effects still require supported operator tooling. The original real Treehouse failure remains unexplained and real B completion has not been rerun.

Starting a new attempt from kept output needs exactly the same application operation described for A. B could checkpoint the invocation but cannot supply its policy, handover, aggregate budget or new identity. A failed old workflow must remain inspectable while a separately authorised new request references its retained output. That scenario has not been implemented or measured in either design.

**Where its supervisor would run:** in the same exclusive context host as deterministic Durable tasks, as a distinct conversation for the objective. Durable would own both conversation continuity and execution checkpoints; Switchboard would still own objective/domain facts. Tools would call shared operations in-process, not create a parallel CLI execution owner. Sharing the host/store does not make application and engine transactions atomic. Neither this supervisor arrangement nor its model-turn restart behaviour was exercised by B.

### Narrow integration boundary

The proposed one-context host runs one supervisor conversation for one objective and invokes Switchboard's asynchronous operations. Runtime adapters still own external worker channels; a supervisor restart is not worker adoption. Existing foreground CLI operations remain valid through the same domain transactions and launch fences; they must not open the supervisor's Durable store. A host endpoint is for supervisor input/inspection, not a second queue of deterministic dispatch workflows. Keep host exclusivity and worker ownership distinct.

Durable owns only conversation continuity, stable input submission IDs and pending reasoning/tool outcomes. Switchboard owns objective state, permissions, total budget, questions and all attempt facts. Store any event-delivery position in the application boundary; advance it only after a durable submission acknowledgement and redeliver with the same event ID after uncertainty. A mutating tool uses its persisted call/request ID on every retry; interrupted non-replay-safe tools require inspection. Do not mirror full tasks/attempts into conversation documents. Resume reasoning by reading current application state, not treating old tool output as present authority.

This boundary avoids per-attempt engine checkpoints while retaining conversation/tool acknowledgement reconciliation; it does not promise that all tools are replay-safe. B's classified-read continuation is now demonstrated, so the narrower proposal rests on the ownership boundary rather than that earlier terminal-failure behaviour. It needs its own acceptance trial; it is not a third implemented prototype. Scheduled reasoning reminders, if later required, would be Durable-owned and separately qualified, not a second application scheduler slipped into Phase 3.

## Persistent ownership table

These groups cover the stores and files actually used; unused production tables still belong to Switchboard. Detailed table/column inventories are in the investigation record.

| Record | Authority and purpose | A | B | Narrow proposal |
| --- | --- | --- | --- | --- |
| Tasks, dependencies, attempt numbers/reservations/entries, scoped confirmations | Switchboard application: readiness, capacity, identities, outcomes and approvals | FULL application DB | Same | Same; add objective, permissions, budget, parent-attempt/handover, checks/reviews and questions as domain records, not engine documents |
| Launches, worker claims/observations/activity, control requests | Switchboard runtime boundary: immutable exclusion, channel owner, positive exit, once-only control delivery | Existing stores retained; prototype populates a subset | Same; engine abort is not termination | Same; trusted caller and authority checked in operations |
| Archives, pending deletions, schema metadata | Switchboard: numbering/history, recoverable cleanup and schema | Retain | Retain, mostly unused by fixture | Retain |
| `prototype_requests`, `prototype_facts`, `prototype_responses` | Disposable bridge: frozen fake contract/UUID, missing correlation/intents/result/review facts, latest response | All used | Requests/facts used, responses empty | Do not ship these tables; put needed facts in existing application boundaries and retain worker reports as files |
| Host claim and endpoint/config | Execution host: exclusion before store open, routing/configuration, no acceptance authority | Minimal matrix/real fixture host | Exclusive host claim, private endpoint and config | Explicit exclusive supervisor host; no stale takeover. Diagnostic log never grants permission |
| Durable tasks/checkpoints/receipts, request document/revisions | Durable: execution cursor, sleeps, correlation and response, not domain acceptance | Absent for deterministic work | Added in separate `durable.db` | No per-attempt workflow records |
| Durable root/built-in documents, schema/IDs and WAL/SHM | Engine metadata and backend bookkeeping | Smoke only; later supervisor separate | Required root/metadata, no models configured | Conversation/queued-input/pending-tool state only; required metadata is not an objective ledger |
| Supervisor conversation and notes | Reasoning continuity, not task authority | Proposed separate Durable store | Proposed conversation alongside workflow tasks | Proposed separate Durable store, single owner; objective reference rather than copied lifecycle |
| Lease, workspace, Git refs and forge state | Treehouse/Git/forge: actual external effects | Inspect actual owners | Same | Same; retain exact output and recheck immediately before action |
| Result, session, artefact and runtime binding files | Worker/Pi claims and runtime evidence, validated by Switchboard | Retain outside workspace | Same | Same; absence of a live PID is not success |
| Independent fake receipts/controls, child prompt/result logs | Test owners and operator controls, not execution progress | Sibling `owners/` files | Same | Test-only, not a proposed production authority |
| Real allocation/report, `owners/runtime/switchboard.db` and runtime files | Real adapter's actual allocation/runtime evidence | Mirrored runtime fixture ledger | Same | Remove mirrored fixture identity/ledger; use one real application/runtime binding |
| CLI request files and probe invocation logs | Caller frozen retry input and independent diagnostic counters | Test evidence | Test evidence | Not extra domain reservations |

A has application transactions and external-effect boundaries. B has **three** independent boundaries: application, Durable and external effects. A checkpoint lagging a domain fact requires inspection, not repeating an effect. Sharing a file would not make their API commits atomic. The narrower proposal retains a cross-store boundary for supervisor input/tool acknowledgements only; its loss handling still needs testing.

## Failure results and operator actions

The following summarises all eleven plan rows. Matrix results were reproduced here with three repeats per case per design; Real observations remain operator-reported.

| Failure | A result | B result | Continuation or operator action |
| --- | --- | --- | --- |
| Duplicate request/lost client response | Same attempt; at most one launch/prompt | Same, including actual aborted HTTP client test | Retry original frozen caller ID; inspect unresolved state, never generate a replacement ID for the same operation |
| Two CLI clients at maximum 2 | Two admitted; third `capacity` | Same; engine task count is not capacity | Admission is the application's `BEGIN IMMEDIATE` reservation transaction in both |
| Acquisition before effect or before acknowledgement | Zero/one acquisition, unresolved identity refuses | Same; recovered acquire phase may conservatively refuse after workspace fact is recorded | Inspect Treehouse by attempt-naming holder and exact lease ID/path; no blind acquire/return. Real lost-acquisition leases were found, then returned manually only after confirmation |
| Launch/prompt before effect or acknowledgement | Zero/one launch/prompt; fence survives | Same | Possibly running blocks continuation/new work as scoped by policy; inspect and confirm stopped separately |
| Worker exit before result recording | Valid positive receipt reaches review; wrong identity refused | Same | Missing positive exit remains possibly running even when result file exists and direct child is dead |
| Finalisation effect before completion record | Accept/done facts can continue; uncertain return refuses | Same, including domain fact ahead of checkpoint | Inspect exact return owner, keep lease unresolved; no repeated uncertain return. A committed return permits completion |
| Duplicate review/around restart | Two receipts, one application review fact | Same | Read exact-commit external signal again; rejected or absent signals cannot become acceptance |
| Restart while waiting/overdue | Review survives; explicit advance needed, no saved timer | Saved deadline preserved; overdue review runnable after host resume | Operator restarts host. No review means still waiting, not success |
| Cancel/shutdown while active | Cancellation intent once; no synthetic exit or return | Durable abort handler requests cancellation separately from close; same lease retention | Stopping orchestration, requesting cancellation and observing termination are separate; no-processes confirmation still required |
| Second host/storage failure/unresumable workflow | Live/stale claim refused; read-only error visible, corrupt DB blocks open | Same plus engine commit failures seal session; missing definition blocked; five no-progress restarts park task | Diagnose owner/storage/definition and retain work. No automatic claim takeover, replacement worker or hidden task retry |
| Missing/stale/model-claimed approval | `approval_required`, no protected effect | Same | Trusted operation checks exact scope/expiry now, not checkpoint/model claims |

Real A retained commit `34651ac` on `durable-real/a/attempt-1`, validated `tests`, survived a review host restart and duplicate review, then completed one return. Real B retained `447c1d7` on `durable-real/b/attempt-1`, reached the same review/approval gates, then refused `host_unavailable` (`Treehouse status failed`) with no return. The operator manually returned B's lease with exact holder/ID after checking processes and kept the branch. Subsequent 20 provider calls and six concurrent Treehouse status calls succeeded; the original cause is unknown and its command output was not retained. One run per design cannot establish relative reliability or a provider concurrency defect. Launch receipts are adapter intents, not independent proof of spawn; the prompt receipt follows confirmed RPC start and real session evidence supports the one-session account.

### Storage and rollback

Measured live settings: application **WAL, synchronous FULL (2), fullfsync ON, checkpoint_fullfsync ON**, busy timeout 0 with async retries; B engine **WAL, NORMAL (1), both fullfsync settings OFF**, synchronous busy timeout 5,000 ms. Both auto-checkpoint at 1,000 pages. These are the ordinary prototype host's defaults. The follow-up demonstrates a public alternative in released 1.4.0: configure a Node `DatabaseSync`, wrap it with `NodeSqliteDatabase`, and pass it to `SqliteStorage.open()`. Three restart probes measured FULL and both fullfsync settings ON inside Durable's actual transaction connection, with the original checkpoint recovered. No upstream change is required. The ordinary B host has not switched to this configuration; platform and power-loss qualification remain outstanding. JSONL's `fsync: true` flushes sidecars but not ordinary main commit markers; it is not an equivalent fallback.

SIGKILL does not test power loss. Losing only B checkpoints while preserving application fences refused safely; deleting A's response cache did likewise. **Restoring all host stores to pre-request copies while retaining external receipts caused both prototypes to launch/prompt twice across newly generated attempt IDs for the same caller ID.** This is an asserted disaster-recovery hazard, not a passing at-most-once result. Fence dispatch after backup restore/domain-record loss until external owners and identities are reconciled. No design supplies that recovery procedure. Do not weaken ADR-0007's FULL requirement.

The unfinished 1.3-to-1.4 SQLite migration succeeded in three probes: preserved checkpoint, visible `blocked/missing_task` without definition, then one finish after installing it. Old 1.3 could not open schema 2. A complete stopped-writer pre-upgrade backup reopened under 1.3 but was not resumed: effects newer than that backup needed reconciliation. This qualifies one deterministic task/schema transition, not arbitrary task-code or conversation migration.

## Code-removal estimate

Counts at the report baseline are physical lines, including comments/blanks. They are supporting measurements, not an architecture score or a production saving forecast.

| Component | A | B |
| --- | ---: | ---: |
| Driver/order and position-free runner | 279 + 22 = **301** | Omitted |
| Engine definition/checkpoints/caller-response index | 0 | **215** |
| Reshaped application/adapter operations | Included in driver | **216** |
| B host/client/CLI/path guard | No equivalent complete daemon in A driver | **235** |
| Shared application bridge | **195** | Same file imported, not copied |
| Shared synthetic process adapter/child | **108** | Same files imported, not copied |

B omits 301 lines of A composition/runner, but replaces their work with 431 engine/operation lines and adds 235 host/client lines. The resulting 365-line difference is **not** a fair production net cost: A still needs comparable hosting and much of B's 216-line glue should be shared operation extraction. B's removals are mechanisms – ordering/cursor, durable waits, terminal receipts, abort coordination, restart-loop accounting – not 301 lines of unnecessary domain policy. Conservatively count all 216 operations lines as overlapping glue, not as removable rules. No production adapter modules were copied; the real adapter imports existing Pi/Treehouse/retention code. Its mirrored fixture runtime ledger is an additional shortcut to remove in either integration.

**Production deletion estimate: zero demonstrated lines for either design.** B could avoid the proposed custom runner (22 lines in the toy implementation), wait coordination and future scheduling code, but their production sizes are unknown and critical existing fences/claims remain. The narrow proposal removes no current production code and adds no per-attempt engine; it retains A-style composition. It can avoid building bespoke durable conversation/queued-input/interrupted-tool machinery, whose size and adequacy have not been measured. Existing worker heartbeat, budget, request forwarding, launch records, assessment, safety, retention, imports and cleanup remain. Never count the 149-line in-process reference exerciser or shared matrix transport as production execution savings.

The follow-up adds **62 shared classifier lines**, **14 net A driver lines** and **18 net B operation lines**, with **zero engine or runner changes**: 94 net lines across both designs. The original table above remains a historical baseline, not current file counts. B's recovery improvement therefore does not require a new scheduler or a custom workflow recovery engine. It does not remove the application classifier or effect intents needed by both designs.

## Reproduction and validation

From the repository root, Node.js **26.7.0**, with Git and Treehouse on PATH:

```sh
npm install --ignore-scripts
npm ci --prefix investigations/durable-orchestration --ignore-scripts
npm run check
npm test
npm run check --prefix investigations/durable-orchestration
# Use a fresh ignored report directory; MATRIX_REPORT must be absolute.
RUN=$(mktemp -d "$PWD/.investigation/durable-orchestration/report-XXXXXX")
MATRIX_REPEATS=3 MATRIX_REPORT="$RUN/matrix-results.jsonl" \
  npm test --prefix investigations/durable-orchestration
wc -l investigations/durable-orchestration/design-a/*.ts \
  investigations/durable-orchestration/design-b/*.ts
# Read the exact draft without changing the working branch:
git show 047403c894d05fba942898a3bcf134f0aab5f045:docs/phases/03-supervisor/PRD.md
```

For a targeted matrix rerun substitute `npm run test:failures --prefix investigations/durable-orchestration`. `npm run test:real --prefix investigations/durable-orchestration` runs **synthetic Pi** with real disposable Treehouse fixtures, not models. The README's “Step 6 adapter” gives the reproducible, separately authorised real-run commands, review/approval sequence, restart and lost-acquisition checks. Do not execute its model-launching `run` commands as an unattended validation step. No push, publication or merge is required.

**Report-run validation:** Darwin arm64, Node v26.7.0, Git 2.54.0 (Apple Git-157), Treehouse v3.1.4. Root `npm run check` passed; root `npm test` passed **428 tests, 426 passed, two platform skips, zero failed**. Isolated check passed; isolated suite passed **479/479**, including six real-adapter tests and the three-repeat matrix. Fresh logs and 322 matrix/probe JSONL rows were retained with the task artefacts. Test subprocesses were joined by the suites; no host or agent was left running by this report. These are checks performed, not independent acceptance verification.

**Follow-up validation (recorded, not rerun for this revision):** isolated check and 514/514 investigation tests passed; repository check and 428 tests (426 passed, two platform skips) passed. See the investigation record's classified-recovery/configured-SQLite section for commands and scope. The next proposed work is the [narrow supervisor experiment](pi-durable-supervisor-experiment.md), pending boundary approval.

## Proposed document changes after selection

No changes to these documents are made by this report.

| Document | Proposed change if the narrow boundary is selected |
| --- | --- |
| ADR-0003 | Move supervisor timing from the historical Phase 4 to the revised Phase 3; define one exclusive context host and a conversation per objective, separate from application storage. Record released 1.4.0 qualification and its integrity/upstream commit. Keep the existing submission/tool-crash/approval/storage acceptance gates. Explicitly exclude per-attempt deterministic workflows for now; reopen that boundary if future schedules justify it |
| ADR-0005 | Add this comparison as a fifth milestone, replacing reliance on the fourth comparison's “no timed waits” or file-maximum arguments. Keep external RPC worker, immutable launch identity and no automatic replacement. Distinguish replay of a stable request from a separately authorised **new** attempt based on retained output. Document the historical real B failure and the subsequent classified-read recovery evidence, distinguishing both from general operator reconciliation |
| ADR-0007 | Keep FULL/fullfsync domain storage and multi-process transactional admission. Clarify that “one database” means one authoritative application ledger, with a separately exclusively owned supervisor continuity store, not competing Durable opens or shared transactions. Add backup-restore dispatch fencing/reconciliation requirements; never approve NORMAL as equivalent. Specify storage guarantees required for acknowledged supervisor inputs and approvals before adoption; do not ship the mirrored real-adapter ledger |
| Phase 3 PRD | Reconcile with `phase3-supervision-first` explicitly rather than implement the older dispatcher-first ordering. Name the narrower host/record boundary and a supervisor-storage gate. Require stable parent-attempt/exact-commit/handover correlation and new identities, objective-wide admission/budget and trusted caller checks, exact-commit checks/reviews, retained leases not blocking accepted dependent work, and persisted open questions. Keep no-processes authority human-only. Add owner-read failure/recovery and intervention counting to acceptance tests. Keep deferred concurrency/PR/ACP requirements for Phase 4, not implicitly authorised by these prototypes |

## Limitations and checks blocking adoption

- **Narrow supervisor adoption is not yet qualified.** Run ADR-0003's conversation trial: restart during a model turn, queued input, pending decision and a tool whose application effect committed before its response; prove stable request/event IDs, unanswered-input visibility, exclusive storage and fresh permissions. Also compare reconstructing from application records/plain notes against the same requirements. The present tests have no supervisor model or conversation recovery evidence.
- **Continuation operation is untested in both designs.** Before implementing the draft's step 5 as a released feature, test crashes around reserving the new attempt and preparing its branch/workspace, refusal for possibly running/unknown/unretained parent, immutable handover, no writes to the old branch, attempt limits and objective budget. Then demonstrate review-failure repair and dependent work after a supervisor restart. Count human interventions per completed objective, not merely safe refusals.
- **Full B adoption still needs** supported operator recovery from terminal/blocked workflow states, exhausted read budgets and uncertain effects. Injected pre-effect owner-read recovery, retained diagnostics, approval expiry and no-repeat behaviour around return intent/effect are now demonstrated in both designs. An authorised real B completion run remains outstanding; it would not explain the original fault or satisfy the other gates by itself.
- **Storage is an adoption gate for any Durable scope.** Qualify the demonstrated public FULL/fullfsync connection configuration on each supported platform; no upstream configuration change is required. Specify and verify loss guarantees for acknowledged conversation inputs, deduplication and decisions separately from application fences. Neither NORMAL nor current JSONL flush evidence qualifies them. Power/OS/device loss, disk full, torn writes and filesystem corruption were not tested. Synthetic read-only/corrupt-file/API exceptions and artificial rollback are not substitutes.
- Only **macOS/Darwin arm64** process behaviour was qualified here. No investigation qualification on Linux, Windows, macOS Intel, network/synced filesystems or other Node/SQLite versions. Root CI coverage on other systems is not evidence for this host. Service installation, detached-host startup, automatic restart and tool-descendant containment are untested/out of scope. Direct-child exit never supplies no-processes authority.
- Real runs used one small task/model configuration per design, simulated review and manual return where required. No real forge publication, merge, provider-failure diagnosis, sustained throughput/backpressure or several simultaneous real agents was tested. Deadlines used a controlled engine clock; wall-clock jumps and long downtime are unqualified. Timings in the README are single observations, not comparative benchmarks.
- Broader task/document/conversation upgrades, definition-version changes, pruning the engine request index, scalable host transport, retained crash diagnostics and disaster recovery after whole-domain rollback remain unspecified. Offline evidence archives contain absolute paths/secrets and are not safe resumable backups.

The recommendation therefore selects a **candidate integration boundary**, not production readiness. If the supervisor/storage trial fails, retain Switchboard-owned execution without claiming plain notes solve reasoning continuity; revise that supervisor boundary before adoption. If full B later demonstrates recoverable effects and material reductions beyond the retained safety machinery, reconsider it with the same ownership and continuation criteria.
