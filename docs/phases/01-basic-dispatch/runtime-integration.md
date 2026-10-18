# Initial Pi runtime integration

Status: the runtime adapter used by `switchboard dispatch --once`. Tested offline with a synthetic worker and in real runs against disposable repositories (see [Real Pi run](#real-pi-run)). Whole-worker termination remains unverified, so dispatch never returns leases.

Decision: [ADR-0005](../../adr/0005-pi-rpc-worker-and-result-file.md). The selected baseline is Pi coding-agent 1.2.0, with Switchboard on Node.js 26.7.0. Pi Durable 1.3.0 is a comparison target, not an installed application dependency.

## Implemented boundary

`src/runtime/pi/worker.ts` runs one assigned instruction snapshot through a separately launched Pi RPC subprocess. The caller supplies an absolute executable, optional Node entrypoint, explicit provider and exact model ID, controlled environment, shell-tool selection, exact workspace, identity and delivery contract. No arbitrary caller-supplied Pi flags are appended. The intended real invocation uses Node.js plus the pinned Pi CLI entrypoint; tests use Node.js plus a synthetic peer written in TypeScript.

The adapter:

1. Reserves one runtime directory for the context/lease and writes the expected binding before spawning.
2. Supplies the exact session ID and a session directory outside the leased workspace.
3. Disables discovered extensions, MCP, skills, prompt templates, themes and context files (`AGENTS.md`, `CLAUDE.md`). Project resource approval is disabled; this is configuration control, not a sandbox.
4. Requests structured state and checks session identity, session-file location and the exact selected provider/model. Idle startup does not establish task completion.
5. Disables Pi's automatic model retry setting for this initial integration and sends exactly one prompt, with event observation already installed. Operator messages and stop requests are separate and forwarded once each ([ADR-0005](../../adr/0005-pi-rpc-worker-and-result-file.md)).
6. Requires prompt disposition `started`, a current agent run, a non-aborted settlement, a successful terminal assistant response and an empty idle queue afterwards.
7. Closes RPC stdin, observes direct-child exit and stream closure, then validates the worker result file. A zero process exit alone is insufficient.
8. On interruption/failure, requests queue clearing and abort when the channel permits, closes stdin, and escalates direct-child termination within a bounded stop budget. Sending a signal is never treated as an observed exit.

Request timeouts never cause another prompt or replacement launch. Responses are correlated by request ID and command. Late acknowledgements are ignored rather than retried. Protocol framing splits only on LF, accepts CRLF, preserves split UTF-8 and Unicode line separators, and bounds each record.

Task-store and workspace operations, the attempt log, dispatch policy and retention checks are implemented outside this module, in `src/tasks/`, `src/workspaces/`, `src/attempts/` and `src/dispatch/`.

## Result contract

`src/runtime/contracts.ts` defines a strict, versioned result schema:

- Exact context, task, lease and session identity.
- `completed`, `hold` or `failed` worker outcome and a nonempty summary.
- Named validation-evidence entries with worker-reported summaries.
- Named Git references with branch and full commit ID, or artefact references with path and description.
- Required reason and next action for hold/failure.

Completed results must contain required evidence/deliverable names and, for code, the configured output branch plus a syntactically valid full commit ID. These are mechanical checks. They do not establish that a commit exists, the branch retains it, an artefact survives return or acceptance criteria passed independently. Git and artefact retention checks belong to finalisation.

The result JSON Schema is generated from the host's Zod schema and supplied in the prompt. The same resolved delivery contract is included in worker instructions and validation. A `completed` report does not override `review_or_integration`; no task-state transition is made by this module.

The worker writes `result.json` with the standard write tool, without a custom extension. JSON input is read from a bounded regular file, not through executable content; symlinked results are refused. Missing, partial, oversized, identity-mismatched or schema-invalid files are failures. Instruction snapshots and provider identities are validated without trimming their text.

`PiRunReport.status = reported` means a valid worker report was obtained after direct-child exit, not that the task is accepted or its workspace may be returned. A valid `failed` or `hold` worker result is still a reported outcome. Callers must inspect the result and remaining runtime obligations separately.

## Runtime-owned records

`src/runtime/records.ts` uses a caller-configured absolute runtime root. Context and lease IDs are hashed into directory names; the original identities remain in validated records. Paths are resolved before launch and runtime evidence beneath the worker workspace is refused. Symlinked context directories are refused.

| Path | Owner and purpose |
| --- | --- |
| `<root>/<context-hash>/<lease-hash>/binding.json` | Runtime-owned, write-once expected identity, instruction snapshot, resolved delivery contract, exact working directory and session/result locations |
| `sessions/` | Pi-owned native session files selected with explicit `--session-dir` |
| `activity.jsonl` | Diagnostic record of the worker's tool calls, assistant messages, queue changes and usage snapshots, with size limits. Read by `watch` and `status`; never used to decide task, lease or liveness state |
| `artefacts/` | Where the worker writes reports and other non-code deliverables, so they survive workspace recycling. The worker prompt gives its path |
| `result.json` | Worker-reported outcome through the agreed runtime contract |
| `operator-stopped.json` | Write-once operator confirmation, made with `switchboard resolve`, that a worker with no observed exit has stopped. Discovery reports it as `operator_confirmed_stopped`, never as an observed exit, and an observed exit takes precedence |
| `child-exit.json` | Runtime-owned, write-once observation of direct-child exit or a definite no-child launch failure; not proof that all worker descendants stopped |

Exclusive directory creation refuses reuse of a lease even with a different session ID or after child exit. This is an attempt-identity guard. Preventing a task from being dispatched twice is the job of exclusive attempt creation in the attempt log.

Discovery starts from the configured root/context, not saved in-memory session IDs. A binding without an exit receipt returns child liveness as unknown. Invalid, incomplete, identity-conflicting or uninspectable records cause refusal rather than an empty inventory. Discovery does not kill or adopt processes by PID, resume a session or reset task state.

The records are input snapshots and process observations, and are each attempt's launch and child-exit entries in the attempt log ([ADR-0006](../../adr/0006-switchboard-attempt-log.md)); this module does not yet write the later entries. No selected/leased/running/finalising workflow stages, retry state or queue are persisted. Write-once files are written to a temporary file, flushed, and then hard-linked to their final name, so a reader sees either no file or the complete file, and an existing file is never replaced. They are flushed before their write completes, but host power-loss durability and directory-entry persistence have not been qualified. Loss of runtime evidence does not clear an unresolved authoritative task or lease.

These files are not protected from a malicious worker running as the same OS user. Their directory placement prevents workspace recycling, not arbitrary filesystem access. A stronger adversarial isolation model requires a separate design.

## Unresolved process-ownership gate

This gate applies to automatic workspace return, which is deferred beyond Phase 1. Phase 1 finalises on direct-child exit and preserves every lease (see the [PRD](PRD.md#objective-and-scope)).

The current return value deliberately contains `workerTermination: unverified` on every path. No caller may treat a `child-exit.json`, an idle RPC observation or a valid result file as authority to return a workspace.

Source inspection of Pi 1.2.0 found that its built-in shell operations launch detached subprocess groups on Unix, track active shell PIDs, and remove tracking after the shell exits. Thus placing only the Pi CLI in a process group and observing that group is not sufficient to establish that all tool-started work has stopped. A background process can outlive its shell and the Pi process.

Before automatic workspace return is enabled:

- Choose and prove native worker process ownership/containment on the supported macOS host, including detached tool descendants and dispatcher death.
- Define and test the equivalent mechanisms before Linux/Windows support is enabled. Do not expose Unix-specific assumptions through dispatch policy.
- Record confirmed whole-worker termination separately from direct-child exit only after that contract is established.
- Prove that missing/unknown termination preserves the lease and blocks another dispatch.

This gate is not bypassed by asking the worker not to create background processes. The instructions ask for that behaviour, but instructions are not termination evidence.

## Pi Durable comparison: first implementation milestone

| Responsibility | Initial RPC foundation | Pi Durable 1.3.0 |
| --- | --- | --- |
| External Pi CLI process | Owned directly by this adapter | Requires a separate application host if process isolation is wanted; not an existing Pi CLI supervisor |
| Expected attempt identity/discovery | Small write-once input binding, with conservative unknown after lost observation | Committed conversations/tasks and inspection, with application-defined correlation to task/lease/context |
| Retained model state | Pi's native sessions | Harness-owned storage and committed task/conversation state |
| Result contract | Standard write tool, strict host-side schema | Structured tool results/documents are available, but task acceptance and the product-specific result still need a contract |
| Duplicate dispatch | One exclusive lease allocation; no retry/resume | Request IDs deduplicate admitted inputs, not external task/lease mutations across owners |
| Cancellation | Built-in RPC abort plus actual child-exit observation | Harness abort follows owned tasks/conversations; does not by itself prove a separate host process has exited |
| Descendant termination | Deliberately unresolved | `NodeExecutionEnv` starts each command in its own process group and kills tracked groups on `cleanup()`, but stops tracking a command when it finishes, so background processes a finished command left running are not killed (confirmed in the 1.3.0 build). Same gap as Pi's shell tool |
| Recovery | Refuse unresolved state; no automatic repair | Scheduler/replay machinery exists; submit and wait operations can start it, so adoption needs an explicit recovery policy |

**Assessment:** current input/exit records support required runtime facts without introducing a durable execution engine. There is no queue, replay journal, scheduler or automatic restart to justify Pi Durable in Phase 1 yet. However, subprocess ownership is a meaningful upcoming comparison point; built-in cleanup must be tested before writing a larger custom process supervisor.

**Required review checkpoints:** add a short comparison entry when process ownership is selected, when the first real Pi run passes, and before implementing reconciliation. Stop and propose Pi Durable instead of adding custom durable retries, restart/resume, queues, schedules or a persistent worker service. Bringing Durable forward would be an explicit revision to ADR-0003, not an unrecorded dependency change. The entry for the first real Pi runs is in ADR-0005.

Pi Durable and Pi coding-agent are distinct runtimes. Neither runtime's internal completion is automatically tasks-axi done or permission to recycle a Treehouse workspace.

## Real Pi run

On 18 October 2026, `PiWorker` ran the installed Pi CLI 1.2.0 under Node.js 26.7.0 on macOS, with provider `openai-codex` and model `gpt-6.1-sol`. The task was to create and commit one file in a disposable Git repository, with no tasks-axi store or Treehouse lease involved. The worker returned `status: reported` with a schema-valid `completed` result in about 15 seconds. The reported commit matched the output branch head, the file content was correct and the working tree was clean. `binding.json`, `child-exit.json`, `result.json` and the session file were written in the expected runtime locations.

This confirmed against real Pi that the CLI flags, the `get_state`, `set_auto_retry` and `prompt` commands, the `agent_settled` event, the `started` prompt disposition, and writing `result.json` outside the workspace with the standard write tool all behave as the adapter expects. `PI_OFFLINE=1` only disables network operations at startup; model calls still work.

The first run found that Pi loaded the operator's global `~/.pi/agent/AGENTS.md` into the worker's system prompt, because none of the other disable flags cover context files. The adapter now passes `--no-context-files`, and a second run confirmed that no context file was loaded.

Later runs went through `switchboard dispatch --once` with tasks-axi and Treehouse, using [`investigations/real-dispatch/`](../../../investigations/real-dispatch/README.md): a code task held for review with its commit retained on the output branch, and a `scout` task whose report was retained in the attempt's `artefacts/` directory and recorded as done. Interruption, model errors and process ownership have not been exercised with a real worker.

## Tests and limitations

Run `npm run check` and `npm test` from the repository root. The root suite uses a synthetic RPC peer, not Pi, credentials or a model provider. Tests cover framing, response identity, startup idleness, prompt acknowledgement loss, unexpected session/response state, model errors, result-file faults, observed child exit, interruption, stale results and restart discovery from runtime files.

The root suite passes on the macOS host under Node.js 26.7.0. It was first verified under Bun 1.3.11 before the change of runtime in ADR-0004. The separate Phase 1 investigation, which still runs under Bun, also passed type checking and all 20 tests with 89 assertions when rerun. Those probes use disposable task and Treehouse fixtures, not existing work or model agents.

The existing investigations remain separate; the root test script does not run their real provider probes or the opt-in Bun native-addon crash reproduction. Linux and Windows native integration has not been verified. No workspace is returned and no authoritative task store is mutated by the runtime tests.

Source references: [Pi 1.2.0 RPC](https://unpkg.com/@earendil-works/pi-coding-agent@1.2.0/docs/rpc.md), [CLI options](https://unpkg.com/@earendil-works/pi-coding-agent@1.2.0/docs/cli.md), [shell implementation](https://unpkg.com/@earendil-works/pi-coding-agent@1.2.0/dist/core/tools/bash.js), [Pi Durable 1.3.0 README](https://unpkg.com/@earendil-works/pi-durable@1.3.0/README.md), and [Durable execution environment](https://unpkg.com/@earendil-works/pi-durable@1.3.0/dist/env/node.js).
