# beads_rust capability probe

Isolated investigation of `br` 0.7.6 for Switchboard. See [the assessment](../../docs/phases/01-basic-dispatch/beads-rust-assessment.md). This is not a provider selection or a complete Phase 1 acceptance suite.

The probe uses Bun 1.3.11 and the macOS arm64 release executable. It creates fresh fixture workspaces beneath the ignored `.investigation/br-comparison/` directory. It does not run Git, dispatch workers, change real tasks or clean up fixtures.

## Executable

Use the [v0.7.6 release](https://github.com/Dicklesworthstone/beads_rust/releases/tag/v0.7.6), not a global installation. The investigated asset was `br-0.7.6-darwin_arm64.tar.gz`, with SHA-256:

```text
d01a4ef66aa5cd40152fc6481b78def7b6dfefd56da1b26dd1c84b38603de6f6
```

The downloaded archive was checked against the GitHub release API digest before extracting the executable into `.investigation/br-comparison/br`. The source tag resolves to `ad4212f562ca59864946b8620c1361f0933ee4a8`.

Review the project's nonstandard licence rider before adopting or redistributing the tool. The probe does not resolve that licensing question.

## Run

From the Switchboard directory, using PowerShell:

```powershell
bun investigations/beads-rust/probe.ts
```

To use an explicitly selected executable elsewhere:

```powershell
$env:SWITCHBOARD_BR_BINARY = '/absolute/path/to/br'
bun investigations/beads-rust/probe.ts
```

No package installation is needed for this script. It requires the selected executable. The captured capabilities must identify version 0.7.6; another version requires reassessment.

## Checks and output

The probe exercises real CLI commands with JSON output, an explicit database and tracker directory, isolated home/configuration directories, and automatic JSONL import/export disabled. It checks:

- Empty ready output and dependency-aware ready selection.
- Refusal to claim a blocked task.
- In-flight task exclusion from ready work.
- Indefinite hold, retained work references and untouched instructions/acceptance criteria.
- Refusal of a stale `--if-unchanged` update.
- The authoritative database can be read from another working directory.
- Completing a dependency does not release an indefinite hold.
- Completing a child does not automatically close its deferred parent in the tested default configuration.
- Accepted completion and transition-comment evidence can be read back.
- Prefix routing can redirect a write to another fixture workspace despite an explicit primary `--db`. This is an intentional provider feature that our adapter must restrict, not a passing isolation guarantee.
- The binary's capabilities, issue schema and actual engine version.

The last result is saved to `.investigation/br-comparison/results.json`. Every fixture retains its own `commands.jsonl` with exact arguments, working directory, selected tracker, exit status, stdout and stderr. Structured errors appear on stdout; nonzero exit status is still failure.

The licence, storage durability under crashes, complete uncertain-outcome handling, migration behaviour and full concurrent access safety are not established by these smoke checks.
