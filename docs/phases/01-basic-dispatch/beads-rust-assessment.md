# beads_rust assessment

Status: candidate investigation begun on 17 October 2026, with the saved probe rerun on 18 October. This does not replace tasks-axi in the architecture or change ADR-0001.

## Verdict

`br` is technically plausible as the Phase 1 task-store provider. Its tested task lifecycle is a better match for independent review holds than the tx behaviour found in our earlier comparison. The absence of a TypeScript SDK is not itself a blocker: a small JSON subprocess adapter would be reasonable.

Do not adopt it yet. The nonstandard licence needs clarification, the custom storage engine needs failure testing, and the adapter must explicitly restrict routing, synchronisation and workflow configuration. Passing the basic CLI probes does not establish crash safety or full Phase 1 acceptance.

## Investigated release

- `beads_rust` / `br` **0.7.6**, released 15 October 2026.
- Tagged source: `ad4212f562ca59864946b8620c1361f0933ee4a8`.
- Downloaded macOS arm64 release binary, executed under Bun 1.3.11 on the existing macOS host.
- Archive SHA-256: `d01a4ef66aa5cd40152fc6481b78def7b6dfefd56da1b26dd1c84b38603de6f6`, verified against the GitHub release API asset digest before extraction.
- `br info --json` reports **FrankenSQLite 0.4.10**, not stock SQLite.
- `br capabilities --json` reports `mcp: false` and `self_update: true` in the tested release binary.

## TypeScript integration

No supported TypeScript SDK, Node/Bun native binding or JavaScript package was found in the investigated source. There is a public Rust crate with modules for storage, commands, configuration and policy, but that is not a TypeScript API.

The practical interfaces are:

| Interface | Availability | Assessment |
| --- | --- | --- |
| CLI with JSON | Present in the release binary | Preferred for Switchboard: short-lived subprocesses, explicit arguments, bounded execution and validated JSON |
| JSON Schema export | `br schema` and command-envelope schemas | Useful for generating adapter types and runtime validators; not an executable SDK |
| MCP over stdio | Optional Rust `mcp` build feature | A TypeScript MCP client could use it, but the tested release binary does not include it. Requires a different build and persistent subprocess management |
| Rust library | Public Rust modules | Would require custom native bindings or another bridge from TypeScript. Not justified simply to avoid CLI calls; low-level storage access must not bypass provider policy |
| HTTP task API | Not documented as an available interface in this release | Do not assume original Beads' HTTP features exist here |

A subprocess adapter does not require a shell. Use `Bun.spawn` with an executable and argument array, not interpolated shell commands. Check the process exit status before accepting decoded data and validate the command-specific JSON shape. Machine-readable errors are emitted on stdout, so valid JSON alone is not success.

Pin the executable version and keep all provider commands and schemas inside the task-store adapter. JSON Schema export can inform TypeScript generation, but external values still need runtime validation.

## Executable findings

The [probe](../../../investigations/beads-rust/probe.ts) executed 43 CLI operations per completed run in disposable fixture workspaces. Commands used an explicit database and tracker directory, isolated home/configuration directories, and `--no-auto-import --no-auto-flush`.

| Requirement | Observed result |
| --- | --- |
| Empty ready query | JSON array `[]` |
| Dependency-aware selection | A dependent task stays out of ready work until its blocker is closed |
| Refuse blocked launch transition | `update --claim` on the blocked fixture task exits 4 and leaves it open |
| Mark in flight | `update --claim` sets `in_progress`; the task disappears from the ready query |
| Indefinite hold | `update --status deferred` with no expiry keeps task and dependent out of ready work |
| Retain instructions and evidence separately | A hold update can append outcome/work-reference JSON to notes while preserving description and acceptance criteria |
| Conditional update | `--if-unchanged <updated_at>` rejects a stale edit with `UPDATE_PRECONDITION_FAILED`, exits 6 and leaves the title unchanged |
| Explicit addressing from another cwd | With the tested controlled configuration, the same database is read from an unrelated working directory |
| Hold survives dependency completion | An indefinitely deferred task remains deferred and excluded from ready work after its blocker closes |
| Child completion and parent acceptance | Closing the only child leaves its deferred parent deferred in the tested default configuration; it does not reproduce tx's automatic parent-completion result |
| Accepted completion | `close` records `closed`, close reason and an atomic transition comment containing evidence and work references; full `show` reads them back |
| Explicit database versus routing | A configured issue-prefix route redirects `update` to another fixture workspace despite the primary absolute `--db`. This is an intentional feature that the adapter must restrict |

The `--if-unchanged` mechanism is useful protection against stale edits, but it is not a general transaction across task selection, dependencies, workspace acquisition and worker launch. Dedicated `close` and `defer` commands do not expose that same CLI flag in 0.7.6. The PRD's exclusive-status-writer operating mode and uncertain-update readback are still required.

## Proposed Phase 1 mapping

All operations must target the configured canonical tracker and database, use full task IDs, and run under the restricted configuration described below.

| Switchboard operation | Candidate mapping |
| --- | --- |
| Select ready work | `ready --json`; preserve the provider's ordering |
| Read instructions, acceptance criteria and revision | `show <id> --json` |
| Inspect in-flight tasks | `list --status in_progress --json`, accounting for its documented result envelope and paging |
| Mark in flight | `update <id> --claim --if-unchanged <observed-updated_at> --json` |
| Finalise a hold/failure | `update <id> --status deferred --append-notes <versioned-outcome> --if-unchanged <observed-updated_at> --json`, then full readback |
| Record accepted completion | `close <id> --reason <summary> --transition-comment <versioned-outcome> --json`, then full readback |
| Inspect uncertain mutation | Full `show`, checking task ID, status and expected attempt/outcome evidence rather than status alone |

The semantic mapping is `open` to ready candidates, `in_progress` to in flight, `deferred` without expiry to hold, and `closed` to accepted done. Provider readiness still determines whether an open task is eligible. Do not pass `--include-deferred` or attach a time expiry to an operator/review hold.

Issue descriptions, acceptance criteria, notes and comments are separate fields. There is not a tx-style arbitrary structured issue-metadata field in the investigated public issue interface. Versioned JSON in notes or transition comments can retain work references without rewriting instructions, but the adapter owns that schema and identity checking. Do not misuse `agent_context`, which is reserved for governing instructions.

## Adoption gates and risks

### 1. Licence clarification

The release uses **MIT with an OpenAI/Anthropic rider**, not unmodified MIT. The rider withholds rights from those companies, affiliates and broadly defined parties acting for them; restricts making the software available to restricted parties; and explicitly includes testing, analysis and automated pipelines in its definition of use.

This is not a blanket legal conclusion about every user of an OpenAI or Anthropic API. It is, however, a material adoption question for an AI-assisted project. Obtain appropriate clarification or permission rather than assuming ordinary MIT rights. The same consideration applies to relevant dependencies' licences; this investigation is not a complete licence audit.

### 2. Storage reliability qualification

The current release links FrankenSQLite, a Rust implementation, rather than the conventional SQLite C engine. The project's engine operating-model document records historical corruption incidents under concurrent writes/checkpoints, fixes and containment, opener/checkpoint locks, and detailed recovery procedures. Those historical incidents are not evidence that 0.7.6 is currently corrupting data; our smoke probes did not reproduce corruption.

They do mean that describing this as simply a familiar SQLite-backed tracker understates the storage qualification needed. Before adoption, test lost acknowledgements, dispatcher/task-command crashes, interruption, retained WAL state, backups/restoration, schema migration and the actual supported operator access pattern. Do not open its database directly from Bun SQLite to bypass the CLI: provider-side coordination and policy remain authoritative.

The ordinary engine-open path can perform certain recovery operations; explicit no-auto-import/no-auto-flush observational paths avoid the automatic repair path described by the operating-model document. Specify which read and mutation paths the adapter permits. Do not silently invoke `doctor --repair` as compensation.

### 3. One authoritative context must be enforced

`--db` is not a complete isolation boundary. Prefix routes, redirects, user/environment configuration and external-project references can influence operations. The probe demonstrated an actual redirected write, confined to a second disposable fixture.

A Phase 1 adapter needs a controlled invocation environment, explicit canonical database and tracker directory, and preflight validation of routes, redirects, inherited route discovery and relevant policy. Initially refuse cross-project routing and external dependency configurations that are not part of the supported single-context contract. Validate reported context using provider inspection commands. A readiness query against one store must never be followed by a routed mutation to another.

Default commands may import newer JSONL or export mutations automatically. The probe disabled both. The implementation must explicitly choose database/JSONL authority and backup/export policy, then document it for operators. Disabling automatic synchronisation does not remove the need for backups or justify ignoring a stale-state refusal. A mutation followed by failed export may be an applied mutation with a failed follow-up; inspect instead of blindly repeating it.

### 4. Workflow and compatibility control

Custom policy can alter ready status groups, transition gates, claims and capacity. Pin or validate the supported policy so defaults proved by the probe cannot silently change. `br` claims are task assignment/status, not Treehouse workspace leases or runtime liveness evidence.

Pin the binary and validate command-specific result schemas. Do not assume every command uses the same JSON envelope or that an exit code uniquely identifies the failure. For example, the stale-update test exits 6, which the broad capabilities table also categorises as sync/JSONL errors; inspect the structured error code.

## Recommendation

There is no fundamental TypeScript-integration blocker in the scoped, controlled mode exercised by these probes. Its indefinite hold and conditional-update semantics are attractive, and its tested parent behaviour avoids a concrete tx acceptance problem.

I would nevertheless keep it as a conditional candidate rather than replace tasks-axi now. First resolve the licence question. Then qualify storage failure behaviour and prove the single-context preflight restrictions. The lack of a TypeScript SDK is less concerning than those three issues.

No real tasks, existing leases or workers were touched. The binary and fixture stores remain under the ignored `.investigation/br-comparison/` directory. The probe is not a complete crash/durability test suite or a real Pi dispatch.

## Sources

Version-pinned source and documentation:

- [Release v0.7.6](https://github.com/Dicklesworthstone/beads_rust/releases/tag/v0.7.6).
- [Licence](https://github.com/Dicklesworthstone/beads_rust/blob/ad4212f562ca59864946b8620c1361f0933ee4a8/LICENSE).
- [Rust library surface](https://github.com/Dicklesworthstone/beads_rust/blob/ad4212f562ca59864946b8620c1361f0933ee4a8/src/lib.rs) and [Cargo features/dependencies](https://github.com/Dicklesworthstone/beads_rust/blob/ad4212f562ca59864946b8620c1361f0933ee4a8/Cargo.toml).
- [CLI contracts, routing, JSON schemas and optional MCP](https://github.com/Dicklesworthstone/beads_rust/blob/ad4212f562ca59864946b8620c1361f0933ee4a8/docs/CLI_REFERENCE.md).
- [Engine operating model and historical incidents](https://github.com/Dicklesworthstone/beads_rust/blob/ad4212f562ca59864946b8620c1361f0933ee4a8/docs/reliability/ENGINE_OPERATING_MODEL.md).
- [Conditional update implementation](https://github.com/Dicklesworthstone/beads_rust/blob/ad4212f562ca59864946b8620c1361f0933ee4a8/src/cli/commands/update.rs).

Local evidence and reproduction: [probe README](../../../investigations/beads-rust/README.md), [probe source](../../../investigations/beads-rust/probe.ts), [recorded results](../../../investigations/beads-rust/results.json), and `.investigation/br-comparison/results.json` with per-fixture `commands.jsonl` files.
