# Phase 2: Reconciliation and recovery

Status: agreed on 20 October 2026; implemented and complete on macOS as of 21 October 2026 (see [verification](verification.md)). Requirements, not a description of existing behaviour.

## Objective and scope

An operator can see, for every attempt, how tasks-axi, Treehouse and the runtime records disagree, and can finish, repair or clean up each attempt with one Switchboard command that enforces the safety rules, instead of several manual steps across three tools.

Phase 1 finishes an attempt by holding or completing its task and preserving its lease; everything after that is manual. In real use on Switchboard's own backlog, finishing a reviewed attempt took three steps with three tools: merge the output branch with Git, record the task as done with tasks-axi, and return the lease with Treehouse. Recovering from a failed attempt took more. Phase 2 moves those steps into Switchboard, where the existing checks (retention, identity, the attempt log) can guard them.

Phase 2 keeps Phase 1's operating model: one host, one dispatcher at a time in the foreground, one attempt at a time, and the attempt log as Switchboard's only persistent state. Every Phase 1 safety rule still holds; in particular, Switchboard never returns a lease unless the conditions in [Returning a lease](#returning-a-lease) are met.

In scope:

- A classification of every attempt's state across the three owners, used by `status` and by the commands below.
- Finishing an attempt with one command, under a finalisation policy configured per context.
- Returning a lease, and discarding unretained work, as explicit operator commands with their own checks.
- A retention policy for attempt records.

Out of scope:

- A finalisation policy that pushes the output branch and opens a pull request, with finishing that waits for the pull request to be merged and a retention check that works with the remote (Phase 3).
- A background dispatcher, attempts in parallel and another runtime (Phase 3).
- Starting a new attempt automatically after a temporary provider error; dispatching again stays with the operator until an agent supervisor can decide it (Phase 4).
- Proving that every process a worker started has stopped, and so automatic lease return. The [process-ownership survey](process-ownership-survey.md) found this needs a virtual machine per attempt or Endpoint Security's descendants client on macOS; it is deferred, and Phase 2 relies on the operator's confirmation instead.
- Policies defined as scripts or hooks in a repository file, which would run code the repository supplies and need their own opt-in design.
- Switchboard merging into a protected branch.
- Real-dispatch qualification on Linux and Windows, which stays a Phase 1 platform item.

Inputs: the [architecture's notes for later phases](../../architecture.md#notes-for-later-phases), the [process-ownership survey](process-ownership-survey.md), the [Phase 1 review](../01-basic-dispatch/review-2026-10-20.md) and its out-of-scope concerns, and the [Phase 1 verification record](../01-basic-dispatch/verification.md).

## Pi Durable checkpoint

The runtime notes and [ADR-0003](../../adr/0003-pi-durable-for-durable-orchestration.md) require a short comparison with Pi Durable before reconciliation is implemented, and before any retry, restart or replay is added. Phase 2's reconciliation is a read of owner state followed by explicit operator commands; it adds no queue, scheduler, retry, replay or long-running process, and starts no work without an operator command. Record that comparison in ADR-0005's "Continuing comparison" section before implementing it.

## Attempt states

Every attempt is classified from its attempt-log entries and each owner's current state. The classification replaces the ad hoc next-action rules in `status` and is the single source for every command's checks.

| State | How it is recognised | Next action |
| --- | --- | --- |
| Running | Launched, no observed exit, fresh dispatcher heartbeat | Watch it |
| Possibly running | Launched, no observed or confirmed exit, no fresh heartbeat | Confirm the worker stopped (`resolve --worker-stopped`) |
| Unfinished, no lease | Open attempt with no listed lease and no worker | Confirm it stopped (`resolve --task --lease-returned`) |
| Awaiting review | Task held for review, lease preserved, retained | Review, then `finish` |
| Awaiting finish | Task recorded as done, lease preserved, retained | `finish` (returns the lease) |
| Held for another reason | Task held as failed, interrupted, over budget or held by the worker; lease preserved | Inspect, then `finish --accept-output`, dispatch again or `discard` |
| Not retained | Retention check failed; lease preserved | Fix the output, or `discard` with confirmation |
| Lease in another pool | Lease recorded in a pool Treehouse no longer lists | Return it by path, then `resolve --lease-returned` |
| Task update unconfirmed | Final task update not confirmed | Complete the update, then `finish` |
| Stopped | Halted after acquiring its lease, or its task is still in flight with no lease | Inspect the attempt |
| Finished | Task outcome recorded and lease returned or never acquired | Nothing |

`status` shows each attempt's state, in its text output and as the `state` and `changeable` fields of its JSON. Unaccounted leases and orphaned in-flight tasks remain separate findings, as in Phase 1. A state that cannot be determined because an owner is unreadable is reported as unknown and blocks every command that would change that attempt.

## Finishing an attempt

`switchboard finish --lease <lease-id>` completes an attempt according to the context's finalisation policy. It is the operator's statement that the work has been reviewed and should be integrated; it never runs for an attempt that is running, possibly running, unfinished or unknown.

**Accepting committed output.** A worker can commit its work and then fail before writing its result, for example when its last provider request fails. For a held attempt (including failed, interrupted and over-budget attempts), `finish --lease <lease-id> --accept-output --no-processes` is the operator's decision to accept the output branch's current head instead of the worker's result. The branch must exist in the backing repository, and its head must be a strict descendant of the attempt's starting commit. Retention checks that the branch contains that commit and that the workspace has no uncommitted or untracked files; no worker result is needed. Running, possibly running, unfinished, unknown and other-pool attempts remain ineligible. Dry runs do not record acceptance.

Before integrating or changing the task, `finish` records `output_accepted` with the commit and `acceptedBy: "operator"`. After a partial failure, a later `finish` can use that recorded acceptance without the flag or a worker result, checking retention against the accepted commit again. With the flag, the current branch head is checked and accepted afresh if it has changed. Acceptance does not skip the finalisation policy, task update, process confirmation or conditional lease return. Without the flag or a previous operator acceptance, the worker-result checks remain unchanged.

**Finalisation policy.** Each context has one finalisation policy, separate from the delivery contracts, which say what a worker must produce. A policy is one of a fixed set of kinds built into Switchboard, because each kind is a sequence of steps that move or publish work and needs its own read-back, uncertain-outcome handling and retention check. Documents choose the kind and its settings, such as the target branch; they cannot define new kinds or run commands. Phase 2's kinds are:

- `manual`: Phase 1's behaviour. `finish` records the task as done and returns the lease, and the operator integrates the output branch themselves before running it.
- `local-merge`: `finish` fast-forwards a configured target branch, such as `main`, to the output branch in the backing repository, refusing if that is not a fast-forward, then records the task as done and returns the lease.

A `pull-request` kind follows in Phase 3. The layers and checks below are designed so it can be added without changing them.

**Where the policy comes from.** Three layers, each overriding the one before:

1. Global defaults in the operator's configuration directory, for example `~/.config/switchboard/policy.json`.
2. A policy file committed to the repository, for example `.switchboard/policy.json`, so the repository's own integration rules travel with its code.
3. The context configuration, which is the operator's final word for that context.

Each layer is a JSON object with an optional `kind` (`manual` or `local-merge`) and `targetBranch`; the operator layers may also have `forbid`, a list of kinds. In the context configuration the layer is the `finalisation` object, which may also set `globalFile` to move the global layer. A missing layer is skipped, an invalid one is an error, and `local-merge` targets the configured base branch unless a layer sets `targetBranch`.

Operator-level layers (the global defaults and the context configuration) can also forbid kinds, for example "never `local-merge`", and a repository file cannot allow a forbidden kind. Switchboard reads the repository file only from the base branch in the backing repository, never from a workspace or an output branch: a worker can edit any file in its workspace, and reading the policy from there would let a worker change how its own work is integrated, contrary to the rule that worker output is data, never instructions. A change to the policy file therefore takes effect only once it has been merged into the base branch. `status` and `finish --dry-run` show the resolved policy and which layer set each part of it.

**Facts from the forge.** Where Switchboard can read them, for example whether the target branch is protected on GitHub, facts from the repository's forge are used to refuse a policy that cannot work, not to choose one: `local-merge` into a protected branch fails before any step, with the reason, rather than partway through.

Each step reads back its owner's state, and `finish` can be run again after any failure to complete the remaining steps, as Phase 1's hold update already can. Every step is recorded in the attempt log with new entry kinds (for example `integrated`, `lease_returned`).

## Returning a lease

Returning a lease recycles the workspace and is the only routine action that can destroy work, so `finish` and `discard` return a lease only when all of these hold:

1. The attempt's state allows it: awaiting finish (after the task is recorded) for `finish`, or confirmed by the operator for `discard`.
2. The retention check passes, run again immediately before returning, unless the operator is discarding the work explicitly. For accepted output it checks the operator's accepted commit, not the worker's result.
3. The workspace holds no running process from the worker. Switchboard cannot prove this, so it is the operator's confirmation, given with the `--no-processes` flag on `finish` and `discard`, and recorded in the attempt log as theirs, not as an observation. Without the flag, both commands stop before returning the lease and say what to check. `status` shows what Switchboard can see to help: the observed exit, the heartbeat, and the workspace's open files where the platform can list them.
4. The return is conditional on the lease's identity and holder, as Phase 1's operator instructions already require (`treehouse return --if-lease-id --if-lease-holder`).

`switchboard discard --lease <lease-id>` returns a lease whose work is not retained, or not wanted, after the operator confirms they intend to discard it. It records the discard and leaves the task held, so the task can be dispatched again or closed by the operator. A task already recorded as done stays done.

## Retention of attempt records

`switchboard prune` removes the records of finished attempts older than a configured age, after writing a summary of each to an archive file under the runtime root. It never removes an attempt that is unfinished, holds a lease, may have a running worker or is unknown, and removes a request-ID reservation only together with the attempt it points to. It is run by the operator; Phase 2 has no background cleanup.

## Acceptance criteria

1. `status` reports each attempt's state from the classification above, and every command refuses an attempt whose state is unknown.
2. The policy is resolved from the global, repository and context layers, with forbidden kinds enforced and the repository file read only from the base branch; a test changes the policy file on an output branch and shows it has no effect.
3. `finish` under `manual` and `local-merge` completes a reviewed attempt in one command, can be repeated after a failure at any step without repeating completed steps, and refuses running, possibly running, unfinished and unknown attempts.
4. No command returns a lease without a passing retention check (or an explicit discard), the operator's `--no-processes` confirmation, and a lease identity check. Tests disable each condition in turn and show the return is refused.
5. `discard` returns a lease only after explicit confirmation and leaves the task held, or done if it was already done.
6. `prune` never removes an attempt that is unfinished, holds a lease, may be running or is unknown, nor a reservation whose attempt remains.
7. A real end-to-end run finishes a reviewed attempt with `finish` under `local-merge`.
8. `finish --accept-output` accepts held committed output under manual and local-merge policies without a worker result, records the operator's acceptance, and can complete after partial failure. Missing or unadvanced branches, dirty workspaces and unsafe attempt states are refused.
