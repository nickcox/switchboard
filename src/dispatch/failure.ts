import { redactDiagnostics, type CommandResult } from "../infra/command.ts";

export type FailureKind = "owner_read" | "approval_required" | "effect_uncertain" | "rejected";
export type FailureEvidence =
  | { step: "read"; effectAttempted: boolean }
  | { step: "approval" }
  | { step: "effect" }
  | { step: "rejection" };

/** Only the operation can supply evidence that a failed read preceded any attempted effect. */
export function classifyFailure(evidence: FailureEvidence): FailureKind {
  if (evidence.step === "read") return evidence.effectAttempted ? "effect_uncertain" : "owner_read";
  return evidence.step === "approval" ? "approval_required" : evidence.step === "effect" ? "effect_uncertain" : "rejected";
}

export type CommandDiagnostics = Pick<CommandResult, "exitCode" | "stdout" | "stderr" | "timedOut" | "truncated" | "command">;
export type ReadFailure = {
  owner: string;
  classification: FailureKind;
  operation: "dispatch" | "resolve" | "prune" | "finish" | "discard";
  step: string;
  failedAt: string;
  diagnostics: { message: string; command?: CommandDiagnostics };
};

/** Keep only diagnostic fields, never an error's arbitrary properties, environment or stack. */
export function readDiagnostics(error: unknown): ReadFailure["diagnostics"] {
  const message = redactDiagnostics(error instanceof Error ? error.message : String(error));
  let detail: unknown;
  if (typeof error === "object" && error !== null && "detail" in error && typeof error.detail === "string") {
    try { detail = JSON.parse(error.detail); } catch { /* Not command diagnostics. */ }
  }
  if (typeof detail !== "object" || detail === null) return { message };
  const value = detail as Partial<CommandDiagnostics>;
  if (!(value.exitCode === null || typeof value.exitCode === "number") || typeof value.stdout !== "string" || typeof value.stderr !== "string") return { message };
  return { message, command: {
    exitCode: value.exitCode, stdout: redactDiagnostics(value.stdout).slice(-2000), stderr: redactDiagnostics(value.stderr).slice(-2000),
    timedOut: value.timedOut === true, truncated: value.truncated === true,
    ...(value.command && typeof value.command.executable === "string" && Array.isArray(value.command.args) && value.command.args.every(arg => typeof arg === "string")
      ? { command: { executable: redactDiagnostics(value.command.executable), args: value.command.args.map(redactDiagnostics) } } : {}),
  } };
}

export class OwnerReadError extends Error {
  readonly failure: ReadFailure;
  constructor(failure: ReadFailure) {
    super(`${failure.owner} could not be read`);
    this.failure = failure;
  }
}
