# Attempt log format

Status: describes the attempt log implemented in `src/attempts/log.ts` for Phase 1. Decision: [ADR-0006](../../adr/0006-switchboard-attempt-log.md).

The attempt log records which task, lease, session, commits and outcome belong to each attempt. It is not authoritative for task state, lease state or worker liveness: Switchboard reads those from tasks-axi, Treehouse and the runtime records, and uses the log to know which owner state belongs to which attempt.

## Location

The log lives under the configured `runtimeRoot`, next to the runtime records and outside every workspace. Before any dispatch write, the runtime and log roots are checked against the provider's entire recyclable area, resolving existing ancestors. Treehouse supplies its configured pool root, covering idle workspaces and earlier pools as well as current leases:

```text
<runtimeRoot>/attempts/<sha256(contextId)>/<sha256(taskId)>/<attempt>/<sequence>.json
```

- Context and task IDs are hashed into directory names, so any ID is a safe path. The original IDs are kept in every entry, and reading checks that they match the directory.
- `<attempt>` counts from 1 for each task.
- `<sequence>` starts at `0000`, one per entry with no gaps, padded to at least four digits. It grows past `9999` without changing format. The maximum is `9007199254740991` (`Number.MAX_SAFE_INTEGER`); entry validation refuses larger numbers before writing.
- Existing `<sequence>-<kind>.json` entries remain readable, including alongside newer sequence-only entries. Stop older Switchboard writers before upgrading – they do not use the new sequence claim.
- Directories are created with mode `0700`. Linked directories are refused.
- The log has its own `attempts/` directory because runtime-record discovery refuses unexpected entries in a context directory.

## Entries

Each entry is one JSON file:

| Field | Meaning |
| --- | --- |
| `version` | Always `1` |
| `contextId`, `taskId`, `attempt` | Which attempt the entry belongs to |
| `sequence` | Position in the attempt, matching the file name |
| `kind` | One of the kinds below; also checked against the kind in legacy file names |
| `recordedAt` | ISO 8601 time the entry was written |
| `data` | The kind's fields, validated against its schema before writing and again when read |

| Kind | Written by | `data` |
| --- | --- | --- |
| `requested` | `dispatch`, always first | Optional `requestId`; the workspace `pool` acquisition will use (absent in older entries); the resolved delivery `contract` (its name, which is `default` or the selecting task kind, plus kind, acceptance, required evidence and deliverables) |
| `leased` | `dispatch` | `leaseId`, `workspace`, `baseRef`, `outputBranch`, `startingCommit`, and the workspace `pool` the lease was acquired in (absent in older entries) |
| `task_started` | `dispatch` | None. The task was confirmed in flight |
| `launched` | `dispatch` | `sessionId` |
| `operator_request` | `dispatch` | A forwarded stop request or message: `id`, `kind` (`stop`, `steer` or `follow_up`), `sender`, Pi's `outcome`, and optional `message` and `error` |
| `worker_finished` | `dispatch` | Runtime `status`, `runtimeDirectory`, and when known the failure `reason` and shortened `detail`, worker `outcome` and `resultCommit` |
| `task_recorded` | `dispatch`, `finish` | `outcome` (`done` or `hold`), the recorded `reason` (for a hold, the exact hold reason written to the task store), and `category`: `done`, `review_required`, `not_retained`, `held_by_worker`, `failed`, `interrupted` or `over_budget`. Entries written before `category` was added are read as having the category their recorded hold reason ends with |
| `retention_checked` | `dispatch` | `retained`, plus `findings` that prevent retention and `notes` that do not. Covers every reported Git branch/commit pair and artefact separately; artefacts must be readable regular files within the assigned artefact directory and outside every recyclable area |
| `halted` | `dispatch` | The `stage`, `reason` and optional `detail` of a dispatch that stopped before finishing; optional `leaseId`, `workspace` and `outputBranch` recovered from inspection. An uncertain acquisition records `reason: outcome_unknown`, so the `requested` pool identifies a lease that may still be held even without a `leased` entry |
| `operator_resolved` | `resolve` | `action` (`worker_stopped`, or `lease_returned` for a lease in a pool that is no longer listed) and an optional `note` |
| `output_accepted` | `finish --accept-output` | The accepted `commit` and `acceptedBy: "operator"`. The operator accepted committed output in place of the worker's result; subsequent finish runs can use this commit after a partial failure |
| `integrated` | `finish` | Under the `local-merge` policy: `policy`, the `targetBranch` fast-forwarded and the `commit` it now points to |
| `discarded` | `discard` | An optional `note`. Written once, before the lease is returned |
| `lease_return_started` | `finish`, `discard` | `leaseId`, `by` and `noProcessesConfirmedBy: "operator"`, written immediately before the workspace provider is asked to return the lease. If a later run finds the lease gone but no `lease_returned`, it writes `lease_returned` |
| `lease_returned` | `finish`, `discard` | `leaseId`, `by` (`finish` or `discard`) and `noProcessesConfirmedBy: "operator"`, recording that the confirmation was the operator's, not an observation |

The runtime records hold the launch input and the observed child exit ([runtime notes](runtime-integration.md#runtime-owned-records)). The log links to them through the lease and session IDs and the runtime directory, rather than copying them.

## Writing

- **Creating an attempt.** The caller names the latest attempt it has inspected for the task. Creation fails if any other attempt is now the latest. The new attempt's directory and its `requested` entry are written under a temporary name beginning with `.` and renamed into place, so readers never see an attempt without its first entry, and a rename that loses to another invocation fails instead of replacing its attempt. Together with the rule that a task whose latest attempt is unfinished is not selected, this is what stops two invocations dispatching the same task.
- **Reserving a request ID.** Before creating an attempt with a request ID, dispatch creates `<runtimeRoot>/request-ids/<sha256(contextId)>/<sha256(requestId)>.json` exclusively, recording the request ID, task ID and time. A call that finds the file already created returns the attempt holding that request ID, or refuses while it does not exist. The reservation is removed only when creating the attempt then fails.
- **Appending.** Each entry is written once under the next sequence number. It is written to a temporary file beginning with `.`, flushed, then hard-linked to its final name, so a reader sees either no entry or the complete entry. The final name contains only the sequence, regardless of kind, so concurrent dispatcher, control and resolution events contend for the same hard link. An existing entry is never replaced. A second writer of the same sequence fails with `EEXIST`, without an automatic retry or any entry from that call; the caller must inspect the log before deciding whether to append again.
- **Never edited.** Corrections are new entries. Phase 2's explicit `prune --older-than <days>` can remove finished attempts after archiving their summaries. It renames each whole attempt directory to `.<attempt>.pruned` before removing entries, so readers never see a partial attempt. It then moves the whole runtime directory under that hidden marker before deleting it, releases only the matching request-ID reservation and leaves a `.complete` receipt. An interrupted cleanup resumes from its immutable summary under `<runtimeRoot>/archive/<sha256(contextId)>/<sha256(taskId)>/<attempt>.json`. The hidden marker keeps attempt numbers from being reused; summaries retain identities, entry facts and the reservation's original identity, not runtime sessions or artefact contents.
- Entries are flushed before their write completes, but durability after host power loss has not been qualified.

## Reading

Readers ignore names beginning with `.`, which are writes in progress. They parse and sort sequence numbers numerically, including legacy names, rather than sorting file names lexically. Anything else that is unexpected causes refusal rather than an empty or partial result:

- an entry that fails its schema
- a gap or duplicate in the sequence
- a file name that does not match the entry's sequence (or kind, for legacy names)
- an attempt whose first entry is not `requested`, or with a `requested` entry anywhere else
- an entry whose context, task or attempt does not match its location
- an attempt directory with no entries

## Database migration boundary – not yet used by commands

`src/attempts/store.ts` provides the transactional operations for the ADR-0007 migration. Database schema version 2 adds attempts, immutable log entries, scoped confirmation records, archive summaries, pending directory deletions and retained attempt numbers. A request-ID reservation is a unique column of an attempt row; an imported reservation without an attempt can have a null attempt number.

The storage operations reserve an attempt while leaving its task queued, start the reserved task with `task_started`, record an outcome and close the attempt, and finish or discard against an expected task state. Outcome recording preserves a newer operator state or hold decision and does not append evidence to the task body. Archiving removes the attempt, entries, confirmations and reservation while recording its summary and directories to delete in the same transaction. Retained numbers are not removed. External checks and deleting the directories remain the caller's responsibility.

This boundary is not wired into dispatch, finish, discard, resolve, prune or import yet. The file format and command behaviour described above still apply, including the legacy confirmation fields, task-body summaries, prune lock and recovery states. They must not be removed until those callers and the settled-record import use the database operations.

## Limits

The log does not hold a task lifecycle, a queue, retry state or schedules. Like the runtime records, it is not protected from a malicious worker running as the same operating-system user.
