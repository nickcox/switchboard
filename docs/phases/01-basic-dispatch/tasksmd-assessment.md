# tasks.md git-native assessment

Status: candidate investigation run on 18 October 2026. This does not replace tasks-axi in the architecture or change ADR-0001.

## Verdict

The git-native backend's main feature works as described: two clones claiming the same task at the same time produce exactly one claim, and a stale claim ID is refused. The hold mapping also works.

Do not adopt it for Phase 1 as it stands. Two of its behaviours conflict with the guarantees Switchboard depends on most:

- **Claims are not enforced.** The claim ID is checked only when a caller supplies one. Another actor completed a task Switchboard had a live claim on simply by leaving out `--claim`. Every reader can also see every claim ID through `list --json`.
- **Not being able to read the store looks like an empty queue.** Running from a directory that is not the store, or while the remote is unreachable, `list` exits 0, returning `[]` or the local copy respectively. Principle 2 requires these to be reported as unknown.

The adapter can work around the second problem. It cannot fix the first; it can only keep other writers away from the store. Phase 1 already excludes concurrent claimants, so the backend's main advantage over tasks-axi does not apply yet, while it adds network and lease failure modes. Reconsider it when multiple dispatchers are planned, using a newer release.

## Investigated release

- `@tasks-md/cli` **0.10.2** from npm (integrity `sha512-U4lFM2l2…lyGQ==`, tarball SHA-256 `7cf38a20…80619`), run under Node.js 26.7.0 with Git 2.54.0 on macOS arm64.
- The GitHub repository was created on 1 October 2026, has one contributor, and its `main` branch says 0.11.0. That version is not published. `main` changes how claims are pushed (see [Other findings](#other-findings)).
- Specification: [spec.md, Fleet coordination](https://github.com/tasksmd/tasks.md/blob/main/spec.md#fleet-coordination).

The probe and its exact commands are in [`investigations/tasksmd/`](../../../investigations/tasksmd/README.md).

## Executable findings

| Check | Result |
| --- | --- |
| Claim a task whose `Blocked by` task is open | Refused: `status: blocked`, exit 1 |
| Two clones claim the same task at the same time | Exactly one `claimed`; the other gets `lost`, exit 1. One `claimed` event in the log |
| Another actor claims a task with a live claim | Refused: `lost`, exit 1 |
| `complete` or `update` with a wrong claim ID | Refused: `conflict`, exit 1 |
| Another actor runs `complete` with no claim ID while Switchboard holds a live claim | **Accepted**: `ok`, exit 0. The task is closed |
| Switchboard then runs `update --claim <its claim ID>` on that closed task | **Reports `ok`**, exit 0, although the task stays closed |
| Hold: `update --blocked "<reason and work references>" --claim`, then `unclaim --claim` | Works. The reason is kept, the body is unchanged, `pick` skips the task, `claim` reports `blocked`, and the dependent task stays blocked |
| Claim lease | Fixed at 24 hours. Neither the CLI nor the package's public exports allow changing it |
| `list` from a directory that is not a Git repository | `[]`, exit 0, with or without `--backend git-native` |
| Clone without `.tasksmd.json` checked out | Silently uses the plain `TASKS.md` file backend. Seen in an earlier run where the fixture's clone had no checked-out branch |
| `git worktree` of the store repository | Shares `refs/heads/tasks-claims`. A worker in the worktree claimed a task in the authoritative store |
| Completed task | Removed from `list`. Its events stay in the log, but no CLI command reads closed tasks |
| `fleet compact` | Removes every event for completed tasks from the log |
| Lost acknowledgement on `update` or `complete` | Retried automatically; exit 0, with two identical events in the remote |
| Lost acknowledgement on `claim` | Reports `lost`, exit 1, but the claim is in the remote and owned by Switchboard |
| Remote unavailable: `list` | Exit 0 with the local copy, without reporting that the fetch failed |
| Remote unavailable: `create` | Fails after retries with an uncaught exception, not JSON. The unpushed task is visible locally until the next successful fetch removes it |

The fold replays events in commit order, so "latest claim wins" is deterministic. Task IDs are generated from title slugs; callers cannot choose them.

## Proposed Phase 1 mapping, if adopted later

| Switchboard operation | tasks.md git-native |
| --- | --- |
| List ready work | `pick --json` or `list --unblocked --unclaimed --json`, after first confirming the store (see gates) |
| Mark in flight | `claim --json`; keep the returned `claimId` with the task and lease IDs |
| Record hold | `update --blocked "<reason> – <work references>" --claim <id>`, then `unclaim --claim <id>`, then read back |
| Record done | `update --body` with summary, evidence and work references, then `complete --claim <id>`, then read back from the log |
| Inspect an uncertain write | Fetch the claims ref and read the log; after a `lost` claim, check whether the assignee is Switchboard |

## Adoption gates

1. **Only Switchboard changes task state.** Without upstream support for refusing unfenced changes to a claimed task, this must be enforced outside tasks.md. Keep the store in a repository separate from the code repository, so Treehouse worktrees do not share its refs. This only limits mistakes; a worker running as the same OS user can still reach the store.
2. **Confirm the store before every read.** Check that the working directory is the configured store repository, `.tasksmd.json` selects `git-native`, and `refs/heads/tasks-claims` exists. Fetch the claims ref directly and treat a failed fetch as unknown, because the CLI does not report it.
3. **Read back after every write.** An `ok` result does not prove the intended state (see the update on a closed task), and a `lost` claim may have succeeded.
4. **Decide the lease policy.** Either send heartbeats while a worker runs, or treat any claim Switchboard did not release as blocking at preflight. The lease length cannot be changed.
5. **Keep outcome records.** Never run `fleet compact`, or keep the done record outside the log.
6. **Re-probe the release actually adopted.** `main` already differs from 0.10.2.

## Other findings

- 0.10.2 pushes the claims ref by name. The `main` branch pushes the exact commit instead, with a comment that worktrees sharing the ref could otherwise report a push as successful without the event reaching the remote. Keeping the store out of worker worktrees (gate 1) avoids this case in 0.10.2.
- The specification's security model relies on GitHub required checks or a server `pre-receive` hook. The probe did not test whether those reject an unfenced `completed` event pushed to the claims ref.

## Recommendation

Keep tasks-axi for Phase 1 and leave ADR-0001 unchanged. Keep the task-store interface limited to the operations in the mapping above, so that tasks.md git-native can replace tasks-axi without changing dispatch policy. Before multiple dispatchers or hosts are introduced, ask upstream for:

- refusal of `complete`, `update` and `unclaim` without the live claim ID
- a non-zero exit when the store cannot be found or fetched
- a configurable lease length
- reporting a claim whose acknowledgement was lost as owned, not `lost`

Then re-run this probe against that release.

## Sources

- [tasks.md specification](https://github.com/tasksmd/tasks.md/blob/main/spec.md)
- [`@tasks-md/cli` 0.10.2 on npm](https://www.npmjs.com/package/@tasks-md/cli/v/0.10.2)
- [git-native backend source on `main`](https://github.com/tasksmd/tasks.md/blob/main/packages/cli/src/backend/git-native.ts)
