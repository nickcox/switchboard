import { defineDoc, type ContextView, type HarnessInspection } from "@earendil-works/pi-durable";
import type { Outcome, Snapshot } from "../scenario/contract.ts";

export const decisionCases = ["expired", "revoked", "no_processes", "retention_changed", "approval_commit_changed", "model_commit_changed", "model_authority", "review_wait"] as const;
export type DecisionCase = typeof decisionCases[number];
export type DecisionConfig = { scenario: DecisionCase; requestId: string };
export type DecisionScope = { requestId: string; attemptId: string; commit: string };
// A reasoning reference, never an approval, task lifecycle or execution cursor.
export const PendingDecision = defineDoc<{ pending?: DecisionScope }>({
  kind: "investigation.supervisor-decision", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({}), checkpointWhen: () => true,
});
export const decisionInput = { type: "input", content: "Inspect the pending review/approval decision before finalising.", requestId: "decision-input-1" } as const;
export const retryInput = { type: "input", content: "Reinspect current evidence and approvals, then try finalisation again.", requestId: "decision-retry-1" } as const;
export type DecisionView = { conversationId: number; decision: { pending?: DecisionScope } | null;
  transcript: ContextView; engine: HarnessInspection; snapshot: Snapshot };
export type DecisionEvidence = { before: DecisionView; after: DecisionView; submissionId: number; settled: string };
export type DecisionCall = { tool: string; pid: number; scope?: DecisionScope; outcome?: Outcome };
