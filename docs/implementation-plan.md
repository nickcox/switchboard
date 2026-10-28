# Implementation plan following the architecture and code review

Status: record of a whole-project review, October 2026. On 28 October 2026 its immediate correctness fixes (sections 4, 5, 7.1, 8.2's single observation path, 10 and 15's documentation corrections) were adopted as step 4 of the [Phase 3 PRD](phases/03-supervisor/PRD.md#correctness-fixes). Its other proposals are either part of later Phase 3 steps (continuation lineage, trusted callers and approvals, objectives and budget, shared finalisation operations) or listed under the PRD's [Considered, not scheduled](phases/03-supervisor/PRD.md#considered-not-scheduled), with the trigger for each. The delivery order and the Durable recommendations below are the review's proposals as written; where they differ from the Phase 3 PRD or [ADR-0003](adr/0003-pi-durable-for-durable-orchestration.md), those documents apply. This plan does not itself approve production dependencies or chargeable agent trials.

## 1. Goals

Keep Switchboard's transactional application state, explicit acceptance rules and conservative treatment of uncertain external effects. Reduce inconsistent decisions, repeated implementation and operator intervention before adding more orchestration features.

The intended result, across the immediate work and conditional backlog in section 3, is a system that:

- Starts a worker from one consistent, immutable specification.
- Preserves request deduplication independently of execution-log retention.
- Associates attempts with durable repository and context identities.
- Records exactly which output was observed, validated and accepted.
- Keeps accepted deliverables independently of disposable runtime records.
- Can start a separately authorised attempt from retained earlier output.
- Enforces caller authority and resource admission in application operations.
- Uses shared observation and finalisation code without a general workflow engine.
- Remains inspectable when a worker runtime is unavailable.
- Demonstrates useful recovery, not only safe refusal.

### Preserve these properties

1. Application changes that belong together use one SQLite transaction.
2. Transactions never include Git, Treehouse, forge, filesystem-copy or worker calls.
3. Unknown is distinct from absent, rejected and confirmed success.
4. Launch permission and launch prevention remain mutually exclusive and durable.
5. No blind retry of an external effect with an uncertain outcome.
6. Worker completion, acceptance, integration and lease return remain separate.
7. Direct-child exit is not evidence that all worker descendants stopped.
8. No lease return without identity checks, retention or explicit discard, and adequate process-termination evidence.
9. Current authority is checked before each protected effect; historical approvals are not lasting permission.
10. Worker reports, task text and transcripts are data, not authority.

### Non-goals for this plan

- Replacing SQLite, Git or Treehouse without a demonstrated benefit.
- Introducing a plugin system, configurable workflow language or generic repository framework.
- Automatic takeover of stale claims, automatic worker restart or automatic replay of uncertain effects.
- Treating private runtime configuration as a security sandbox.
- Repeating the completed product comparison or implementing every execution-isolation alternative.

## 2. Evidence and starting point

The review traced the main dispatch, storage, supervision, assessment, finalisation and retention paths. Type checking passed. The root test suite reported 426 passed, two skipped and zero failed. These results do not qualify real dispatch on additional platforms or future supervisor behaviour.

Two additional disposable probes established:

1. Changing a task's repository, kind and instructions during workspace acquisition can launch the new instructions in the old repository with the old delivery contract. The new kind can even be unconfigured. Contract selection precedes acquisition, while instructions come from `startReservedTask()` afterwards.
2. Archiving an attempt deletes its request reservation. Reusing that request ID can create another attempt. This is documented current behaviour, but conflicts with unbounded replay from a durable caller.

Relevant implementation locations:

- `src/dispatch/dispatch.ts`: selection, reservation, launch and dispatch finalisation.
- `src/attempts/store.ts`: task/attempt transactions and request reservations.
- `src/dispatch/finish.ts`: result re-reading, acceptance, integration and lease return.
- `src/dispatch/observe.ts`, `assess.ts`, `state.ts`, `safety.ts`: observations and decisions.
- `src/runtime/contracts.ts`, `records.ts`, `supervisor.ts`: bindings, results and supervision.
- `src/config.ts`: eager construction and runtime-installation checks.

Existing phase specifications remain the approved roadmap until explicitly amended. Some recommendations below are already identified in Phase 3 or investigation documents; implement them once, not as parallel mechanisms.

## 3. Delivery order and decision points

The operator has completed the product comparison and found that none of the listed alternatives meets their needs. Continue with Switchboard; no further whole-product comparison or adoption decision is part of this plan.

### Immediate delivery order

| Step | Work | Scope |
| --- | --- | --- |
| 1 | Fix the mixed task-snapshot launch issue | Section 4: definition revisions, reservation/start checks and consistent launch inputs |
| 2 | Define deduplication lifetime and preserve request tombstones | Section 5: durable request identity, input fingerprints and prune-safe replay |
| 3 | Freeze attempt inputs and validated output evidence | Complete section 4's immutable specification and section 7.1's validated result observation |
| 4 | Consolidate observation and finalisation logic | Sections 8–9: shared facts, safety checks, storage helpers and finalisation plans |
| 5 | Make inspection/recovery independent of worker installation | Section 10: operation-specific dependencies and resource disposal |
| 6 | Choose the next feature based on reduced operator intervention | Select a bounded item from the conditional backlog below and qualify its benefit using section 16 |

Implement these steps incrementally. Step 1 must not wait for a complete context registry, objective model or deliverable store. Freeze the existing repository/context identifiers and configuration values in the early specification; add registered identities through an explicit migration when that backlog item is selected. Likewise, shared finalisation can initially use the existing acceptance records without waiting for the full deliverable model.

Each step must retain the existing tests and add its relevant acceptance tests. Documentation, migration tests and operator diagnostics are part of each step, not a final cleanup task.

### Conditional implementation backlog

The detailed sections below specify how to implement the remaining recommendations when selected. They are not all prerequisites for completing the five immediate steps, and their section order is not an implementation commitment.

| Item | Implementation scope | Selection or dependency rule |
| --- | --- | --- |
| Registered repository/context identity | Section 6 | Select for reliable configuration changes, relocation or shared-repository operation; build on immutable specifications |
| Deliverables, validation, acceptance and independent retention | Sections 7.2–7.4 | Select when accepted output needs a lifecycle beyond attempt records; build on validated result observations |
| Trusted caller and approval operations | Section 11 | Mandatory before exposing mutating operations to an unattended supervisor |
| Resource admission and accounting | Section 12 | Mandatory before unattended supervisor use; implement the limits needed by the selected operating scope, including aggregate budgets for objective-wide execution |
| Continuation lineage | Section 13 | Select to reduce manual recovery of useful output; requires exact retained output, authority and resource admission |
| Execution ownership and workspace lifecycle | Sections 14.1–14.2 | Evaluate only when the selected feature needs a new unattended operating model or simpler workspace cleanup |
| Narrow Durable supervisor integration | Section 14.3 and existing adoption gates | Select only for demonstrated reasoning-continuity needs; do not add per-attempt workflow checkpoints by default |

Choose each next feature using observed operator effort and recovery problems, not completion of every proposed primitive. Implement and qualify its required safeguards before enabling it. Authority and resource safeguards are release prerequisites for unattended supervisor use, not reasons to delay the immediate correctness and simplification work.

Real-agent qualification still requires explicit scope and budget approval.

## 4. Consistent task definitions and attempt specifications

### 4.1 Task definition revision

Add a monotonically increasing task definition revision. Increment it transactionally when title, instructions, repository or kind changes. Keep scheduling and operator-decision revisions separate: hold, release, dependency and state changes already have distinct meanings and must not accidentally become changes to a running worker's instructions.

At selection, read the task and its definition revision. Resolve the delivery contract from that exact definition. Reservation must verify the expected revision and repository inside its transaction.

Store an immutable attempt specification with the reservation. At minimum it contains:

- Specification schema version and attempt identity.
- Task ID, definition revision, title and complete instruction snapshot.
- Repository and context identities.
- Requested base ref and output branch name.
- Resolved delivery contract.
- Requested runtime profile, provider, model and relevant settings.
- Resource limits and objective reference, when applicable.
- Configuration provenance sufficient to explain these choices.

Do not store credentials or a complete environment dump. Store safe profile identifiers, versions and selected non-secret settings.

The specification precedes acquisition, so it cannot yet contain the actual starting commit. Record allocation facts separately and immutably after acquisition: lease identity, canonical workspace identity, backing repository identity and actual starting commit. The runtime binding combines the stored specification with those allocation facts; it must not reconstruct instructions or delivery from the current task or configuration.

### 4.2 Before launch

Use the following explicit policy:

1. Recheck readiness after acquisition as today.
2. Verify the task definition revision still matches the reserved revision.
3. If it changed, halt without launching, keep the lease, and report `task_definition_changed` with a next action.
4. If it matches, start the task and record `task_started` in one transaction.
5. Launch only from the stored specification and allocation facts.

A definition change after task start applies to a later attempt. It neither silently changes the current attempt nor cancels it. Operator steering remains a separate authorised operation.

Preserve the existing rule that a newer operator state/hold decision is not overwritten by outcome recording.

### 4.3 Migration

Existing runtime bindings provide instruction and delivery snapshots for launched attempts. Import those facts without inventing missing revision or configuration provenance. Mark historical provenance as unavailable where necessary.

Existing open attempts without a complete launch specification must remain inspectable and resolvable. Do not synthesise permission to launch them from current configuration.

### Acceptance tests

- Change each of repository, kind, instructions and title during acquisition: no worker launches.
- Change the task between selection and reservation: reservation refuses without an attempt or external effect.
- An unconfigured new kind cannot run under an earlier contract.
- A definition change after task start leaves the running input unchanged.
- Readiness changes still refuse start; newer holds and state changes survive outcome recording.
- Restart and inspection show the same specification, regardless of current configuration.

## 5. Request identity and deduplication

### 5.1 Separate request records from attempt retention

Create durable operation-request records keyed by context, operation kind and caller request ID. Dispatch requests reference their resulting attempt identity or archived summary. Pruning execution history must not remove these records.

Retain compact tombstones indefinitely in the initial implementation. Do not add a deduplication-expiry mechanism until there is a concrete storage need and a defined maximum replay lifetime for every caller.

Record a canonical input fingerprint and its encoding version. For dispatch, fingerprint the caller's explicit selection and options, not whichever task happens to be ready on replay. An automatic-selection request records its selected task as its result; replay returns that result without selecting again. Reject a reused request ID with different input as `request_input_mismatch`.

Keep caller identity distinct from request identity. Changing the caller must not bypass an existing context-scoped request or grant additional authority.

### 5.2 Transaction rules

- Request admission, attempt reservation and the initial specification are one transaction.
- A committed request always points to its original attempt or an explicit historical reservation state.
- Replaying a completed or archived request returns its original identity and current available status, not a fresh attempt.
- Lookup failures are errors, not evidence that a request is absent.
- A fresh continuation uses a new request ID, linked to its parent attempt.

Do not make every command require an idempotency key. Add it where an operation starts work or where durable tool replay needs one.

### 5.3 Migration and restore

Populate request records from live reservations and archived summaries. Preserve legacy reservations that lack an attempt as unresolved tombstones. Refuse conflicting historical mappings rather than choosing one silently.

Deduplication cannot survive restoration to a database copy predating the request while external effects survive. Provide a supported restore procedure that starts with dispatch disabled and requires reconciliation. State explicitly that an arbitrary file rollback cannot always be detected from that file alone.

### Acceptance tests

- Replay after prune returns the original attempt and creates no lease, worker or prompt.
- Different arguments with the same key are refused, including after pruning.
- Concurrent identical requests create one attempt.
- Lost response after transaction commit does not cause a second attempt.
- Automatic selection replay does not choose the next ready task.
- Migrated unresolved and archived reservations retain exclusion.
- Restore procedures cannot enable dispatch before the reconciliation step is acknowledged.

## 6. Repository and context identity

### Implementation

Add persistent repository and context records. A context names a registered repository, task-selection scope and runtime storage location. Repository registration records the canonical backing Git location and an application-generated identity. Do not use the origin URL alone as repository identity: remotes can change and local repositories may have none.

Every new attempt references these records. Record the provider's actual pool and allocation identity separately, because Treehouse pool identity can change when remotes change.

Opening a context with incompatible repository or storage settings must refuse mutation and explain the mismatch. Inspection should still expose historical records and the reason external owners cannot be verified.

Provide an explicit relocation/rebinding operation for legitimate repository or storage moves. Require stopped writers, validation of the old and new locations and an audit record. Do not automatically rebind because a path exists or a remote matches.

Keep branch names unique across contexts sharing a repository. Include a stable context component or attempt UUID in new names; retain old names for existing attempts.

### Policy provenance is not frozen authority

Store which configuration produced an attempt for explanation and reproducibility. Continue reading current operator restrictions before protected effects. A stored permissive policy must not defeat a newly imposed restriction.

Record the policy and exact target used for each integration or publication operation. A later policy change must not cause an already completed operation to be interpreted as approval for a different target.

### Acceptance tests

- Reuse a context ID with a different repository: mutation refuses.
- Change an origin remote: historical pool uncertainty remains visible and does not become absence.
- Two contexts sharing a repository generate distinct output branches.
- A copied or restored database does not silently bind to a different execution context through normal setup.
- Explicit relocation preserves identity and does not start work.
- Tightening policy after reservation takes effect before integration or publication.

## 7. Validated results, deliverables and acceptance

### 7.1 Immutable validated result

The worker result file remains untrusted transport. After worker completion, validate its schema and identity, then persist the validated content or canonical digest plus immutable retained content as an application observation.

Record the source path, content digest, validation version and observed time. Preserve the raw worker file for diagnostics, but later finalisation uses the validated observation rather than rereading mutable worker output as authoritative evidence.

If a result file changes later, report the discrepancy. Do not silently change the accepted commit or report. Recovery of a result not previously recorded requires an explicit application operation that validates the original binding and existing termination evidence.

### 7.2 Deliverables

Introduce deliverable records produced by an attempt:

- Git deliverable: repository identity, exact commit and retaining ref.
- File artefact: stable application identity, content digest, size, media type where known and retained location.
- Provenance: producing attempt, source result and human-readable name.

Publish file artefacts into application-managed retained storage after validation. The worker must not be able to choose arbitrary destination paths through result fields. Copy using bounded regular-file reads, reject unsafe links, compute the digest from the bytes actually stored, and atomically publish the retained file before recording successful retention.

Filesystem publication and database recording are not one transaction. Use a recoverable intent/staging protocol: interrupted copies remain unaccepted, and a later operation can inspect the destination and complete the record without overwriting different content.

Content addressing is useful but optional; immutable identity and verified content are required. Same-user workers can still alter storage, so verify digests when correctness depends on it and do not call this a security boundary.

### 7.3 Validation and acceptance

Record validation evidence separately from acceptance:

- Subject: exact commit or artefact digest.
- Source: worker report, operator, CI/forge or an explicitly configured verifier.
- Check identity and result.
- Observation time and relevant provenance.

Worker-reported evidence remains self-reported. Do not turn a matching evidence name into independent verification.

Acceptance records name the exact deliverable, accepting actor, applicable delivery requirement and decision. Ordinary reviewed `finish` must record acceptance, not only `--accept-output`. Manual integration records an operator assertion with its scope; local integration records owner-observed evidence. No successful acceptance implies that the lease was returned.

A rebase or changed artefact produces new output identity. Previous check and acceptance records do not automatically apply. Implement any rebase flow under the separately approved Phase 3 requirements, with new validation/approval where required.

### 7.4 Separate retention policies

Distinguish:

1. Execution records and diagnostics.
2. Accepted deliverables.
3. Workspace leases.

`prune` may remove eligible execution detail without deleting accepted deliverables or request tombstones. Add explicit deliverable references from tasks or later attempt specifications when they consume earlier output. Referenced or pinned deliverables are not eligible for deletion.

Provide a separate explicit deliverable cleanup/export operation with a dry run, retention reasons and reference checks. Initially require operator confirmation for deleting accepted artefacts. Do not infer that an artefact is unused merely because its producing attempt is old.

### Acceptance tests

- Alter `result.json` after recording: finalisation uses the original validated result or refuses a discrepancy; it never silently adopts the change.
- Acceptance and integration refer to the exact recorded commit, not a later branch head.
- Artefact mutation, link substitution and interrupted copy cannot yield accepted mismatched bytes.
- Pruning an attempt retains accepted reports and request identity.
- A later task's reference prevents deliverable deletion.
- Worker evidence and independent verification remain distinguishable in JSON and text output.
- Changed/rebased output cannot inherit exact-output approval without the required new decision.

## 8. Shared storage, observations and decisions

### 8.1 One application storage boundary

Keep SQLite tasks and attempts together. Their transactional coupling is intentional.

Replace the suggestion that `TaskStore` alone is independently replaceable with an internal application-store contract exposing semantic operations: reserve, start, record result/outcome, accept, claim request and archive. It may be implemented across several modules sharing one connection and transaction boundary.

External trackers are import/synchronisation adapters, not a second authoritative lifecycle store. Supporting a different transactional store would replace the whole boundary, not just task reads.

Share task row decoding and focused transaction helpers between `SqliteTaskStore` and `AttemptStore`. Do not expose generic save/load methods that require callers to assemble invariants.

### 8.2 One observation path

Replace `dispatch.ts`'s separate `inspect()` logic with shared observation functions. Preserve batching: list shared leases and runtime records once for a context, and read only necessary records for a selected attempt.

Move summary and log interpretation helpers out of `dispatch.ts` so observation code does not depend on the dispatch command module.

Represent each observation as known-present, known-absent or unknown with its reason and observation time where useful. Do not mutate raw observations to apply operator confirmations. Derive effective facts from observations plus scoped confirmations, retaining their distinct provenance.

Derive attempt facts once. Derive display state and next actions from those facts, rather than having `assess.ts` and `state.ts` independently scan the log.

Operation-specific safety checks consume facts, not display labels. Specify the evidence each operation requires. A runtime stop request, for example, should not need a readable Git installation or lease provider merely to address the current runtime claim. Destructive operations retain all their relevant checks.

### 8.3 Revisions and query shape

Add a monotonic attempt revision incremented for relevant entries and confirmations. Use it for optimistic concurrency instead of serialising entire histories for equality checks. Check the expected revision in the mutation transaction.

Keep immutable audit entries. Do not add a second independently updated state model merely to avoid scans. Add indexes and focused queries where measurements justify them, particularly request lookup, active attempts and lease lookup.

### Acceptance tests

- Dispatch and status agree on liveness, confirmed stops and unknown owners from identical observations.
- Display classification is a pure function of assessed facts.
- Unknown required evidence refuses mutation; unrelated unavailable providers do not prevent safe inspection or control.
- Concurrent changes invalidate expected revisions, including confirmation-only changes.
- Context observation does not repeat shared provider reads for every attempt.

## 9. Shared application operations and finalisation plans

### Implementation

Extract semantic operations from `dispatch.ts` and `finish.ts`, reusing the existing safety checks and storage transactions:

- Reserve an attempt.
- Record allocation and start the reserved task.
- Claim or prevent launch.
- Record validated output and task outcome.
- Accept exact output.
- Integrate exact output under current policy.
- Return retained work's lease.
- Explicitly discard work and return its lease.
- Archive execution detail and schedule file deletion.

Retained return and discard remain distinct operations even if they share provider calls. Each owns its safety checks, intent, external call and read-back. Callers must not reconstruct these rules.

Introduce one small typed finalisation planner and runner. Plans are internal data, not repository-supplied scripts. Each step has:

- A stable kind and human-readable description.
- Preconditions and evidence requirements.
- A check of whether the effect is already complete.
- An intent where an uncertain external outcome requires one.
- An action and owner read-back.

Dry run and execution use the same planner. Execution rechecks conditions immediately before effects; a dry run is not permission. If assumptions changed, refuse or replan explicitly rather than following stale output.

Do not persist a runner position, add automatic replay or implement a dependency-graph workflow engine. Resumption inspects application records and external owners and skips confirmed completed steps.

Represent `manual` and `local-merge` as policy definitions with their own steps and integration evidence. Add `pull-request` only when its roadmap work is approved. Each policy preserves the shared retention and authority checks.

### Acceptance tests

- With unchanged owners, dry-run steps match the executed semantic steps.
- Inject a failure before and after every external effect; rerunning never blindly repeats an uncertain effect.
- A completed integration is not repeated when only task recording or lease return remains.
- A changed target, approval, task revision or output is detected before the relevant effect.
- No transaction holds a database write lock during external calls.
- `finish`, `discard` and dispatch use the shared operations rather than separate implementations of the same rule.

## 10. Operation-specific dependency construction

### Implementation

Split configuration parsing from opening providers and validating launch prerequisites.

- Task commands open the application database only.
- Historical inspection opens records first and reports unavailable external evidence.
- Stop and steer open the control-request path and require the addressed runtime claim.
- Finish/discard open the owners required by their plan.
- Dispatch validates Pi installation, model profile, executable paths and launch storage before reserving work.

Keep full configuration validation where an operation needs it, but do not require a readable Pi entrypoint to inspect or finish old work. Missing runtime software is not missing historical evidence.

Return explicit close/dispose ownership for opened resources. Close already opened databases if later provider construction fails, and do not depend only on a process exit listener for library-style operation calls.

Remove the Pi-named `PiRunReport` alias from dispatch dependencies and use the runtime-independent report type. Keep capability checks explicit before adding another runtime; unsupported steering must refuse rather than change message semantics.

### Acceptance tests

- Remove or invalidate the configured Pi executable: status, task inspection and eligible finalisation still work without launching anything.
- Missing Git or Treehouse appears as unknown only for observations that need it.
- Launch still refuses missing runtime prerequisites before reservation or acquisition.
- Failed construction and repeated in-process calls do not leak database handles.

## 11. Trusted callers and scoped approvals

### Implementation

Add a trusted operation context supplied by the host or CLI, separate from operation arguments. It identifies the principal and the capabilities granted by current configuration. A model cannot choose `operator` by passing a string.

Keep display labels such as `--as` as audit metadata, not authorisation.

Represent approval separately from factual confirmation:

- Approval authorises a specific protected action.
- Confirmation records an operator assertion about a fact, such as no remaining processes.

Approval scope names the operation, context/attempt, exact output and target where relevant. Include issuer, issuance time, optional expiry/revocation and consumption rules. Lease-return confirmation remains scoped to a single return intent. Publishing and changed-output acceptance need their own scopes.

Application operations enforce the rules for every caller, including CLI and supervisor. Read-only or worker-reported content can never create approval. Recheck current authority before protected external effects, including after restart and after a durable tool replay.

Do not expose unrestricted shell/database tools to the reasoning supervisor. Give it only the shared application operations it needs.

### Acceptance tests

- Model arguments cannot claim operator identity or create approval.
- CLI and supervisor calls receive the same safety decisions for the same trusted authority.
- Expired, revoked, wrong-commit, wrong-target and wrong-attempt approvals refuse.
- Restored conversations and old tool results do not grant current permission.
- Repeating a consumed approval cannot authorise a different effect.

## 12. Resource admission and accounting

### 12.1 Separate resource dimensions

Add a minimal objective record only for explicitly grouped work: identity, task scope, status, budget policy and authority scope. A normal one-off task need not invent an objective.

Track these limits independently:

- Active attempts per context.
- Retained allocations and pending acquisitions per configured scope.
- Optional disk high-water limits.
- Per-attempt time, token and cost limits.
- Objective-wide expenditure and admitted budget reservations.

Enforce application-owned admission and budget reservations in the same transaction as attempt reservation. Never call a provider or measure disk inside that transaction. External resource observations remain time-bounded evidence, not exact transactional inventory.

Retained-capacity accounting must include unresolved acquisitions conservatively. Hitting a limit refuses new work with an actionable report; it never triggers destructive cleanup automatically.

### 12.2 Accounting semantics

Current usage polling is not a hard spending cap: a request can exceed a limit before the next observation, and failed snapshots are ignored. Document this precisely.

Model missing usage as unknown, not zero. Record provider, currency/unit, observation scope and whether values are cumulative. Reject a configured cost limit for a runtime that cannot report usable cost, or require an explicit alternative token/time policy.

Add a configurable maximum accounting gap when a spending limit is enabled. If usage remains unavailable past it, stop conservatively and record why. A subscription provider reporting zero cost must not be presented as proof of free execution.

For objective admission, reserve a finite per-attempt allowance and reconcile it against observed usage. Unknown final usage retains an unresolved budget obligation until reconciled or explicitly resolved. Explain that this prevents ordinary over-admission but cannot guarantee a provider-side hard cap or eliminate in-flight overshoot.

### Acceptance tests

- Concurrent reservations cannot exceed active-attempt or objective admission limits.
- Retained lease limits block admission without returning any lease.
- Missing or stale usage follows the configured accounting-gap policy.
- Unsupported cost reporting is not silently accepted as zero.
- Crashes and uncertain outcomes do not silently release outstanding budget obligations.
- Status distinguishes limits, observed usage, reservations and uncertainty.

## 13. Continuation lineage

### Implementation

Add an explicit continuation operation that creates a new attempt from retained output. It is not retrying the old worker or resending its prompt.

The request records:

- Parent attempt and exact accepted or explicitly selected retained deliverable.
- Reason for continuation.
- Immutable written handover.
- New task specification and objective reference.
- New request ID, attempt identity, branch, lease and runtime session.

Require current task eligibility, output retention, caller authority and resource admission. A possibly running parent worker or uncertain parent output blocks continuation. Direct-child termination alone must not be described as permission to recycle the old workspace.

Acquire a fresh workspace from the exact selected commit. Do not mutate the old branch or reuse its worker. Permit the old lease to remain retained once the explicit continuation rules are satisfied; replace the current broad same-task lease exclusion only for this deliberate path, not for ordinary dispatch.

Record new validation and acceptance against the new output. Earlier checks and review are historical context, not acceptance of changed work.

### Acceptance tests

- Crashes around reservation and acquisition preserve one new logical continuation.
- Unknown, possibly running or unretained parents refuse.
- The new worker starts from the exact selected commit and immutable handover.
- Old branch, result and lease remain unchanged.
- Continuation respects active-attempt, retained-capacity and aggregate budget limits.
- Review-failure repair can complete without restarting the old session.
- Dependent work becomes eligible only under the normal acceptance contract.

## 14. Operating-model decisions

These are conditional design evaluations for Switchboard, not a repeat of the completed product comparison. Undertake only the evaluation needed by the next selected feature. Do not implement every alternative.

### 14.1 Execution ownership

Compare:

- Existing foreground execution plus a background dispatcher, each allowed to own workers.
- One context execution host; foreground commands submit work and wait for results.

For the single-host option, prototype host exclusivity, client disconnect, stop/steer, stale-owner refusal and restart inspection. Preserve database capacity checks and launch fences. Do not implement automatic takeover or assume that host restart recovers worker ownership.

Choose based on total implementation and operator complexity. If the host option is selected, `dispatch --once` becomes a submit-and-wait client using the same application request identity; it does not independently launch a second execution path. If multiple execution owners are retained, document and test their ownership cases explicitly.

Use the OS service manager for optional production service lifecycle rather than inventing a competing service manager. Service installation remains a separately approved feature.

### 14.2 Workspace lifecycle and containment

Compare the current recyclable pool with:

- Fresh, non-recycled attempt workspaces and explicit later garbage collection.
- A qualified container or VM execution boundary with explicit descendant-termination evidence.

Non-recycling reduces the need to prove safety at immediate completion, but eventual deletion still needs process and retention checks. It trades disk use for simpler routine operation; it is not automatic cleanup permission.

Containment must qualify process ownership, filesystem access, credentials, result export, cancellation and host failure on each supported platform. A VM or container label alone is not evidence of these properties.

If non-recycling is selected, implement it behind the workspace provider boundary with explicit keep/discard/collect operations. If containment is selected, expose verified termination evidence through the runtime contract and allow automatic return only for qualified configurations. Retain operator confirmation elsewhere.

### 14.3 Feature scope and Durable

Complete the immediate correctness and simplification steps before expanding scope. Then select features by reduced operator intervention, implementing only the relevant backlog prerequisites. Unless a demonstrated need justifies selecting one next, propose deferring:

- Additional runtimes beyond the working Pi path.
- General mailboxes and schedules.
- New session-multiplexing or UI infrastructure already available elsewhere.
- Automatic retries and unattended acceptance outside explicit policy.

This deferral changes the approved roadmap only after approval.

Keep deterministic finalisation in application operations. Continue evaluating the narrow Pi Durable supervisor boundary against plain-note/application-record reconstruction using the same requirements. Plain notes are not assumed equivalent. Production Durable adoption still requires the existing authority, storage, replay and platform qualification gates. Do not add per-attempt Durable workflows without a new demonstrated benefit.

## 15. Documentation and operator experience

### Current-state documentation

Create one concise description of what is implemented, its trust model and supported platforms. Keep historical phase specifications and investigations as evidence, clearly labelled by status and baseline. Avoid copying the same current design into every document.

Correct the known drift:

- `docs/task-store.md` says the store is not implemented.
- README says runtime storage migration follows, although runtime records are in SQLite.
- The Phase 3 PRD describes supervisor extraction as future work despite `src/runtime/supervisor.ts`.
- `docs/principles.md` retains an outdated concurrency-enforcement statement.

Update ADR-0007 and architecture terminology to describe one application storage boundary, durable request tombstones and separate deliverable retention. Record newly accepted decisions in focused ADRs rather than silently rewriting historical decisions.

### Trust and limits

State prominently:

- Workers currently execute as the operator's user and are trusted, not sandboxed.
- Private settings and environment allowlists do not prevent access to same-user files or credentials.
- Usage limits are observation-based and can overshoot.
- Result validation is not independent correctness verification.
- Backup restore is not ordinary restart.
- Direct-child exit does not establish whole-worker termination.

### Operator tools

Add structured inspection/export for specifications, validated results, deliverables, approvals and request tombstones. Every refusal should name the relevant identity, missing evidence and safe next action. Preserve machine-readable reason codes.

Document a stopped-writer backup/restore procedure including the database and retained files. Include a manifest of identities and digests, validation before activation, and an explicit dispatch-disabled reconciliation step. Backups may contain secrets; export and sharing defaults must avoid including credentials or unrestricted transcripts.

Keep legacy import support isolated. Define its supported source versions and eventual removal conditions. Remove compatibility aliases from normal runtime code once callers and tests migrate; do not remove the import before existing users have a supported path.

## 16. Migration and qualification strategy

### Database migrations

- Use versioned, transactional schema migrations and explicit data conversions.
- Preserve attempt numbers, launch fences, request identities, scoped confirmations and historical uncertainty.
- Refuse conflicting identities or unsupported newer schemas.
- Do not infer missing output acceptance, independent validation or operator permission during migration.
- Require stopped writers for migrations involving retained-file relocation or repository rebinding.
- Test interrupted migration/activation and old-version refusal.

### Test layers

1. Pure tests for fingerprints, facts, policies and safety checks.
2. Store tests for atomic admission, revisions, tombstones, approvals and references.
3. Adapter tests using synthetic runtimes and disposable repositories.
4. Cross-process races and crash injection around every new external-effect boundary.
5. Existing root suite on macOS, Linux and Windows.
6. Explicitly authorised real-runtime qualification on each platform claimed as supported.

Keep real model use separate from the default test suite. No trial should publish work, spend money or alter real task stores without explicit scope.

### Measuring the next feature

Establish a Switchboard baseline using representative work, then repeat the relevant scenarios after implementing the selected feature:

1. Ordinary code change through review and integration.
2. Independent report consumed by later work.
3. Worker interruption after useful commits.
4. Orchestrator interruption before acknowledgement of an effect.
5. Review rejection followed by repair.
6. Two independent tasks with a shared integration target, when concurrency is in scope.

Measure operator interventions, elapsed time to accepted work, failed-attempt cost, useful retained output, retained lease count/age and recovery steps. Record configuration and trust assumptions. Use the results to choose the next bounded feature; this is not another product comparison.

### System acceptance

The checks below apply when the unattended workflow is selected for implementation; they are not prerequisites for releasing the immediate fixes. Before calling that workflow complete, demonstrate one objective containing review, repair and dependent work, including an orchestrator interruption. Verify:

- No duplicate logical dispatch after replay or pruning.
- No mixed input snapshots.
- No acceptance of a different commit or artefact than the reviewed subject.
- No deletion of referenced deliverables.
- No authority gained through task text, worker output or restored conversation state.
- No lease return without the required retention, identity and process evidence.
- Resource admission and accounting uncertainty remain visible after restart.
- Recovery can make progress through documented operations rather than database edits.

Record interventions per completed objective and compare them with the current baseline. A larger passing test count alone is not evidence of a simpler or more useful system.

## 17. Recommendation coverage

| Review recommendation | Implementation in this plan |
| --- | --- |
| Fix mixed task snapshots | Section 4: revision checks and immutable specification |
| Preserve deduplication after prune; reject changed input | Section 5: operation requests, fingerprints and tombstones |
| Model repository/context identity and configuration provenance | Sections 4 and 6 |
| Freeze validated output and accepted deliverables | Section 7 |
| Separate artefact retention from execution cleanup | Section 7.4 |
| Model continuation lineage | Section 13 |
| Model active, retained and aggregate resource limits | Section 12 |
| Treat missing usage explicitly | Section 12.2 |
| Enforce trusted callers and scoped approvals | Section 11 |
| Correct the replaceable task-store abstraction | Section 8.1 |
| Consolidate observation and classification | Section 8.2 |
| Replace whole-history equality checks | Section 8.3 |
| Share finalisation operations and dry-run plans | Section 9 |
| Avoid a general deterministic workflow engine | Sections 9 and 14.3 |
| Inspect/recover without Pi installed | Section 10 |
| Remove Pi-specific report naming | Section 10 |
| Share task decoding and focused storage helpers | Section 8.1 |
| Bound legacy compatibility support | Section 15 |
| Consider one execution owner | Section 14.1, when needed by the selected feature |
| Compare non-recycling and contained execution | Section 14.2, when needed by the selected feature |
| Defer speculative runtimes, mailboxes, scheduling and UI | Section 14.3, subject to roadmap approval |
| Qualify the narrow Durable boundary against reconstruction | Section 14.3 |
| Clarify the trusted-worker security model | Sections 1, 7 and 15 |
| Consolidate stale documentation | Section 15 |
| Measure useful recovery and operator effort | Sections 3 and 16 |
