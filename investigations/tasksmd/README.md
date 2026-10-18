# tasks.md git-native capability probe

Isolated investigation of the tasks.md CLI's git-native backend for Switchboard. See [the assessment](../../docs/phases/01-basic-dispatch/tasksmd-assessment.md). This is not a provider selection or a complete Phase 1 acceptance suite.

The probe uses Bun 1.3.11 to drive `@tasks-md/cli` 0.10.2 under Node.js, and Git, on macOS. It creates fresh fixtures beneath the ignored `.investigation/tasksmd-comparison/` directory. It does not dispatch workers, change real tasks or clean up fixtures.

## Package

The probe installs the published npm package, not the GitHub `main` branch. The GitHub repository's `packages/cli/package.json` says 0.11.0, but npm's latest release is 0.10.2 and some git-native behaviour differs between them (see the assessment).

```text
@tasks-md/cli 0.10.2
integrity sha512-U4lFM2l2VeA15CtHzQqvTCTEHKK8nY2T6LA7hIFioCsaguA7svATJWdEZ8wCDwn+dB5pL6aMxXxsBMVapKlyGQ==
tarball SHA-256 7cf38a201417280e09c068ef8260baac6fc0fee9a3c5ff88f23da2063a880619
```

## Run

From the Switchboard directory, using PowerShell:

```powershell
Push-Location investigations/tasksmd
bun install --frozen-lockfile --ignore-scripts
Pop-Location
bun investigations/tasksmd/probe.ts
```

`node` and `git` must be on `PATH`. Set `SWITCHBOARD_NODE` to use a specific Node executable.

## Fixture

Each run creates:

- `origin.git`: a bare repository standing in for the shared remote.
- `store`: the clone Switchboard would use as the authoritative store, containing `.tasksmd.json` with `"backend": "git-native"`.
- `other`: a second clone acting as a competing writer with a different actor name.
- `worktree`: a `git worktree` of `store`, standing in for a Treehouse workspace.
- `shim/git`: a wrapper used to make one `git push` reach the remote but report failure.

`HOME`, `XDG_CONFIG_HOME` and `TMPDIR` are isolated per fixture, and system Git configuration is ignored.

## Checks and output

- Blocked-task claim refusal and dependency-aware `pick`.
- Two clones claiming the same task at the same time.
- Live-claim refusal for another actor, stale fencing-token refusal, and completion by another actor without a token.
- Hold mapping: `update --blocked` with work references, then `unclaim`, then readback.
- Listing from a directory that is not the store, with and without `--backend git-native`.
- Whether a worktree of the store shares the claims ref and can change the store.
- Which completion records remain readable, before and after `fleet compact`.
- Lost acknowledgements for `update`, `complete` and `claim`.
- Behaviour while the remote is unavailable.

The last result is saved to `.investigation/tasksmd-comparison/results.json`, and a copy without local paths is kept in [`results.json`](results.json). Every fixture keeps its own `commands.jsonl` with exact arguments, working directory, actor, exit status, stdout and stderr. tasks.md reports refusals as JSON on stdout with exit code 1; some failures are uncaught exceptions on stderr instead.

Crash safety of the local Git object store, the GitHub-hosted security controls (required checks, `pre-receive`), the projection workflow, migration and Linux or Windows behaviour are not covered.
