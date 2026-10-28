import { test } from "node:test";
import assert from "node:assert/strict";
import { validateWorkerResult } from "../../src/runtime/contracts.ts";
import { fixture, resultFor } from "../helpers.ts";

test("completed worker report retains review-required delivery semantics without claiming task acceptance", () => {
  const { input } = fixture();
  const result = validateWorkerResult(resultFor(input), input);
  assert.equal(result.outcome, "completed");
  assert.equal(input.delivery.acceptance, "review_or_integration");
  assert.equal("taskState" in result, false);
});

test("identity, evidence and named deliverables are mandatory for completed work", () => {
  const { input } = fixture();
  const valid = resultFor(input);
  assert.throws(() => validateWorkerResult({ ...valid, identity: { ...valid.identity, leaseId: "other" } }, input), /identity/);
  assert.throws(() => validateWorkerResult({ ...valid, validationEvidence: [] }, input), /evidence/);
  assert.throws(() => validateWorkerResult({ ...valid, workReferences: [] }, input), /deliverable/);
  assert.throws(() => validateWorkerResult({ ...valid, validationEvidence: [...valid.validationEvidence, ...valid.validationEvidence] }, input), /Duplicate/);
  assert.throws(() => validateWorkerResult({ ...valid, workReferences: [{ ...valid.workReferences[0], branch: "wrong" }] }, input), /output branch/);
  assert.throws(() => validateWorkerResult({ ...valid, independentlyVerified: true }, input));
});

test("completed artefact work requires an artefact reference even without configured deliverable names", () => {
  const { input } = fixture();
  input.delivery.kind = "artefact";
  input.delivery.requiredDeliverables = [];
  const result = resultFor(input);
  assert.throws(() => validateWorkerResult(result, input), /artefact reference/);
  assert.equal(validateWorkerResult({ ...result, workReferences: [
    { kind: "artefact", name: "design", path: "design.md", description: "Retained design draft" },
  ] }, input).outcome, "completed");
});

test("a required deliverable may be either kind of reference, whatever the contract's kind", () => {
  const { input } = fixture();
  input.delivery.requiredDeliverables = ["code", "report"];
  const result = resultFor(input);
  const report = { kind: "artefact" as const, name: "report", path: "/report.md", description: "Required report" };
  assert.equal(validateWorkerResult({ ...result, workReferences: [...result.workReferences, report] }, input).outcome, "completed");
  input.delivery.kind = "artefact";
  input.delivery.requiredDeliverables = ["report"];
  assert.equal(validateWorkerResult({ ...result, workReferences: [
    { kind: "git", name: "report", branch: "reports", commit: "c".repeat(40) },
    { kind: "artefact", name: "extra", path: "/extra.md", description: "Another artefact" },
  ] }, input).outcome, "completed");
});

test("every criterion needs one report with its exact text and 1-based position, for every outcome", () => {
  const { input } = fixture();
  input.acceptanceCriteria = ["First", "Second", "First"];
  const valid = resultFor(input);
  const reports = valid.criteriaReport;
  for (const outcome of ["completed", "hold", "failed"]) {
    const value = { ...valid, outcome, ...(outcome === "completed" ? {} : { reason: "Needs work", nextAction: "Inspect" }) };
    assert.equal(validateWorkerResult(value, input).outcome, outcome);
    assert.equal(validateWorkerResult({ ...value, criteriaReport: [...reports].reverse() }, input).outcome, outcome);
    const invalid = [
      undefined, [], reports.slice(1), [reports[0], reports[0], reports[2]],
      [...reports, { ...reports[0], position: 4 }],
      [reports[0], { ...reports[1], position: 4 }, reports[2]],
      [reports[0], { ...reports[1], criterion: "Wrong text" }, reports[2]],
      [reports[0], { ...reports[1], position: 0 }, reports[2]],
      [reports[0], { ...reports[1], evidence: "" }, reports[2]],
      [reports[0], { ...reports[1], status: "unknown" }, reports[2]],
    ];
    for (const criteriaReport of invalid) assert.throws(() => validateWorkerResult({ ...value, criteriaReport }, input));
  }
  assert.equal(validateWorkerResult({ ...valid, criteriaReport: reports.map(report => ({ ...report, status: "not_met" })) }, input).outcome, "completed");
});

test("tasks without criteria need no report and refuse extra reports", () => {
  const { input } = fixture();
  input.acceptanceCriteria = [];
  const valid = resultFor(input);
  const { criteriaReport: _, ...withoutReport } = valid;
  assert.equal(validateWorkerResult(withoutReport, input).outcome, "completed");
  assert.equal(validateWorkerResult(valid, input).outcome, "completed");
  assert.throws(() => validateWorkerResult({ ...valid, criteriaReport: [{ position: 1, criterion: "Extra", status: "met", evidence: "Claim" }] }, input));
});

test("hold and failure require a reason and next action but need not claim successful evidence", () => {
  const { input } = fixture();
  const held = { ...resultFor(input), outcome: "hold", validationEvidence: [], workReferences: [], reason: "Needs operator input", nextAction: "Inspect retained workspace" };
  assert.equal(validateWorkerResult(held, input).outcome, "hold");
  assert.equal(validateWorkerResult({ ...held, outcome: "failed" }, input).outcome, "failed");
  assert.throws(() => validateWorkerResult({ ...held, nextAction: "" }, input));
});
