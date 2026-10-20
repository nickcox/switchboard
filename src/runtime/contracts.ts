import { z } from "zod";

// Validate without normalising provider identities or instruction snapshots.
const nonempty = z.string().min(1).refine(value => value.trim().length > 0);
export const identitySchema = z.strictObject({
  contextId: nonempty,
  taskId: nonempty,
  leaseId: nonempty,
  sessionId: z.uuid(),
});
export type WorkerIdentity = z.infer<typeof identitySchema>;

const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const deliverySchema = z.strictObject({
  baseRef: nonempty,
  startingCommit: commit,
  outputBranch: nonempty,
  kind: z.enum(["code", "artefact"]),
  acceptance: z.enum(["review_or_integration", "independent_deliverable"]),
  requiredEvidence: z.array(nonempty),
  requiredDeliverables: z.array(nonempty),
});
export type DeliveryContract = z.infer<typeof deliverySchema>;

export const workerInputSchema = z.strictObject({
  identity: identitySchema,
  workspace: nonempty,
  instructions: nonempty,
  acceptanceCriteria: z.array(nonempty),
  delivery: deliverySchema,
});
export type WorkerInput = z.infer<typeof workerInputSchema>;

const workReference = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("git"), name: nonempty, branch: nonempty, commit }),
  z.strictObject({ kind: z.literal("artefact"), name: nonempty, path: nonempty, description: nonempty }),
]);
const resultFields = {
  version: z.literal(1),
  identity: identitySchema,
  summary: nonempty,
  validationEvidence: z.array(z.strictObject({ name: nonempty, summary: nonempty })),
  workReferences: z.array(workReference),
};
export const workerResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ ...resultFields, outcome: z.literal("completed") }),
  z.strictObject({ ...resultFields, outcome: z.literal("hold"), reason: nonempty, nextAction: nonempty }),
  z.strictObject({ ...resultFields, outcome: z.literal("failed"), reason: nonempty, nextAction: nonempty }),
]);
export type WorkerResult = z.infer<typeof workerResultSchema>;

export function sameIdentity(a: WorkerIdentity, b: WorkerIdentity): boolean {
  return a.contextId === b.contextId && a.taskId === b.taskId &&
    a.leaseId === b.leaseId && a.sessionId === b.sessionId;
}

/** Mechanical worker-report checks, not independent acceptance or Git retention verification. */
export function validateWorkerResult(value: unknown, input: WorkerInput): WorkerResult {
  const result = workerResultSchema.parse(value);
  if (!sameIdentity(result.identity, input.identity)) throw new Error("Result identity does not match this worker");
  const evidenceNames = result.validationEvidence.map(entry => entry.name);
  if (new Set(evidenceNames).size !== evidenceNames.length) throw new Error("Duplicate evidence names");
  if (result.outcome === "completed") {
    for (const name of input.delivery.requiredEvidence) {
      if (!evidenceNames.includes(name)) throw new Error(`Missing required evidence: ${name}`);
    }
    const deliverables = result.workReferences.map(ref => ref.name);
    if (new Set(deliverables).size !== deliverables.length) throw new Error("Duplicate deliverable names");
    // A required deliverable may be either kind of reference; retention then checks each by its own kind.
    for (const name of input.delivery.requiredDeliverables) {
      if (!deliverables.includes(name)) throw new Error(`Missing required deliverable: ${name}`);
    }
    if (input.delivery.kind === "code" && !result.workReferences.some(ref =>
      ref.kind === "git" && ref.branch === input.delivery.outputBranch)) {
      throw new Error("Completed code work must report the named output branch and result commit");
    }
    if (input.delivery.kind === "artefact" && !result.workReferences.some(ref => ref.kind === "artefact")) {
      throw new Error("Completed artefact work must report an artefact reference");
    }
  }
  return result;
}
