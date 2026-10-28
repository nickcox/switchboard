# Supervisor command

`switchboard supervise <operation> --objective <id> [options]` is the restricted command for a supervisor working on one objective. It always constructs the caller `{ kind: "supervisor", objectiveId: "<id>" }` itself. There is no caller option or environment override. Every operation requires exactly one `--objective`, naming an existing, open objective.

This is the shared command interface, not a supervisor agent or host. The Pi extension, host skills, briefing, notes, event waiting, questions to the person and detached dispatch are separate work. `src/runtime/supervisor.ts` supervises workers and is unrelated to this interface.

## Operations

All invocations accept `--config <path>` (default: `SWITCHBOARD_CONFIG`, then `./switchboard.json`). Output is always JSON; `--json` is accepted but unnecessary. Options have the same meaning as on the ordinary commands unless noted below. An option not used by an operation is refused, rather than silently ignored.

| Operation | Arguments and options |
| --- | --- |
| `objective show` | Shows the named objective, its tasks, attempts, criteria, spending, references and history. No positional objective ID. |
| `objective complete` | `--statements-file <json>` supplies the criterion completion statements and recorded references described in [Objectives](objectives.md#completing-abandoning-and-reopening). No positional objective ID. |
| `task add <id> "<title>"` | Creates a task in the named objective. Also accepts `--title`, `--body` or `--body-file`, `--repo`, `--kind`, and repeatable `--criterion` or `--criteria-file`. There is no separate task-objective option. |
| `task show <id>` | Shows one of the objective's tasks. |
| `task list` | Lists the objective's tasks across repositories. Accepts optional `--repo` and `--state queued\|in_flight\|done` filters. |
| `task update <id>` | `--title`, `--body` or `--body-file`, `--repo`, `--kind`, and repeatable `--criterion` or `--criteria-file`. Cannot move or unlink the task from its objective. |
| `task hold <id>` | `--reason <text>` is required. |
| `task release <id>` | Releases a task's hold. |
| `task block <id>` / `task unblock <id>` | `--by <task-id>` is required. |
| `task done <id>` | Optional `--note <text>`. |
| `dispatch` | Requires `--task <id>`. Accepts `--from-attempt <n>` with `--note <text>` or `--note-file <path>`, `--dry-run` and `--request-id <id>`. Runs one attempt in the foreground, like ordinary `dispatch --once`, but takes no `--once` flag. |
| `review` | `--task <id>` and optional `--attempt <n>`. Creates a review task in the same objective; dispatch it separately. |
| `answer` | `--task <id> --question <question-id> "<answer>"`, with optional `--wait <seconds>`. |
| `steer` | An attempt selector and `"<message>"`, with optional `--after`, `--as <label>` and `--wait <seconds>`. |
| `stop` | An attempt selector, with optional `--as <label>` and `--wait <seconds>`. |
| `finish` | An attempt selector, with optional `--accept-output`, `--rebase` and `--dry-run`. Always retains the lease. |

An attempt selector is `--lease <lease-id>` or `--task <task-id> [--attempt <n>]`. With `--task`, the default is its latest attempt. Stop and steer's `--as` is only a display label; the recorded sender remains `supervisor:<objective-id>`.

For example:

```sh
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

Dispatch stays in the foreground until the worker finishes, so the caller must keep the command alive. Interrupting it asks the worker to stop and preserves the lease. It prints no progress stream, only the final JSON result. Stable request IDs retain the ordinary dispatch replay behaviour and exit codes.

## Refusals and authority

The command exposes only the operations above, whatever permissions an objective grants. It does **not** accept:

- `discard`, `resolve`, `prune`, `cleanup-output-branches` or `import`
- `finish --no-processes`
- objective `add`, `list`, `update`, `confirm-budget`, `abandon` or `reopen`
- task `ready`, `reopen` or `convert-criteria`, or task `--clear-objective`
- `status`, `watch`, any other operation, a second `--objective`, or a positional objective ID

An unknown, completed or abandoned objective is refused, including for inspection. A person must reopen it through the ordinary objective command before supervision can resume.

The command does not implement a second permissions policy. It calls the existing task, objective and attempt operations with the fixed supervisor caller; their current [authority checks](objectives.md#callers-and-permissions), acceptance evidence, budget and safety refusals still apply. Read-only inspection needs no mutation permission, but remains scoped to the objective. Task-list results are filtered to that objective. Changing a task outside the objective is refused by the existing operation checks, and their refusal reason is preserved. Finishing can accept, integrate and record a task as done, but it never confirms that processes have stopped or returns a lease. A person must inspect and confirm lease return separately.

Each invocation prints exactly one JSON object to standard output, including usage, configuration and operation refusals. Successful task and objective operations use the ordinary `--json` wrapper (`ok`, `action` and `task`, `tasks` or `objective`); attempt operations return their existing structured result unchanged. Task-store refusals use `ok: false`, `reason` and `detail`. Usage and configuration errors also have `ok: false`, `reason` and `detail`, with `usage` for command-validation errors. Exit codes follow the ordinary commands: 0 for an operation whose result is successful, 1 for an operation refusal or attention outcome (including a held dispatch or a replay of one), and 2 for usage or configuration errors. Recording an answer succeeds even if delivery fails, as on ordinary `answer`.

This is an application boundary, not a sandbox. A supervisor host must restrict the agent to this interface. An agent with an unrestricted shell, database access or the ordinary commands can bypass it and is not a restricted supervisor. See [the Phase 3 supervisor design](phases/03-supervisor/PRD.md#the-supervisor).
