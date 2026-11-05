# Reading status

`switchboard status` is read-only. It shows every live attempt record in the configured context, including finished attempts; it does not list pruned archives as live attempts. It also shows ready and in-flight tasks, capacity, dispatch blockers, open objectives and questions, unaccounted leases, orphaned in-flight tasks and finalisation policy. Inspection does not launch a worker, return a lease, delete a branch or rewrite an attempt record.

## Attention filtering

Use `switchboard status --attention-only` to hide finished attempts that need no attention. This is opt-in – ordinary `status` keeps the full attempt list. The filter keeps every unfinished or possibly running attempt, even a healthy worker whose only next action is to watch it. It is not a list of errors alone.

A finished label alone does not establish that an attempt needs no action. Independent actionable issues remain visible, including unresolved held or failed work, task/outcome disagreements, changed or missing result files, unsettled owner reads, open worker questions, invalid question files and unreadable output branches. A returned failed attempt can still need inspection after its task's hold is released. An attempt whose task is done but whose lease is retained remains visible until the lease is returned; filtering never returns it. Unknown owner or lease state is not treated as a confirmed return.

The text view reports `Omitted attempts needing no attention: N`, including `0` for no omissions or an empty context. Only attempt rows are filtered. Context-wide information, questions and diagnostics remain visible, and totals, overall `reason`, `ok` and `nextAction` are calculated from the full context, not the shortened list. Filtering therefore does not turn an attention or unknown result into a clear result.

## Stopped supervisors

An objective needs attention when a supervisor session's latest recorded state is stopped after a Pi model provider error. This remains visible with `--attention-only`, even with no worker attempts or pending events. The overall result is `reason: "attention"`, `ok: false` and a recovery next action, rather than quietly waiting for workers.

Text shows the objective's attention warning, Pi session ID, error message, observation time and IDs of events delivered since its last successful response. Those events may already be acknowledged – delivery is not proof that the supervisor acted on them. JSON objectives include `attentionRequired`, `stoppedSessions` (with `sessionId`, `observedAt`, `errorMessage` and `eventIds`) and `nextAction`. The briefing and `objective show` expose the same fields.

Check the provider, then send a message in the supervisor's Pi session or restart it with `switchboard supervisor start --objective <id> --config <path>`. Switchboard does not retry model calls. A later successful response in the same session records that it resumed, clearing that session's attention warning without changing its earlier stop record. A fresh session does not erase an older stopped session's observation. See [stopped supervisor sessions](supervisor.md#stopped-supervisor-sessions).

## Historical specifications

Older attempts may lack a complete stored specification. For a finished attempt, text says `Stored specification incomplete – historical attempt; no launch required`. Missing historical launch inputs alone do not require action and do not prevent omission when the finished attempt has no other issue. This does not fill in missing provenance or waive independent actionable issues.

An unfinished attempt with an incomplete specification still says `Stored specification incomplete – this attempt cannot be launched; inspect and resolve it` and remains visible. Filtering does not grant launch permission or change any operation's safety checks.

## JSON agreement and compatibility

`switchboard status --attention-only --json` uses the same selection and omission count as text:

- `attempts` contains the visible attempts.
- `omittedCount` is the number of finished attempts hidden by the filter, including zero. It is absent from default `status --json`, and default text has no omission line.
- Each attempt has `attentionRequired` and `specificationStatus` (`complete`, `incomplete` or `historical`), alongside the existing `specificationComplete` flag. A historical specification remains incomplete; the new status explains why that alone is not a launch warning.
- A healthy running attempt can have `attentionRequired: false` and still be included. Selection is not simply a filter on that flag.
- Context fields remain unfiltered, including `capacity`, `blockingDispatch`, `ready`, `inFlight`, `objectives`, questions, `reason` and `nextAction`.

The JSON envelope remains version 1. Default compatibility means keeping the unfiltered attempt list and omitting filter metadata, not freezing every per-attempt field or diagnostic wording.

## Current output branch state

Status reads the attempt's local output ref in its recorded backing repository, falling back to the configured repository when no backing repository was recorded. It does not rely on the latest cleanup entry as proof that the branch still exists or is still absent. Text and JSON `outputBranchCleanup.status` agree:

| Status | Meaning |
| --- | --- |
| `deleted` | A successful Git read finds the exact local branch absent. Without a matching recorded deletion, the detail says `Output branch is absent`; this is an observation, not proof that Switchboard deleted it. |
| `kept` | The branch currently exists. A branch recreated after a recorded deletion is shown as kept with `Output branch exists despite recorded deletion`. Existing kept-cleanup details are retained where applicable. |
| `unknown` | Git could not reliably read the ref, including failed commands, timeouts, truncated output or warnings such as a broken ref. This is never reported as deleted, even after a recorded deletion. |

Unknown branch state remains visible under `--attention-only` and requests inspection when no other action was pending. A cleanup detail beginning with `Could not` also remains actionable. A known absent branch does not itself require attention, but it does not hide an attempt's other issues or establish that its output was accepted, integrated or retained elsewhere. Status changes neither Git refs nor cleanup history; the recorded `output_branch_cleanup` entry still describes an earlier cleanup operation, not a live observation.
