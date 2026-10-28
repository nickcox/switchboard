import type { CriteriaReport } from "./contracts.ts";

export function describeCriteriaReport(report: CriteriaReport | undefined): string[] {
  return [...(report ?? [])].sort((a, b) => a.position - b.position).map(entry => `Criterion ${entry.position}: ${entry.status} – ${entry.criterion}\n  Evidence (worker claim): ${entry.evidence}`);
}
