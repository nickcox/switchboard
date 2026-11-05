# Supervisor command

`switchboard supervise <operation> --objective <id> [options]` is the restricted command for a supervisor working on one objective. It always constructs the caller `{ kind: "supervisor", objectiveId: "<id>" }` itself. There is no caller option or environment override. Every operation requires exactly one `--objective`, naming an existing objective. The objective must be open, except when recording usage or session state for a session already registered to it.

This is the shared command interface. The [Pi host](#starting-a-pi-supervisor) binds it to an agent session; other hosts can use the same operations. `src/runtime/supervisor.ts` supervises workers and is unrelated to this interface.

## Starting a Pi supervisor

```sh
switchboard supervisor start --objective release-notes --config /absolute/path/switchboard.json
```

Run this in a terminal with Pi installed at `worker.piEntrypoint` and credentials available to Pi. The command refuses unknown, completed or abandoned objectives before starting Pi. Each invocation starts a fresh interactive session and asks it to call `sb_briefing` first. After an interruption, run the command again: the briefing and notes rebuild its understanding from current records, without resuming an old transcript. Workers already dispatched continue independently.

The optional configuration object `supervisor` can set `provider`, `model` and `thinking`; each omitted setting defaults to the worker's corresponding setting. For example:

```json
{ "supervisor": { "provider": "openai-codex", "model": "gpt-6.1-sol", "thinking": "high" } }
```

The session's working directory, Pi session directory and private tool-input directory are under `<runtimeRoot>/supervisors/<objective-hash>/session-<unique-suffix>/`. The extension fixes the objective and absolute configuration path at startup. Tool inputs cannot change either, supply a caller or choose a request ID. The `sb_` tools mirror the operations below (spaces become underscores, for example `sb_task_add`). File-backed inputs are supplied as text or structured data, not paths: `body`, `criteria`, dispatch `note` and objective-completion `statements`. The host creates private files for them. Dispatch and ask derive a stable request ID from the session and tool call; retrying that call does not dispatch or ask twice.

Only these supervisor tools are offered to the model. There is no shell, file reader, editor or file-writing tool, and no discovered skills, extensions, prompt templates, context files or MCP servers. An explicit supervisor system prompt also prevents a discovered `SYSTEM.md` from replacing its role. The shared Agent Skill in [`skills/switchboard-supervisor/SKILL.md`](../skills/switchboard-supervisor/SKILL.md) is appended in full to that system prompt, so compaction does not remove it and no file-reading tool is needed. It covers restarting from the briefing and notes, planning tasks and dependencies, responding to events, reviewing and repairing exact commits, asking questions, respecting limits and completing each objective criterion. The file has portable Agent Skills frontmatter for use by other hosts too; Pi does not depend on skill discovery or a later skill-loading turn. Pi still uses the operator's provider credentials and model settings. This is a restricted agent interface, not an operating-system sandbox; trusted extension code runs as the operator.

`wait` and `handled` are not agent tools. The extension waits in background code and sends one event at a time as a user follow-up, including while Pi is busy. It acknowledges only after Pi reports delivery of that exact message to the agent, not when it was queued or a turn ended. Failed waits and acknowledgements are retried with a delay. No later event is fetched until acknowledgement succeeds. A session ending before delivery leaves the event unhandled for the next session. Once the objective closes, the extension stops waiting and delivering events, including follow-ups already queued in Pi. It learns closure from a successful completion result or a closed-objective refusal; before sending a queued event to the model, it also checks the objective through `objective show`. Usage reporting continues until session shutdown. Acknowledgement records delivery, not proof that the model made the right decision; the briefing remains the source of current facts.

The supervisor cannot change its objective's authority, budget or criteria, act on unrelated tasks, bypass safety refusals, or confirm that all worker processes have stopped. In particular, it cannot return leases. A person must inspect and confirm lease return separately. The extension registers the session before its first model request and reports cumulative model usage after each turn through the host-only usage operation. Supervisor and worker cost both count towards the objective budget.

## Operations

All invocations accept `--config <path>` (default: `SWITCHBOARD_CONFIG`, then `./switchboard.json`). Output is always JSON; `--json` is accepted but unnecessary. Options have the same meaning as on the ordinary commands unless noted below. An option not used by an operation is refused, rather than silently ignored.

| Operation | Arguments and options |
| --- | --- |
| `briefing` | Rebuilds the supervisor's briefing from current records. No other arguments or options. |
| `note "<text>"` | Appends a supervisor note to the objective. Text must not be blank. |
| `usage` | Host-only accounting, not an agent tool. Requires `--session <id>`; optional `--cost <cumulative-cost>` and `--tokens <cumulative-tokens>`. Omitted values or `unknown` mean unreported. |
| `session-state` | Host-only observation, not an agent tool. Requires a registered `--session <id>` and `--state stopped\|resumed`. A stop requires `--error <message>` and accepts repeatable `--event <id>` for events delivered since the last successful response. |
| `ask "<question>"` | Records a question for the person. Optional repeatable `--choice <text>` and `--request-id <id>`. |
| `wait` | Returns the first unhandled event, polling if none is pending. Optional `--timeout <seconds>` is a nonnegative number; omission waits indefinitely. |
| `handled <event-id>` | Records that the next unhandled event has been dealt with. Safe to repeat. |
| `objective show` | Shows the named objective, its tasks, attempts, criteria, spending, references, history and person interventions. No positional objective ID. |
| `objective complete` | `--statements-file <json>` supplies the criterion completion statements and recorded references described in [Objectives](objectives.md#completing-abandoning-and-reopening). No positional objective ID. |
| `task add <id> "<title>"` | Creates a task in the named objective. Also accepts `--title`, `--body` or `--body-file`, `--repo`, `--kind`, and repeatable `--criterion` or `--criteria-file`. There is no separate task-objective option. |
| `task show <id>` | Shows one of the objective's tasks. |
| `task list` | Lists the objective's tasks across repositories. Accepts optional `--repo` and `--state queued\|in_flight\|done` filters. |
| `task update <id>` | `--title`, `--body` or `--body-file`, `--repo`, `--kind`, and repeatable `--criterion` or `--criteria-file`. Cannot move or unlink the task from its objective. |
| `task hold <id>` | `--reason <text>` is required. |
| `task release <id>` | Releases a task's hold. |
| `task block <id>` / `task unblock <id>` | `--by <task-id>` is required. |
| `task done <id>` | Optional `--note <text>`. |
| `dispatch` | Requires `--task <id>`. Accepts `--from-attempt <n>` with `--note <text>` or `--note-file <path>`, `--dry-run` and `--request-id <id>`. Starts one detached dispatch and returns when its attempt is reserved or the dispatch is refused. `--dry-run` stays in the foreground. Takes no `--once` flag. |
| `review` | `--task <id>` and optional `--attempt <n>`. Creates a review task in the same objective; dispatch it separately. |
| `answer` | `--task <id> --question <question-id> "<answer>"`, with optional `--wait <seconds>`. |
| `steer` | An attempt selector and `"<message>"`, with optional `--after`, `--as <label>` and `--wait <seconds>`. |
| `stop` | An attempt selector, with optional `--as <label>` and `--wait <seconds>`. |
| `finish` | An attempt selector, with optional `--accept-output`, `--rebase` and `--dry-run`. Always retains the lease. |

An attempt selector is `--lease <lease-id>` or `--task <task-id> [--attempt <n>]`. With `--task`, the default is its latest attempt. Stop and steer's `--as` is only a display label; the recorded sender remains `supervisor:<objective-id>`.

For example:

```sh
switchboard supervise briefing --objective release-notes
switchboard supervise note --objective release-notes "Review the upgrade instructions before accepting output"
switchboard supervise objective show --objective release-notes
switchboard supervise task add write-notes "Write release notes" --objective release-notes \
  --body-file instructions.md --criterion "Explain manual upgrade steps"
switchboard supervise dispatch --objective release-notes --task write-notes \
  --dry-run --request-id release-notes-write-1
switchboard supervise dispatch --objective release-notes --task write-notes \
  --request-id release-notes-write-1
switchboard supervise review --objective release-notes --task write-notes
switchboard supervise finish --objective release-notes --task write-notes
switchboard supervise objective complete --objective release-notes --statements-file completion.json
```

### Detached dispatch

Unlike ordinary `dispatch --once`, supervisor dispatch records the request and its fixed supervisor caller in the database, then starts a separate Node.js process. That process reads its caller and explicit inputs from the recorded request – no argument or environment variable supplies its caller. It has its own process group, no terminal input, and standard output and error go to `supervisor-dispatches/<request-hash>/output.log` under the runtime root. The database stores that path relative to the runtime root; responses name it as `observed.outputPath`.

The command returns `dispatch_started` with exit code 0 as soon as the attempt is reserved. `attempt` contains `contextId`, `taskId`, the attempt number and `requestId`. Reservation is not proof that acquisition or worker launch succeeded. The dispatcher continues after the calling command or agent session exits, including normal worker supervision, budget checks, keep-awake when configured, and finalisation. Use `wait` for the worker's eventual events, or read the briefing. Stop a worker with `supervise stop`, not by interrupting the command that asked for dispatch.

Each detached dispatch runs one worker, so the supervisor can have several workers at once, up to the context's `maxAttempts` (default 1). Events from all of them arrive through one `wait`, in the order they happen. A dispatch beyond that maximum is refused at capacity.

A refusal before reservation returns its ordinary reason and exit code 1. If the process ends before reserving, the response is `dispatch_start_failed`, naming its output file in `detail` and `observed.outputPath`. Inspect that output before making a new request. If the caller dies between recording launch intent and confirming process start, a replay reports `reconciliation_required` when the start remains unconfirmed; it never starts another process for that ID.

Supply a stable `--request-id` to make a repeated tool call safe. Omission generates one, returned with the attempt. Replaying a reserved request returns `existing_request` and the original attempt, including after pruning, without starting another dispatcher or worker. A pre-reservation refusal or startup failure is retained and returned on replay, even if the task later becomes ready; make a new request with a new ID after addressing it. Different explicit inputs or a different supervisor caller refuse as `request_input_mismatch`. A concurrent replay waits for the original reservation or refusal. Request and launch records do not expire.

`--dry-run` still runs in the calling process and launches nothing. It retains ordinary dispatch dry-run checks and replay behaviour, and does not record a detached request. Ordinary `dispatch --once` is unchanged and stays in the foreground. Both commands print only one JSON response through this restricted interface; the detached process's progress is written to its output file.

Schema 16 adds the detached launch records. The request identity, caller, explicit inputs and relative output path are immutable. The process claims a recorded launch once; repeating the internal entry point cannot launch another worker. Attempts and their request-ID records remain authoritative for reservation and attempt state.

## Briefing and continuity

Start every new supervisor session with:

```sh
switchboard supervise briefing --objective release-notes
```

This reads Switchboard's records, not an earlier conversation. It returns one JSON object with `ok: true`, `action: "briefing"` and:

- `objective`: the person's original request, scope, constraints, state, permissions, budget, deadline, spending and remaining budget and time. Accounting is the same `objectiveBudget` calculation as `objective show`, including unknown usage, archived attempts and other contexts. Each item in `criteria` has its position, text, completion statement and `status` (`pending` or `completed`). A task's completion or a worker's claim does not complete an objective criterion.
- `tasks`: every currently linked task, across repositories, with its definition, state, hold, acceptance criteria, `dependencies` (blocker IDs) and all its attempts across contexts. Each live attempt has `status`, taken directly from the same assessment as `status`, and the complete read-only `assessment`, including its next action, worker exit evidence and any unknown owners. `checks` are the latest results for each check of its current recorded output commit; `reviews` are the recorded reviews of that commit.
- Each attempt also has `outputRetained` and `retention`, the last recorded retention check and its timestamp, not a new Git check or permission to accept. `null` means no recorded check. `leaseHeld` is `true`, `false` or `null` when the owner cannot establish it; `leaseReturn` explains whether a person still needs to inspect and return the lease. A held lease alone does not block further work. A worker's direct exit is not proof that all processes it started have stopped.
- Archived attempts have `archived: true`, their saved assessment's `status`, summary, checks, reviews and retention evidence where retained. They are not reclassified from incomplete archive data; missing historical classification or retention is `null`. Archiving preserves the evidence needed for later briefings and intervention counts.
- `possiblyRunning`: attempt identities and a plain warning that their worker may still be running and the task must not be started again. The same warning is on each affected attempt. This includes workers with fresh dispatcher heartbeats as well as workers whose dispatcher is gone.
- `openQuestions`: unanswered worker questions, with their IDs, task and attempt, text, choices and waiting flag, including questions left open after exit or archive.
- `openPersonQuestions`: unanswered questions the supervisor asked the person, with IDs, objective, text, optional choices, author and time.
- `notes`: the supervisor's notes, oldest first.
- `personInterventions`: the same count and list as ordinary `objective show`, described below.
- `events`: `count` of unhandled events and `first`, the first such event or `null`. Reading the briefing does not acknowledge events or record a passed deadline.
- `diagnostics`: context and owner-read failures. Unknown owner state is not evidence that a worker stopped or a lease was returned. For other contexts, inspection uses the configured workspace provider; an attempt in a pool it cannot inspect stays unknown, just as in `status`.

The briefing is read-only and needs no task mutation permission or installed Pi runtime. It does not dispatch, accept output, return a lease, complete criteria or answer a question. Changing operations still re-read their owners and enforce their own safety checks; a briefing is not lasting permission to act. The existing rule that the restricted command requires an open objective applies to the briefing too.

### Supervisor usage

Trusted host code reports the supervisor's own model usage through this operation; do not offer it as a tool to the agent:

```sh
# Register the session before its first model request, with usage still unknown.
switchboard supervise usage --objective release-notes --session <pi-session-id>
# Report Pi's cumulative session counts, not a turn's delta.
switchboard supervise usage --objective release-notes --session <pi-session-id> --cost 0.15 --tokens 12000
```

The response is `{ "ok": true, "action": "usage", "usage": ... }`. The snapshot contains `sessionId`, `objectiveId`, `sequence`, `observedAt`, `cost` and `tokens`. The operation supplies the observation time. Cost and tokens must be finite nonnegative numbers; omission or the literal `unknown` records `null` until that value is first reported. A provider-reported zero is known, not a fallback for missing usage. Tokens are Pi's cumulative total token count.

A new session can be registered only while the objective is open. Once a session has an earlier usage snapshot for that objective, further usage is recorded whatever the objective's state, including completed or abandoned. This records money already spent, without reopening the objective or permitting any other supervisor operation. Post-completion usage still counts towards `objectiveBudget` and the objective's cost limit.

Every call appends a snapshot, including repeat observations. Each value retains its session's highest reported value, independently: a delayed, lower or missing observation cannot reduce recorded spending. Reusing a session ID for another objective is refused. A resumed session uses the same ID; a new session uses a new ID, and their costs are added. Hosts should register each session even when usage reporting is unavailable. Switchboard cannot account for a session the host never identifies.

`spending.workers` and `spending.supervisors` in the briefing and `objective show` list their costs separately. The latter also includes known token subtotals and each session's latest snapshot, so unreported usage remains visible as `null`, not zero. Combined cost is unknown if either side is unknown; `observedCost` is only the known subtotal. No registered sessions means an empty session list, not evidence about unreported sessions. The existing `spending.unknown` list and creator confirmations still concern finished worker attempts; supervisor snapshots do not assert session exit or elapsed worker time.

Combined observed worker and supervisor cost counts towards the objective's cost limit. Recording usage also records any newly reached budget event in the same transaction. Further dispatch is refused at the limit; running workers retain the existing stop-on-overrun behaviour. Supervisor conversation time does not count towards `maxWorkerTimeMs`. Usage is an observation, not a hard provider-side spending cap.

Schema 19 adds append-only `supervisor_usage` snapshots without changing existing records. Database triggers refuse changing, deleting, replacing, lowering or moving them. Accounting uses the latest cumulative snapshot per session, never the sum of its snapshots. Recording needs the bound supervisor, but no task mutation permission. Only initial session registration needs an open objective. The Pi extension calls this operation at session startup with only the session ID, then after each turn with cumulative cost and total tokens from Pi's turn messages (including reported nested tool usage). Assistant-message usage is also reported before its tools run, so the last response is accounted for before a tool can complete the objective; the turn report does not count it twice. It also accounts for reported compaction usage. Reloading reconstructs totals from the session's entries, including compacted and off-branch messages, rather than only the current context. Missing or invalid usage leaves that cumulative value unknown, never a zero fallback or a later partial total; known numeric snapshots never decrease. A failed report does not reset the totals, so the next report still includes earlier turns. Usage is host-only and is not offered as an agent tool.

### Stopped supervisor sessions

When Pi settles with its last assistant response ending in `stopReason: "error"`, the extension records the session as stopped. It uses `agent_settled`, not `agent_end` or `agent_before_settle`: Pi has finished its own automatic retries, recovery and queued continuations at that boundary. Switchboard reports the failure; it does not retry the model call.

The host-only operation records the Pi session ID, observation time, provider error message and IDs of events delivered since the last successful model response:

```sh
switchboard supervise session-state --objective release-notes --session <pi-session-id> \
  --state stopped --error "Codex error: The usage limit has been reached" --event <event-id>
switchboard supervise session-state --objective release-notes --session <pi-session-id> --state resumed
```

Schema 20 adds append-only `supervisor_session_states` observations. Database triggers prevent changing, deleting, replacing or moving them. The session must already be registered through `usage` for that objective; observations remain allowed after objective closure. A later successful response in the same Pi session, or a replacement session registered to the same objective, appends a resumed record when supervision needs recovery. It clears attention from earlier stops for that objective without changing their history. Registering a fresh session alone does not clear attention, nor does a successful response for another objective. An automatic retry that succeeds before settling does not record a stop. Aborted responses are neither provider errors nor successful resumptions.

While a session's latest observation is stopped and no later successful response has been recorded for that objective, `status` (including `--attention-only`), the briefing's `objective` and `objective show` report `attentionRequired: true`, `stoppedSessions` and a recovery `nextAction`. Each stopped session includes `observedAt`, `errorMessage` and `eventIds`. Status text marks the objective as needing attention. These IDs identify delivered work without a successful response, not events still waiting for delivery: the extension continues acknowledging delivery exactly as before. Acknowledgement is not proof that the model acted on an event, and this observation does not undo it or replay handled events.

Check the provider first – for example, its usage limit or credentials. Then send a message in the supervisor's Pi session, or start a fresh session with `switchboard supervisor start --objective <id> --config <path>` and read the briefing. Workers continue independently. A successful response in the existing session or a fresh session for the same objective clears the warning. Every stop remains in the append-only history; a replacement session's recovery is recorded under its own session ID.

### Notes

```sh
switchboard supervise note --objective release-notes "Use the smaller design; the larger one is outside scope"
```

The response is `{ "ok": true, "action": "note", "note": ... }`. A note contains `objectiveId`, a per-objective `sequence` starting at 1, the exact `text`, `writtenAt` and `writtenBy` (`supervisor:<objective-id>`). The command fixes the author, as for every other supervisor operation. Notes remain available even if task permissions have been narrowed, and writing one does not count as a person intervention.

Schema 14 adds `supervisor_notes` without changing existing records. Appending and allocating its sequence are one transaction. Notes cannot be edited, deleted or replaced: database triggers reject those operations, not just the command interface. Write a later note to correct an earlier one. Notes survive session restarts, objective changes and attempt pruning. They contain reminders and decisions, not authority to change the objective's permissions, budget, instructions or delivery contract.

### Questions to the person

```sh
switchboard supervise ask --objective release-notes --choice "Small" --choice "Large" \
  --request-id design-1 "Which design should we use?"
switchboard objective answer release-notes --question <question-id> "Small"
```

Only the bound supervisor can ask, and only about its own open objective. Asking needs no task mutation permission. The response is `{ "ok": true, "action": "ask", "question": ... }`. Each question records `id`, `objectiveId`, exact `text`, optional `choices`, `askedAt`, `askedBy`, `requestId` and `answer` (initially `null`). Text and choices must not be blank. Choices are suggestions, not a restriction on the person's answer.

Supply a stable request ID to make replay safe. Repeating it within that objective returns the original question, including its answer if one has since been recorded. Reusing it with different text or choices is refused. Omission generates an ID. Request IDs are scoped to the objective and do not expire.

Open questions appear as `openPersonQuestions` in the briefing, ordinary `status --json` and `objective show`. Human-readable status shows the question, choices and answer command. A person's answer records exact `text`, `answeredBy` (the operating-system caller) and `answeredAt`. Any person can answer, including after the objective closes; an answer does not reopen it. A supervisor cannot answer these questions, even with `answerQuestions` permission – that permission concerns worker questions. Unknown questions and another objective's questions are refused. A second answer is refused with the first answer's author, time and text.

Schema 17 adds `person_questions` and `person_answers` without changing existing records. Questions and answers cannot be edited, deleted or replaced; database triggers enforce this. Recording the answer also records a `person_answered` event in the same transaction, with the question ID, question text and answer. `wait` delivers it through the ordinary event protocol. Each answer counts once as a person intervention with action `answer`, not as an extra generic intervention event. These records survive attempt pruning.

### Events, waiting and acknowledgement

```sh
switchboard supervise wait --objective release-notes --timeout 30
switchboard supervise handled --objective release-notes <event-id>
```

`wait` returns `{ "ok": true, "action": "wait", "event": {...}, "timedOut": false }` immediately when an event is pending. Otherwise it polls the database until an event arrives or the timeout passes. Idle polls only read; they take the write lock only when a newly reached budget or deadline, or a newly stale dispatcher heartbeat, needs an event recorded. A timeout returns `{ "ok": true, "action": "wait", "event": null, "timedOut": true }`, with exit code 0. `--timeout 0` checks once without waiting. Without `--timeout`, it waits indefinitely.

Each event has an opaque stable `id`, `objectiveId`, increasing per-objective `sequence` starting at 1, `kind`, timestamp `at`, `contextId`, `taskId`, `attempt` and `details`. Objective-wide events have `null` task and attempt fields. The kinds are:

- `worker_finished`: the attempt log recorded the end of a worker, including completed, held, failed and stopped outcomes. Details retain the recorded worker status and outcome.
- `question_asked`: a valid worker question was recorded, with its question ID, filename, text, choices if supplied and waiting flag. Invalid files and repeat polls are not new events.
- `attempt_held`: an attempt's hold outcome was recorded, including its reason and category.
- `decision_needed`: an attempt halted, an owner-read failure was recorded, or a configured check failed or could not run. Details retain the original failure record.
- `review_recorded`: a review was recorded against the reviewed task and attempt, with the exact commit, verdict and findings.
- `budget_reached`: observed objective cost or worker time reached a configured limit. Details name the budget, limit and observed spending. Cost and worker-time limits have separate events.
- `deadline_reached`: the first wait or dispatcher check observed a passed deadline.
- `dispatcher_heartbeat_stale`: the first wait observed that the process running a worker stopped refreshing its heartbeat (30 seconds), or released its claim, while no worker exit is recorded and no person has confirmed the worker stopped. The worker may still be running, and dispatch in the context is blocked until a person confirms it stopped with `resolve --worker-stopped`; the supervisor cannot do that itself, so it tells the person. Details give the lease ID, the last heartbeat and whether the claim was released. Each stale heartbeat is one event; a heartbeat that resumes and goes stale again produces another.
- `person_answered`: a person answered a supervisor's question; details include its question ID, text and recorded answer.
- `person_intervention`: one of the person decisions or lease-return confirmations described below. Details retain the original intervention identity and record. Forwarded messages, answer-delivery copies and mirrored confirmation entries do not create extra events.

Only facts about the objective, its tasks and their attempts produce events. Supervisor notes, inspection, unrelated tasks and successful housekeeping do not. A recorded owner-read failure during an archived attempt's cleanup still produces `decision_needed`. A worker finishing and its attempt being held are distinct facts and may produce separate events. Event facts are recorded in the same database transaction as their source records; failed transactions leave neither behind. Deadline, elapsed-time and stale-heartbeat observations have no source write, so wait and dispatcher checks record them transactionally when first observed. A process that stops cannot record that it stopped, which is why `wait` checks the heartbeats of the objective's workers itself. A particular deadline or budget limit produces at most one event per objective; changing to a different deadline or limit can produce another. Existing records are not backfilled on migration. Events and their sequence numbers survive attempt pruning and task membership changes.

`wait` **never moves the handled position**. Deal with the event, then call `handled` with its ID. That command returns `{ "ok": true, "action": "handled", "event": {...} }` and advances the objective's position in the database. It refuses unknown IDs, events belonging to another objective and attempts to skip the next unhandled event. Repeating acknowledgement of an already handled event succeeds without moving backwards or changing its acknowledgement time. The position records the fixed supervisor caller and acknowledgement time. Concurrent acknowledgements are serialised. Both operations check the bound supervisor and current open objective inside the operation; neither needs a task mutation permission.

If the host or agent crashes after reading an event but before acknowledging it, the next wait – including one from a new process or session – returns that same event. Acknowledgement means the supervisor has dealt with it, not merely displayed it. Hosts should not acknowledge before handing it to the agent. Schema 15 adds the immutable event log and handled positions without changing existing records.

### Person interventions

`personInterventions` has `count` and oldest-first `items`. Each item identifies its original source record, action, actor, time, task and attempt where applicable, and details. It is calculated from existing records, not another intervention table:

- objective history, except objective creation;
- task changes, including adding or moving a task, with membership from their before and after snapshots;
- an attempt's original dispatch request, `finish`'s integration intent or finished task outcome, and a recorded rebase request;
- scoped confirmations, including explicit output acceptance and confirmation that a worker stopped;
- stop and steer requests, using the request's sender, not its display label or the dispatcher that forwards it;
- recorded answers, not their file or steering-message delivery copies.

Only records at or after objective creation with a recorded person actor contribute. Supervisor actions and missing historical actors are not turned into person actions. Task history establishes membership at the time of each attempt decision, so moving a task does not erase earlier interventions or attribute later changes to its old objective. Dispatch uses the objective captured in its immutable specification. Where historical membership is missing, the specification or current task link supplies the available association. Task membership changes remain in the history of the objectives they name.

The unit is a recorded decision or confirmation, not a shell invocation: `finish --accept-output` can record both an explicit acceptance and a finished task. A confirmation's matching attempt entry is not counted again, nor is a forwarded copy of a stop, steer or answer. A finish with both an integration intent and a finished task outcome from the same actor is counted once; integration of an already-done task still counts. Dispatch's automatic stages and task outcome are not new interventions. Read-only inspection, no-op changes, request-ID replays and housekeeping such as pruning are not new decisions about the work. Pruning keeps the original decision records and actor evidence in the attempt's archive rather than losing the count. Recording a new event applies these same rules to its source record, rather than recalculating the whole objective's interventions. Schema 18 adds indexes for a task's change history and an attempt's confirmations so these lookups do not scan unrelated records.

`personInterventions.leaseReturns` has its own `count` and `items`, outside the intervention count. These are the person's `no_processes` and `lease_returned` confirmations. A return intent, confirmation and successful return are not three separate returns; the confirmation is the counted record, and may still need reconciliation if the return failed. Lease return is separate because a supervisor can never make that confirmation. Ordinary `objective show` reports this same structure, including for a completed objective.

## Refusals and authority

The command exposes only the operations above, whatever permissions an objective grants. It does **not** accept:

- `discard`, `resolve`, `prune`, `cleanup-output-branches` or `import`
- `finish --no-processes`
- objective `add`, `list`, `update`, `confirm-budget`, `abandon` or `reopen`
- task `ready`, `reopen` or `convert-criteria`, or task `--clear-objective`
- `status`, `watch`, any other operation, a second `--objective`, or a positional objective ID

An unknown objective is refused. A completed or abandoned objective is refused, including for inspection, except for usage and session-state observations from a session already registered to that objective. A person must reopen it through the ordinary objective command before supervision can resume.

Refusals caused by a completed or abandoned objective include `code: "objective_not_open"` and its current `state` (`"completed"` or `"abandoned"`), alongside the unchanged `reason: "rejected"` and `detail`. This includes an objective closing during `wait` and registration of a new usage session after closure. For example:

```json
{ "ok": false, "reason": "rejected", "detail": "Objective release-notes is completed; reopen it explicitly before supervising it", "code": "objective_not_open", "state": "completed" }
```

Hosts should detect closure from `code` and `state`, not the human-readable `detail`. The Pi extension uses these fields to stop event delivery while continuing usage reporting. Unknown objectives and unrelated refusals do not carry this code.

The command does not implement a second permissions policy. It calls the existing task, objective and attempt operations with the fixed supervisor caller; their current [authority checks](objectives.md#callers-and-permissions), acceptance evidence, budget and safety refusals still apply. Read-only inspection needs no mutation permission, but remains scoped to the objective. Showing its tasks, reading its briefing and reading or writing its notes cannot be narrowed through permissions. Task-list results are filtered to that objective. Changing a task outside the objective is refused by the existing operation checks, and their refusal reason is preserved. Finishing can accept, integrate and record a task as done, but it never confirms that processes have stopped or returns a lease. A person must inspect and confirm lease return separately.

Each invocation prints exactly one JSON object to standard output, including usage, configuration and operation refusals. Successful task and objective operations use the ordinary `--json` wrapper (`ok`, `action` and `task`, `tasks` or `objective`); attempt operations return their existing structured result unchanged. Task-store refusals use `ok: false`, `reason` and `detail`. Usage and configuration errors also have `ok: false`, `reason` and `detail`, with `usage` for command-validation errors. Exit codes follow the ordinary commands: 0 for an operation whose result is successful, 1 for an operation refusal or attention outcome (including a held dispatch or a replay of one), and 2 for usage or configuration errors. Recording an answer succeeds even if delivery fails, as on ordinary `answer`.

This is an application boundary, not a sandbox. A supervisor host must restrict the agent to this interface. An agent with an unrestricted shell, database access or the ordinary commands can bypass it and is not a restricted supervisor. See [the Phase 3 supervisor design](phases/03-supervisor/PRD.md#the-supervisor).
