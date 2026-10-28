import type { AttemptStore } from "../attempts/store.ts";
import type { RuntimeSettings } from "../attempts/specification.ts";
import type { DeliveryContract, WorkerInput } from "../runtime/contracts.ts";
import type { RunReport, WorkerHooks } from "../runtime/supervisor.ts";
import type { RuntimeRecords } from "../runtime/records.ts";
import type { TaskStore } from "../tasks/store.ts";
import type { WorkspaceProvider } from "../workspaces/provider.ts";
import type { RetentionRequest, RetentionResult } from "../workspaces/retention.ts";
import type { PolicySources } from "./policy.ts";

/** The parts of a delivery contract chosen per task; the base, branch and starting commit are added per attempt. */
export type ContractSpec = Pick<DeliveryContract, "kind" | "acceptance" | "requiredEvidence" | "requiredDeliverables">;
export type DeliveryConfiguration = {
  baseRef: string;
  branchPrefix: string;
  /** Used for a task with no kind. */
  default: ContractSpec;
  /** Contracts selected by task kind. A task whose kind is not listed is refused before any change. */
  byTaskKind: Record<string, ContractSpec>;
};

export type Dependencies = {
  contextId: string;
  tasks: TaskStore;
  workspaces: WorkspaceProvider;
  attempts: AttemptStore;
  maxAttempts?: number;
  maxAttemptsPerTask?: number;
  runtime: RuntimeRecords;
  launch: (input: WorkerInput, signal?: AbortSignal, onRequest?: WorkerHooks["onRequest"], settings?: RuntimeSettings) => Promise<RunReport>;
  runtimeSettings: RuntimeSettings;
  configurationProvenance: Record<string, string>;
  retention: (request: RetentionRequest) => Promise<RetentionResult>;
  /** The repository whose refs the workspaces share, for retention checks. */
  repository: string;
  delivery: DeliveryConfiguration;
  /** A possibly running worker with no activity for this long is flagged in status. Default 20 minutes. */
  staleMs?: number;
  /** Where the finalisation policy's layers are found (Phase 2 PRD). Without it the policy is `manual`. */
  policy?: PolicySources;
  progress?: (message: string) => void;
};

