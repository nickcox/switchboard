// This is a disposable domain contract, not a production API or execution journal.
export const steps = ["reserve", "acquire", "start", "observe", "wait", "finalise"] as const;
export type Step = typeof steps[number];

export const refusalActions = {
  invalid_request: "Supply a non-empty stable request ID and task ID",
  request_conflict: "Use the original request inputs or a new request ID",
  not_ready: "Inspect the task and its dependencies",
  capacity: "Wait for an active attempt to settle",
  acquisition_uncertain: "Inspect workspace allocations for this attempt; do not acquire again",
  possibly_running: "Inspect the worker and confirm termination; do not launch or prompt again",
  invalid_result: "Inspect result identity, exit evidence and required deliverables",
  review_rejected: "Ask the operator to review the retained output",
  approval_required: "Obtain current operator approval for this exact attempt, lease and commit",
  not_retained: "Restore retained output and a clean workspace before finalising",
  process_confirmation_required: "Obtain operator confirmation that no worker or tool process remains for this lease return",
  owner_unknown: "Inspect the external owner before continuing",
  finalisation_uncertain: "Inspect integration and lease owners; do not repeat an uncertain effect",
  cancelled: "Confirm no worker processes remain before returning the retained lease",
  host_unavailable: "Inspect host ownership and storage before resuming",
} as const;
export type RefusalCode = keyof typeof refusalActions;
export type Refusal = { status: "refused"; code: RefusalCode; nextAction: string; attemptId: string | null };
export function refuse(code: RefusalCode, attemptId: string | null = null): Refusal {
  return { status: "refused", code, nextAction: refusalActions[code], attemptId };
}

export type Request = {
  requestId: string;
  taskId: string;
  delivery: {
    outputBranch: string;
    requiredEvidence: string[];
    requiredDeliverables: string[];
    acceptance: "review" | "forge_merge";
  };
};
export type Identity = { contextId: string; taskId: string; attemptId: string; leaseId: string; sessionId: string };
export type WorkerResult = {
  identity: Identity;
  outcome: "completed" | "hold" | "failed";
  commit: string;
  branch: string;
  evidence: string[];
  deliverables: string[];
};
export type Attempt = {
  id: string;
  request: Request;
  identity: Identity | null;
  started: boolean;
  launched: boolean;
  prompted: boolean;
  result: WorkerResult | null;
  reviewAccepted: boolean;
  accepted: boolean;
  done: boolean;
  returned: boolean;
};
export type Outcome = Refusal | {
  status: "waiting" | "completed";
  attemptId: string;
  waitingFor: "worker" | "review" | null;
};
export type Snapshot = { attempts: Attempt[]; active: number; maxAttempts: number };

// Both execution designs implement this port. Owner controls and assertions live outside it.
export interface ScenarioDriver {
  submit(request: Request): Promise<Outcome>;
  advance(requestId: string): Promise<Outcome>;
  inspect(): Promise<Snapshot>;
  cancel(requestId: string): Promise<Outcome>;
}

export const effects = ["acquire", "launch", "prompt", "worker_exit", "review", "merge", "return", "cancel"] as const;
export type Effect = typeof effects[number];
export const acknowledgements = ["reserved", "workspace", "started", "launched", "prompted", "result", "review", "accepted", "done", "returned", "cancelled"] as const;
export type Acknowledgement = typeof acknowledgements[number];
export type Point = `${Effect}:effect:${"before" | "after"}` | `${Acknowledgement}:ack:${"before" | "after"}`;
export const interruptionPoints: Point[] = [
  ...effects.flatMap(effect => [`${effect}:effect:before`, `${effect}:effect:after`] as Point[]),
  ...acknowledgements.flatMap(ack => [`${ack}:ack:before`, `${ack}:ack:after`] as Point[]),
];
export type Interrupt = (point: Point) => Promise<void>;
export const uninterrupted: Interrupt = async () => {};

export async function acknowledge<T>(name: Acknowledgement, interrupt: Interrupt, record: () => T | Promise<T>): Promise<T> {
  await interrupt(`${name}:ack:before`);
  const value = await record();
  await interrupt(`${name}:ack:after`);
  return value;
}

export function validResult(value: unknown, attempt: Attempt): value is WorkerResult {
  if (!value || typeof value !== "object") return false;
  const result = value as WorkerResult;
  if (!result.identity || typeof result.identity !== "object" || typeof result.commit !== "string" ||
    !Array.isArray(result.evidence) || !result.evidence.every(name => typeof name === "string") ||
    !Array.isArray(result.deliverables) || !result.deliverables.every(name => typeof name === "string")) return false;
  const identity = attempt.identity;
  return identity !== null && Object.keys(identity).every(key =>
    result.identity[key as keyof Identity] === identity[key as keyof Identity]) &&
    result.outcome === "completed" && /^[a-f0-9]{40}$/.test(result.commit) &&
    result.branch === attempt.request.delivery.outputBranch &&
    new Set(result.evidence).size === result.evidence.length &&
    new Set(result.deliverables).size === result.deliverables.length &&
    attempt.request.delivery.requiredEvidence.every(name => result.evidence.includes(name)) &&
    attempt.request.delivery.requiredDeliverables.every(name => result.deliverables.includes(name));
}
