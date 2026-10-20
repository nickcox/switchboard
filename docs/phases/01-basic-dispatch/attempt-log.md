# Attempt log format

Status: describes the attempt log implemented in `src/attempts/log.ts` for Phase 1. Decision: [ADR-0006](../../adr/0006-switchboard-attempt-log.md).

The attempt log records which task, lease, session, commits and outcome belong to each attempt. It is not authoritative for task state, lease state or worker liveness: Switchboard reads those from tasks-axi, Treehouse and the runtime records, and uses the log to know which owner state belongs to which attempt.

## Location

The log lives under the configured `runtimeRoot`, next to the runtime records and outside every workspace:

```text
<runtimeRoot>/attempts/<sha256(contextId)>/<sha256(taskId)>/<attempt>/<sequence>-<kind>.json
```

- Context and task IDs are hashed into directory names, so any ID is a safe path. The original IDs are kept in every entry, and reading checks that they match the directory.
- `<attempt>` counts from 1 for each task.
- `<sequence>` is four digits from `0000`, one per entry, with no gaps.
- Directories are created with mode `0700`. Linked directories are refused.
- The log has its own `attempts/` directory because runtime-record discovery refuses unexpected entries in a context directory.

## Entries

Each entry is one JSON file:

| Field | Meaning |
| --- | --- |
| `version` | Always `1` |
| `contextId`, `taskId`, `attempt` | Which attempt the entry belongs to |
| `sequence` | Position in the attempt, matching the file name |
| `kind` | One of the kinds below, matching the file name |
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
| `task_recorded` | `dispatch` | `outcome` (`done` or `hold`) and the recorded `reason` |
| `retention_checked` | `dispatch` | `retained`, plus `findings` that prevent retention and `notes` that do not |
| `halted` | `dispatch` | The `stage`, `reason` and optional `detail` of a dispatch that stopped before finishing; optional `leaseId`, `workspace` and `outputBranch` recovered from inspection. An uncertain acquisition records `reason: outcome_unknown`, so the `requested` pool identifies a lease that may still be held even without a `leased` entry |
| `operator_resolved` | `resolve` | `action` (`worker_stopped`, or `lease_returned` for a lease in a pool that is no longer listed) and an optional `note` |

The runtime records hold the launch input and the observed child exit ([runtime notes](runtime-integration.md#runtime-owned-records)). The log links to them through the lease and session IDs and the runtime directory, rather than copying them.

## Writing

- **Creating an attempt.** The caller names the latest attempt it has inspected for the task. Creation fails if any other attempt is now the latest. The new attempt's directory and its `requested` entry are written under a temporary name beginning with `.` and renamed into place, so readers never see an attempt without its first entry, and a rename that loses to another invocation fails instead of replacing its attempt. This is what stops two invocations dispatching the same task.
- **Appending.** Each entry is written once under the next sequence number. It is written to a temporary file beginning with `.`, flushed, then hard-linked to its final name, so a reader sees either no entry or the complete entry. An existing entry is never replaced, so a second writer of the same sequence number fails.
- **Never edited or deleted.** Corrections are new entries.
- Entries are flushed before their write completes, but durability after host power loss has not been qualified.

## Reading

Readers ignore names beginning with `.`, which are writes in progress. Anything else that is unexpected causes refusal rather than an empty or partial result:

- an entry that fails its schema
- a gap or duplicate in the sequence
- a file name that does not match the entry's kind and sequence
- an attempt whose first entry is not `requested`, or with a `requested` entry anywhere else
- an entry whose context, task or attempt does not match its location
- an attempt directory with no entries

## Limits

The log does not hold a task lifecycle, a queue, retry state or schedules. Like the runtime records, it is not protected from a malicious worker running as the same operating-system user.
