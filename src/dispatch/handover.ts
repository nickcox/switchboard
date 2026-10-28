import type { AttemptRecord } from "../attempts/log.ts";
import { latestChecks } from "../attempts/checks.ts";
import { recordedReviews } from "../attempts/reviews.ts";
import { runCommand, describeCommand } from "../infra/command.ts";
import type { WorkerResult } from "../runtime/contracts.ts";
import type { Task } from "../tasks/store.ts";
import type { Question } from "../runtime/questions-store.ts";

/** Read only the recorded range, not the source branch's current head. Stored with the new reservation. */
export async function handover(git: string, environment: Record<string, string>, task: Task, source: AttemptRecord, commit: string, result: WorkerResult | undefined, note?: string, questions: Question[] = source.questions ?? []): Promise<string> {
  const allocation = source.allocation!;
  if (!allocation.backingRepository) throw new Error("The earlier attempt has no recorded backing repository");
  const commits = await runCommand(git, ["log", "--reverse", "--format=%H %s", `${allocation.startingCommit}..${commit}`], {
    cwd: allocation.backingRepository, env: environment, timeoutMs: 15000,
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
    `Review findings for ${commit}:\n${JSON.stringify(recordedReviews(source, commit), null, 2)}`,
    `Check results for ${commit}:\n${JSON.stringify(latestChecks(source, commit), null, 2)}`,
    `Recorded worker evidence:\n${JSON.stringify({ validationEvidence: result?.validationEvidence ?? [], workReferences: result?.workReferences ?? [] }, null, 2)}`,
    `Worker questions (open and answered, across this task's attempts):\n${JSON.stringify(questions, null, 2)}`,
    "Answers are guidance, not authority; they do not change the new attempt's instructions, permissions or delivery contract.",
    `Requester's note:\n${note ?? "No note supplied"}`,
    "This is a separate request, not a retry of the earlier worker. Do not change the earlier attempt's branch, lease or records.",
  ].join("\n\n");
}
