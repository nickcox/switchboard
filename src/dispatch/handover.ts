import type { AttemptRecord } from "../attempts/log.ts";
import { runCommand, describeCommand } from "../infra/command.ts";
import { onPath } from "../infra/executables.ts";
import type { WorkerResult } from "../runtime/contracts.ts";
import type { Task } from "../tasks/store.ts";

/** Read only the recorded range, not the source branch's current head. Stored with the new reservation. */
export async function handover(task: Task, source: AttemptRecord, commit: string, result: WorkerResult | undefined, note?: string): Promise<string> {
  const allocation = source.allocation!;
  if (!allocation.backingRepository) throw new Error("The earlier attempt has no recorded backing repository");
  const commits = await runCommand(onPath("git"), ["log", "--reverse", "--format=%H %s", `${allocation.startingCommit}..${commit}`], {
    cwd: allocation.backingRepository, env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), timeoutMs: 15000,
  });
  if (commits.exitCode !== 0 || commits.timedOut || commits.truncated) throw new Error(`Could not read the earlier attempt's commits: ${describeCommand(commits)}`);
  return [
    "## Handover from an earlier attempt",
    `Task: ${task.id} – ${task.title}`,
    `Instructions:\n${task.body.trim() === "" ? task.title : task.body}`,
    `Acceptance criteria:\n${JSON.stringify(task.acceptanceCriteria, null, 2)}`,
    `Earlier attempt: ${source.attempt}, output commit ${commit}`,
    `Outcome: ${result?.outcome ?? [...source.entries].reverse().find(e => e.kind === "task_recorded")?.data.category ?? "unknown"}`,
    `Summary: ${result?.summary ?? "No worker summary recorded"}`,
    `Commits since ${allocation.startingCommit}:\n${commits.stdout.trim() || "None"}`,
    `Criteria report:\n${JSON.stringify(result?.criteriaReport ?? [], null, 2)}`,
    // Keep recorded findings and notes verbatim, including operator decisions and any review evidence.
    `Review findings and recorded evidence:\n${JSON.stringify({ result: result ?? null, entries: source.entries }, null, 2)}`,
    `Requester's note:\n${note ?? "No note supplied"}`,
    "This is a separate request, not a retry of the earlier worker. Do not change the earlier attempt's branch, lease or records.",
  ].join("\n\n");
}
