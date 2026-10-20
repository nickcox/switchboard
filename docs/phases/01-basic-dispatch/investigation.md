# Phase 1 integration investigation

Status: historical. This is the initial capability investigation, completed on 17 October 2026 before dispatch was implemented, and its versions (for example Treehouse 3.1.3) are the ones tested then. For the current implementation and its evidence, see the [runtime notes](runtime-integration.md) and the [verification record](verification.md); CI installs the Treehouse version pinned in `.github/workflows/test.yml`. This report separates executable observations from source inspection and proposed adapter behaviour.

Implementation update: [ADR-0005](../../adr/0005-pi-rpc-worker-and-result-file.md) selects built-in Pi RPC and a result file instead of the custom result-tool proposal below. Real Pi dispatches have since passed (see the [runtime notes](runtime-integration.md#real-pi-run)); whole-worker termination remains unverified. The PRD has since deferred the dispatcher lock in favour of exclusive attempt creation, so the locking finding below no longer blocks Phase 1. The original provider-probe results in this report are unchanged.

## Conclusion

The selected tasks-axi and Treehouse versions support the tested Phase 1 operations without a Switchboard database or manual task-file mutation. Their adapters need explicit mappings, especially for held work and evidence retention.

Pi provides suitable structured protocol and session-storage primitives, but it does not supply the complete Switchboard worker-runtime contract unchanged. Identity binding, structured worker results, discovery and observed termination need runtime-adapter code and tests.

Bun remains a plausible application runtime, but production locking is not settled. A direct macOS `flock` proof passes through Bun FFI. A tested Node-API locking package crashes Bun when its lock method runs. Do not treat a successful import or the FFI proof as approval of a production binding.

Proceed with adapter implementation after choosing the locking approach and specifying the runtime metadata/result contract. Do not enable dispatch until those contracts and the real end-to-end run pass.

## Selected versions and provenance

| Component | Investigated version | Evidence |
| --- | --- | --- |
| Host | macOS 27.0.1, build 26A434, arm64; Darwin 27.0.0 | `sw_vers`, process architecture and kernel release |
| Bun | 1.3.11, revision `af24e281ebacd6ac77c0f14b4206599cf4ae1c9f` | Executed probes and runtime version |
| Node.js | 26.7.0 | tasks-axi execution, process probes and native-addon control |
| Git | 2.54.0, Apple Git-157 | Disposable repository/worktree probes |
| tasks-axi | npm 0.2.6; source tag `tasks-axi-v0.2.6`, commit `9401ff899c0d1d8ae6b4fd8727b9025abda2032c` | Published package execution and matching tagged source |
| Treehouse | Installed 3.1.3; source tag `v3.1.3`, commit `20464a779bc30932d1dd4875886d916f4d4c28b3` | CLI execution; binary build metadata reports this revision and `vcs.modified=false` |
| Pi | Installed CLI and pinned npm SDK 1.2.0 | CLI version, versioned documentation/source, SDK storage probes |
| Native locking candidate | `fs-native-extensions` 1.5.1 | Imports under Bun; actual lock call crashes. Node control succeeds |

The Treehouse binary SHA-256 was `aec56f662fc6a606432dd5aeb32c0e218156d2faf5a473d25db83efc68092de5`. JavaScript package integrity and transitive versions are retained in the [probe lockfile](../../../investigations/phase1/bun.lock). Newer releases and other operating systems were not tested.

## Capability matrix

**Proved** means a fixture executed against the selected package or executable. **Source** means documentation or implementation inspection only. **Required** means Switchboard adapter work remains.

| Contract | Finding | Evidence / remaining work |
| --- | --- | --- |
| Authoritative task-store addressing | Proved | Absolute `--file` plus explicit `--backend markdown` override another cwd, conflicting environment, project config and home config without changing a workspace copy |
| Ready ordering and task/context reads | Proved | Read commands emit decodable TOON. Ready follows backlog order, not numeric priority; blocked and held tasks are excluded |
| In-flight/done transitions and uncertain-update readback | Proved | `start`, `done --no-prune` and full `show`; a successful mutation with its acknowledgement discarded remains inspectable |
| Hold with reasons, references and dependent safety | Proved with mapping | Hold metadata alone leaves the task in flight. Hold, body update and reopen produce queued held work without making it ready or unblocking dependants |
| Readiness-conditional start | Not supplied by this CLI | A blocked task can be started directly. Switchboard must recheck readiness and use the PRD's exclusive-status-writer operating mode |
| Exact lease holder, base and attempt branch | Proved | Explicit acquisition returns task holder, allocation ID and path; Git verifies branch and starting commit; missing base is refused |
| Lease inspection after lost acquisition response | Proved primitives | `status --json` enumerates IDs, holders and paths independently of the acquisition response. Full acknowledgement-loss fault injection remains Required |
| Allocation-conditional return | Proved; Source for atomicity | Wrong ID/holder is refused; an old ID cannot return a replacement allocation. Source rechecks conditions under the state lock before reset |
| Exact committed work retention | Proved for tested configuration | Output ref retains the exact commit after return and reuse; slot HEAD is reset to base. An existing base ref that lacks the result commit fails the ancestry check |
| Dirty and ignored-file safety | Proved limitations | Non-interactive dirty return refuses without force. Clean Git status does not stop return from deleting modified seeded ignored files |
| Pi SDK storage compatibility with Bun | Proved, limited scope | Public `SessionManager` creation, custom entries, user-message persistence and fresh-process listing/opening work |
| Pi structured worker result and identity | Source primitives; Required | Custom entries/tools and RPC events exist. No actual result tool, validation, stale-session rejection or worker-produced result was exercised |
| Runtime liveness, discovery and termination | Required | Session files are not liveness evidence. Binding and result storage work, but runtime-owned process observations and crash behaviour still need implementation |
| Bun cwd, metadata and process stop | Proved on fixtures | Bun launches Bun and Node children in the exact cwd; signal delivery precedes exit; an ignored SIGTERM requires escalation and observed termination |
| Crash-released dispatcher lock | Proved via FFI; production binding Required | `flock` excludes contenders and releases after graceful exit or SIGKILL, including with a live child. The tested native addon is incompatible with Bun 1.3.11 |

## tasks-axi adapter mapping

Pass an absolute, canonical authoritative backlog path and explicit backend on **every** operation. Flags belong after the command. Use a controlled working directory and environment; do not rely on configuration discovery to select the store. Resolve the configured repository's tasks-axi `repo` label explicitly rather than inferring it from the task title.

| Switchboard operation | Supported CLI mapping |
| --- | --- |
| List ready | `ready --repo <label> --backend markdown --file <absolute-path>` |
| List in-flight | `list --state in_flight --repo <label>` with the same store flags |
| Read complete instructions/context | `show <id> --full` with the same store flags |
| Mark in flight | `start <id> --json` with the same store flags |
| Record accepted completion | `done <id> --note <summary-and-outcome> --no-prune --json` with the same store flags |
| Apply a hold | `hold <id> --reason <bounded-reason> --json`, supported body update, then `reopen <id> --json`, all against the same store |
| Inspect an uncertain mutation | Full `show` and relevant list/readiness query against the same store; compare the complete expected outcome, not just state |

Read commands do **not** support `--json` in 0.2.6. Use the pinned TOON decoder and validate its decoded values inside the adapter. Never scrape table text or independently reproduce readiness calculation. Selection should preserve ready ordering; the fixture confirms backlog position rather than priority sorting.

The actual lifecycle states are `queued`, `in_flight` and `done`. Held is a derived property, not a fourth state. To finalise an attempt as historical hold rather than leave it in flight:

1. After confirmed worker termination, apply an indefinite structured hold and read it back.
2. Record the attempt identity, full reason, next action, evidence and work references using a supported body update. Preserve the existing instructions and acceptance criteria in the curated replacement body.
3. Reopen to queued and confirm both queued state and active hold. Do not reopen before the hold is confirmed. Queued held work is not ready.

This mapping does not reset failed work to ready. It preserves the PRD's failure policy. The three writes are not atomic; a partial or uncertain finalisation preserves the lease and stops. Subsequent dispatch must refuse the unresolved lease or in-flight state, not complete the remaining writes automatically.

`hold --reason` forbids parentheses and newlines, so use a bounded adapter-generated reason and retain the exact detailed reason in the body. The typed `--report` field is also narrower than arbitrary artefact paths; the tested `update --report /retained/results/result.json` is rejected. Generic branch names, commit IDs, absolute artefact locations and structured evidence can be retained in the body rather than misrepresented as PR/report links.

Use `--no-prune` for `done`: automatic pruning would otherwise complicate inspection after an uncertain update and can write a configured archive. Read back the authoritative task even when a mutation reports `ok: true`. No general worker-task compare-and-set option was found; tasks-axi's per-mutation file locking is not a readiness-conditional transition or protection from an external status writer between commands.

## Treehouse adapter mapping and retention

Run acquisition/status from the configured main repository with an explicit pool root. A dedicated Switchboard pool root for the task-store/repository context avoids confusing identical task IDs from different stores while keeping `lease_holder` equal to the unchanged task ID.

- Acquire: `get --lease --json --lease-holder <task-id> --base <base> --branch <unique-attempt-branch>`. The fixtures use `--no-fetch` for deterministic, network-free Git operations; the implementation must explicitly decide its fetch policy.
- Inspect: `status --json`, validate the returned array and filter by holder/allocation ID. Do not read or rewrite Treehouse's private state file.
- Return: `return <exact-path> --if-lease-id <observed-id> --if-lease-holder <task-id>`, with closed/non-interactive stdin and no `--force` or `--all`.

Acquisition JSON contains the lease ID, holder, path and allocation metadata; verify the Git branch and starting commit separately rather than assuming they are returned fields. The explicit base selects Treehouse's base-branch resolution behaviour, not necessarily a previously sampled local commit. Record and validate the actual acquired commit as required by the delivery contract.

The fixture committed a result on the named output branch, returned the lease, reused the same slot for a new allocation, and verified the original output ref still resolved to the exact result commit. This is evidence for the tested Git path without hooks, not a guarantee covering arbitrary hooks, another backend or external branch deletion.

Return resets the workspace and removes inventoried seeds. A modified ignored seed disappeared even though `git status --porcelain` was empty. Required reports and evidence must therefore be checked independently and retained outside the workspace. Preserve the lease if dirty files, unretained commits or sole-copy artefacts remain. Verify the output ref contains the recorded commit; branch existence is insufficient.

Treehouse 3.1.3 allows several leases with the same holder and refuses an output branch that already exists (found while building the adapter on 18 October 2026). The holder is therefore not an exclusive claim on a task: Switchboard must check for an existing lease before acquiring, and relies on the attempt log to stop two invocations acquiring for the same task.

Treehouse 3.1.3 names a repository's pool directory after the first six hexadecimal digits of the SHA-256 of its origin remote's URL, or of its path when it has no origin (`ResolvePoolDir` in `internal/config/config.go`; found on 19 October 2026 after adding a GitHub remote to this repository). Adding or changing the origin therefore moves the repository to a new, empty pool, and `status` stops listing leases in the old one. `return <path>` still finds the old pool from the workspace path. The adapter records each lease's pool so Switchboard reports such leases as unknown rather than absent (see the [PRD](PRD.md#workspace-pool-changes)).

Wrong lease identities were refused without touching the replacement allocation. Source inspection confirms the conditions are rechecked while holding the pool state lock before destructive effects. Treehouse process listings remain non-authoritative for Pi liveness, even when empty.

## Pi runtime boundary

The investigation imported the pinned SDK into Bun and exercised only its public storage APIs. It did **not** create an agent, call a model, launch a Pi worker or generate a real completion result.

### Verified storage behaviour

- `SessionManager.create(workspace, explicitSessionDirectory, { id })` supports an explicit session identity and storage outside the workspace.
- `appendCustomEntry` can retain a versioned task/lease/session/context binding and structured result.
- Metadata alone does not create a session file in 1.2.0. A user or assistant conversation message is required to flush the initial entries. A custom binding written during startup is therefore not, by itself, durable launch identification.
- After appending a synthetic user message, a fresh process can discover the session with `listAll(explicitSessionDirectory)`, open it and recover the custom binding without the original in-memory identifiers.
- A synthetic structured result remains readable after the fixture workspace is removed. This proves storage retention, not a real worker result or its validity.
- These probes establish ordinary file persistence and fresh-process readback, not fsync or host power-loss durability guarantees.

### Source findings and required implementation

Pi's RPC protocol offers `get_state`, prompt responses/events, abort and orderly shutdown by closing stdin. Prompt acceptance, `agent_settled`, SDK `abort()` and an idle session do not establish process termination. JSON event output is not automatically a schema-constrained task result.

In the selected `RpcClient` implementation, `stop()` sends SIGTERM and waits, but its timeout path sends SIGKILL and resolves without waiting for the subsequent process exit event. Do not use resolution of this method as the required termination confirmation. Retain an independently observed child-exit handle, or implement the subprocess transport with explicit ownership of that observation.

The runtime adapter still needs:

1. A versioned binding containing canonical context, task ID, lease ID and session ID, plus a defined storage/discovery path outside the leased workspace. Unflushed metadata or an ambiguous match is unknown, not absent.
2. A schema-validated result channel rather than interpretation of terminal output. ADR-0005 now selects a result file written with Pi's standard tool, not a custom result extension. Retain the result outside the workspace and check it against the current binding.
3. Running/stopped/unknown observations, stop deadlines and confirmed termination. Account for worker tool subprocesses; the fixture proves that a child may survive its launching process.
4. A retained runtime-owned termination observation for normally finalised sessions, recorded only after exit is actually observed. A dispatcher crash before such confirmation remains unresolved and requires operator inspection, not inferred termination or automatic repair.
5. An uncertain-launch inspection path that adopts at most one unambiguously bound session and never launches a replacement merely because an acknowledgement or session file is missing.

These records belong to the worker-runtime boundary. They are not permission to add a Switchboard task database, retry queue or persisted dispatcher lifecycle. Their exact schema, authority, durability and discovery rules must be documented with the adapter, then verified with a real Pi run and dispatcher-crash tests.

## Bun/macOS locking finding

The passing lock proof uses `flock(LOCK_EX | LOCK_NB)` on a descriptor opened with Darwin `O_CLOEXEC`. It verifies exclusion, graceful release, SIGKILL release and release while a spawned child remains alive. Never unlink an active lockfile: a new file at the same path would be a different lock object. Derive the eventual lock location from canonical store/repository context, not the caller's cwd.

`fs-native-extensions@1.5.1` is not a working alternative in this configuration. Its module imports, but calling `tryLock` crashes Bun 1.3.11 with `unsupported uv function: uv_get_osfhandle`. A separate Node.js control using the identical fixture succeeds. The [opt-in reproduction](../../../investigations/phase1/native-addon-repro.ts) records both outcomes.

Bun documents FFI as experimental. The passing FFI probe establishes syscall feasibility, not production readiness. Before enabling dispatch, choose and test a compatible binding, a carefully specified native helper, or a different Bun version. Node.js remains the fallback described by ADR-0004 if a reliable Bun integration cannot be established. Do not silently substitute PID-only lockfiles or change the selected application runtime without recording the decision.

## Remaining implementation gates

1. Choose the production lock implementation and verify it with the exclusion/crash/inheritance tests.
2. Complete the worker-runtime binding, result-file and termination-observation contracts. The foundation is described in the runtime implementation notes; process ownership and real-runtime verification remain required.
3. Define configuration precedence, canonical context/pool/lock identity, repository labels and explicit delivery-contract overrides. Do not infer final-deliverable exceptions from task prose.
4. Implement the task-store/workspace/runtime adapters with these mappings, schema validation and readback. Keep policy independent of provider transport types.
5. Run one real Pi dispatch through all three owners, including an independently accepted deliverable and the normal review-required hold path.
6. Execute the PRD's complete fault-injection, interruption and dispatcher-crash suite. The existing acknowledgement-discard and storage fixtures are not substitutes for that suite.
7. Document exact operator inspection and recovery commands for the implemented runtime alongside the verified mappings. Preserve the PRD's refusal policy for unresolved state.

## Reproduction and evidence

See [the probe README](../../../investigations/phase1/README.md) for PowerShell commands, prerequisites and isolation. The recorded normal suite passed **20 tests with 89 assertions**; separate strict type checking passed. The opt-in native-addon reproduction confirmed the incompatibility, rather than testing it as a supported locking path. [results.json](../../../investigations/phase1/results.json) retains the compact result and versions.

All task mutations, Git commits, leases, seeded files and terminated processes belonged to fixtures beneath this repository's ignored `.investigation/` directory. Existing task stores and workspace leases were not changed. Raw commands and observations remain in the printed run directories for local inspection; source clones and dependency installations are also local investigation material.

### Source references

- tasks-axi 0.2.6: [configuration](https://github.com/kunchenguid/tasks-axi/blob/9401ff899c0d1d8ae6b4fd8727b9025abda2032c/src/config.ts), [state commands](https://github.com/kunchenguid/tasks-axi/blob/9401ff899c0d1d8ae6b4fd8727b9025abda2032c/src/commands/state.ts), [read commands](https://github.com/kunchenguid/tasks-axi/blob/9401ff899c0d1d8ae6b4fd8727b9025abda2032c/src/commands/crud.ts), [readiness](https://github.com/kunchenguid/tasks-axi/blob/9401ff899c0d1d8ae6b4fd8727b9025abda2032c/src/derive.ts).
- Treehouse 3.1.3: [conditional return](https://github.com/kunchenguid/treehouse/blob/20464a779bc30932d1dd4875886d916f4d4c28b3/cmd/return_cmd.go), [pool release](https://github.com/kunchenguid/treehouse/blob/20464a779bc30932d1dd4875886d916f4d4c28b3/internal/pool/pool.go), [Git reset/detachment](https://github.com/kunchenguid/treehouse/blob/20464a779bc30932d1dd4875886d916f4d4c28b3/internal/vcs/gitvcs/gitvcs.go).
- Versioned Pi 1.2.0 package: [session persistence implementation](https://unpkg.com/@earendil-works/pi-coding-agent@1.2.0/dist/core/session-manager.js), [RPC client implementation](https://unpkg.com/@earendil-works/pi-coding-agent@1.2.0/dist/modes/rpc/rpc-client.js), [RPC documentation](https://unpkg.com/@earendil-works/pi-coding-agent@1.2.0/docs/rpc.md), [extension contracts](https://unpkg.com/@earendil-works/pi-coding-agent@1.2.0/docs/extensions.md).
- Native locking candidate 1.5.1: [JavaScript wrapper](https://unpkg.com/fs-native-extensions@1.5.1/index.js), [macOS syscall implementation](https://unpkg.com/fs-native-extensions@1.5.1/src/apple.c). Bun's [FFI documentation](https://bun.sh/docs/runtime/ffi) describes its experimental status; the [libuv compatibility issue](https://github.com/oven-sh/bun/issues/18546) is identified by the observed crash diagnostic. These Bun web pages are not version-pinned evidence; the local probes establish the tested behaviour.
