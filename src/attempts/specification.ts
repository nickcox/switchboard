import { z } from "zod";
import { deliverySchema, type WorkerInput } from "../runtime/contracts.ts";
import { runtimeSettingsSchema } from "../runtime/settings.ts";
export type { RuntimeSettings } from "../runtime/settings.ts";

const nonempty = z.string().min(1);
const contractSchema = deliverySchema.omit({ baseRef: true, outputBranch: true, startingCommit: true });
export const attemptSpecificationSchema = z.strictObject({
  version: z.literal(1), taskId: nonempty, contextId: nonempty,
  definitionRevision: z.number().int().positive(), title: z.string(), instructions: z.string(), acceptanceCriteria: z.array(nonempty),
  repository: nonempty.nullable(), backingRepository: nonempty, kind: nonempty.nullable(),
  baseRef: nonempty, outputBranch: nonempty, delivery: contractSchema, runtime: runtimeSettingsSchema,
  /** Configuration selectors, or unknown for values that older bindings did not retain. */
  provenance: z.record(z.string(), nonempty),
});
export type AttemptSpecification = z.infer<typeof attemptSpecificationSchema>;
/** Older bindings retain only part of the specification. Missing fields are never filled from today's task or config. */
export const storedSpecificationSchema = attemptSpecificationSchema.partial().required({ version: true, taskId: true, contextId: true, provenance: true });
export type StoredSpecification = z.infer<typeof storedSpecificationSchema>;
export type AttemptAllocation = {
  leaseId: string; workspace: string; baseRef: string; outputBranch: string; startingCommit: string;
  pool?: string | undefined; backingRepository?: string | undefined;
};

export function workerInput(specification: AttemptSpecification, allocation: AttemptAllocation, sessionId: string): WorkerInput {
  if (!allocation.backingRepository || allocation.backingRepository !== specification.backingRepository ||
    allocation.baseRef !== specification.baseRef || allocation.outputBranch !== specification.outputBranch) {
    throw new Error("The allocation does not match the stored attempt specification");
  }
  return {
    identity: { contextId: specification.contextId, taskId: specification.taskId, leaseId: allocation.leaseId, sessionId },
    workspace: allocation.workspace, instructions: specification.instructions, acceptanceCriteria: specification.acceptanceCriteria,
    delivery: { ...specification.delivery, baseRef: specification.baseRef, outputBranch: specification.outputBranch, startingCommit: allocation.startingCommit },
  };
}

/** Convert only facts present in a historical binding. In particular, a current task is not evidence of its old title. */
export function specificationFromBinding(value: WorkerInput): StoredSpecification {
  const { baseRef, outputBranch, startingCommit: _, ...delivery } = value.delivery;
  return {
    version: 1, taskId: value.identity.taskId, contextId: value.identity.contextId,
    instructions: value.instructions, acceptanceCriteria: value.acceptanceCriteria, baseRef, outputBranch, delivery,
    provenance: Object.fromEntries(Object.keys(attemptSpecificationSchema.shape).filter(key => key !== "provenance").map(key => [key, "unknown"])),
  };
}
