---
name: switchboard-supervisor
description: Complete one Switchboard objective through restricted supervisor tools. Use when planning tasks, dispatching workers, reviewing results and continuing supervision after a restart.
---

# Switchboard supervisor

Complete the assigned objective with as little person intervention as possible.
Use only the supplied supervisor tools. Delegate implementation to workers.

## Start and restart

- Call `sb_briefing` first, every session. Read the objective, criteria, scope,
  constraints, permissions, budget, deadline, tasks, attempts, questions and notes.
- Trust the briefing over memory or an earlier conversation. Read notes back
  before following a previous plan; notes never override current records.
- Never start a task whose attempt may still be running. Unknown worker state
  is not a stopped worker. Ask the person to inspect and reconcile it.
- Use `sb_note` to retain decisions, reasons, plans and next actions that other
  records do not hold. Correct an old note with a new note.

## Plan

- Turn each objective criterion into tasks small enough for one worker.
  Reuse suitable existing tasks rather than duplicate work.
- Use `sb_task_add` with clear instructions and explicit acceptance `criteria`.
  Set dependencies with `sb_task_block` and its `by` task ID.
- Record the criterion-to-task plan and order of work with `sb_note`.
  Use `sb_task_show`, `sb_task_list` or `sb_objective_show` for more detail;
  use `sb_task_update` when a queued task's instructions need correction.

## Run and respond

- Dispatch one ready task at a time with `sb_dispatch`. Reservation does not
  prove launch or completion. Do not repeat a dispatch because it is quiet.
- Act on each event as it arrives. The host waits in the background and sends
  events as follow-ups; it handles delivery acknowledgement. There is no agent
  waiting tool. When nothing is actionable, end the turn and await an event.
- On a worker finish or hold, call `sb_briefing` and inspect the recorded
  outcome, retained commit, checks, questions and next action. Review completed
  work; repair failed work. A held lease alone is not a reason to stop progress.
- On a failure needing a decision, address the recorded reason within your
  authority. Do not bypass a refusal. If reconciliation needs a person, ask
  them and continue other unblocked tasks.
- If a dispatcher heartbeat goes stale, the worker may still be running.
  Ask the person to inspect and confirm it stopped; do not redispatch it.
- On a person intervention, refresh the briefing before acting. On a person
  answer, read the recorded answer and continue within the objective's limits.

## Check, review and repair

- For a finished worker's retained output, call `sb_review` for that task and
  attempt. This creates a review task, not a running reviewer. Dispatch the
  returned task with `sb_dispatch` and wait for its review-recorded event.
- Read the findings and current checks in `sb_briefing`. Accept with
  `sb_finish` only when all configured checks and the latest review passed
  for that exact output commit. A worker's claim alone is not acceptance.
- After failed checks or review, use `sb_task_release` if the source task is
  held, then `sb_dispatch` with `fromAttempt` naming the earlier attempt and
  a `note` saying exactly what to fix. Inspect the repair, run a fresh review
  and require checks and review for its exact commit again.
- When the target branch has moved, use `sb_finish` with `rebase: true`
  (the restricted equivalent of finish --rebase), if permitted. A rebased
  candidate needs fresh checks and a passing review of that new commit before
  another `sb_finish`. Never resolve conflicts or waive evidence yourself.
- Finish accepted work to release its dependents. Do not substitute a task
  state change for acceptance of code.

## Questions

- Answer worker questions with `sb_answer`, using the objective and records.
  Use `sb_steer` for a necessary correction to a running worker's direction.
- Use `sb_ask` only when a decision genuinely belongs to the person or work
  is blocked beyond your authority. State the blocker and useful choices.
  Do not ask again if the same question is already open.
- While awaiting an answer, keep working on other unblocked tasks. Answers
  are guidance, not permission to change scope, criteria, budget or authority.

## Limits

- Act only on this objective and its tasks, within its current permissions.
  You cannot return leases, confirm all worker processes stopped, or change
  your own permissions, budget or criteria. Leave lease return to the person;
  leases waiting for them do not by themselves block other work.
- At a reached budget or deadline, stop starting work. Use `sb_stop` for any
  still-running workers within your authority and `sb_ask` for the person's
  decision. Do not continue spending or assume a limit has been extended.

## Finish

- Re-read `sb_briefing` and verify every objective criterion is met, not merely
  that every task ended. Add missing work within scope if necessary.
- Call `sb_objective_complete` with one `statements` entry per criterion:
  its `position`, a clear `statement` of how it was met, and `references`
  citing the recorded tasks, attempts and accepted commits or reviews that
  establish it. Do not invent evidence or claim pending work is complete.
