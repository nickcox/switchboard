# Real dispatch demo

Builds a fresh, disposable demo and runs one real `switchboard dispatch --once` with a real Pi worker, then checks the result by reading the repository and task store directly. Use it to repeat the first real end-to-end run, or to try Switchboard without setting up a project.

**A full run makes real model calls on your account.** The task is small (commit one file, or write one short report), but it is a real agent run with shell access inside the disposable workspace.

## What it creates

Each run makes a new directory under the ignored `.investigation/real-dispatch/` folder, containing:

- `repo/`: a disposable Git repository with one commit on `main`. Commits use your normal Git identity.
- `backlog.md`: a tasks-axi store with one ready task: `hello-a1` (commit a file), or `survey-a1` with kind `scout` (write a report) when `--kind scout` is given.
- `switchboard.json`: the configuration, with every path inside the demo directory.
- `runtime/` and `pool/`: created by Switchboard and Treehouse during dispatch.

Nothing outside that directory is changed. The Treehouse pool lives inside it, so the leased workspace does not appear in your normal Treehouse state.

## Run

From the repository root, using PowerShell:

```powershell
node investigations/real-dispatch/run.ts --provider openai-codex --model gpt-6.1-sol
```

To try a report-only task under a `scout` delivery contract instead:

```powershell
node investigations/real-dispatch/run.ts --provider openai-codex --model gpt-6.1-sol --kind scout
```

`--provider` and `--model` are required, so a run never picks a model by accident. The Pi entry point defaults to the resolved target of `pi` on `PATH`; pass `--pi-entrypoint <path>` to use another. Requires `git`, `treehouse` and `pi` on `PATH`, and Pi credentials for the chosen provider.

To build the demo without dispatching, add `--setup-only`. It prints the configuration path so you can run `status` and `dispatch --once` yourself.

## Checks

After a `code` dispatch, the script reports PASS or FAIL for each of:

- the task was held for review (reason `held`, next action `review_branch`)
- the output branch's head is the reported result commit
- `hello.txt` on the output branch contains exactly the requested line
- `main` is unchanged
- the task store shows the task queued and held
- the retention check passed
- `status` asks for review

After a `scout` dispatch:

- the task was recorded as done
- the task store shows it done
- a non-empty report exists in the attempt's `artefacts/` directory, outside the workspace
- the output branch has no new commits and `main` is unchanged
- the retention check passed
- `status` asks for the lease to be returned

It exits 0 only when every check passes. A model can occasionally misread the task, so a single FAIL is worth reading in the demo's files before treating it as a Switchboard fault.

## Clean up

Each demo is self-contained. Delete its directory under `.investigation/real-dispatch/` when you no longer need it.
