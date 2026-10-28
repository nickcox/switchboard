import type { AttemptRef } from "../attempts/log.ts";
import type { AttemptSpecification } from "../attempts/specification.ts";
import type { Task } from "../tasks/store.ts";
import type { ContractSpec, Dependencies } from "./dependencies.ts";

/** Copy resolved inputs before reservation, rather than reading configuration during acquisition. */
export function specificationFactory(deps: Dependencies, contract: ContractSpec): (task: Task, ref: AttemptRef) => AttemptSpecification {
  const configuration = structuredClone({ delivery: deps.delivery, runtime: deps.runtimeSettings, repository: deps.repository, provenance: deps.configurationProvenance });
  const resolvedContract = structuredClone(contract);
  return (task, ref) => ({
    version: 1, taskId: task.id, contextId: ref.contextId, definitionRevision: task.definitionRevision,
    title: task.title, instructions: task.body.trim() === "" ? task.title : task.body, acceptanceCriteria: task.acceptanceCriteria, repository: task.repo, kind: task.kind, objectiveId: task.objectiveId,
    backingRepository: configuration.repository, baseRef: configuration.delivery.baseRef,
    outputBranch: `${configuration.delivery.branchPrefix}${task.id}/attempt-${ref.attempt}`,
    delivery: resolvedContract, runtime: configuration.runtime, provenance: {
      ...configuration.provenance,
      objectiveId: `task:${task.id}.objectiveId`, definitionRevision: `task:${task.id}.definitionRevision`, title: `task:${task.id}.title`, acceptanceCriteria: `task:${task.id}.acceptanceCriteria`,
      instructions: `task:${task.id}.${task.body.trim() === "" ? "title" : "body"}`, kind: `task:${task.id}.kind`,
      ...Object.fromEntries(Object.keys(resolvedContract).map(key => [`delivery.${key}`,
        configuration.provenance[`delivery.${task.kind === null ? "default" : `byTaskKind.${task.kind}`}.${key}`] ?? "unknown"])),
    },
  });
}
