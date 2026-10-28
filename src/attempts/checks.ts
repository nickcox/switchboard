import { z } from "zod";
import type { AttemptRecord } from "./log.ts";

const name = z.string().trim().min(1);
export const checkCommandSchema = z.strictObject({
  name,
  command: z.tuple([z.string().min(1)], z.string()),
  timeoutMs: z.number().int().positive().max(2147483647),
});
export const checkCommandsSchema = z.array(checkCommandSchema).refine(
  checks => new Set(checks.map(check => check.name)).size === checks.length, "Check names must be unique",
);
export type CheckCommand = z.infer<typeof checkCommandSchema>;

export const checkResultSchema = z.strictObject({
  name,
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  status: z.enum(["passed", "failed", "not_run"]),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().nonnegative(),
  stdout: z.string(),
  stderr: z.string(),
  diagnostics: z.strictObject({ message: z.string(), command: z.unknown().optional() }).optional(),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

export function latestChecks(record: AttemptRecord | undefined, commit: string | undefined): CheckResult[] {
  const latest = new Map<string, CheckResult>();
  for (const entry of record?.entries ?? []) {
    if (entry.kind === "check_finished" && entry.data.commit === commit) {
      const check = checkResultSchema.parse(entry.data);
      latest.set(check.name, check);
    }
  }
  return [...latest.values()];
}

export function describeChecks(checks: CheckResult[] | undefined): string[] {
  return (checks ?? []).flatMap(check => [
    `Check ${check.name}: ${check.status === "passed" ? "passed" : check.status === "failed" ? "FAILED" : "NOT RUN"} at ${check.commit} (exit ${check.exitCode ?? "none"}${check.timedOut ? ", time limit reached" : ""}; ${check.durationMs} ms)`,
    ...(check.status === "passed" ? [] : [
      ...(check.stdout ? [`  stdout: ${check.stdout}`] : []),
      ...(check.stderr ? [`  stderr: ${check.stderr}`] : []),
      ...(check.diagnostics ? [`  Diagnostics: ${JSON.stringify(check.diagnostics)}`] : []),
    ]),
  ]);
}
