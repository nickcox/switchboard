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

test("hold and failure require a reason and next action but need not claim successful evidence", () => {
  const { input } = fixture();
  const held = { ...resultFor(input), outcome: "hold", validationEvidence: [], workReferences: [], reason: "Needs operator input", nextAction: "Inspect retained workspace" };
  assert.equal(validateWorkerResult(held, input).outcome, "hold");
  assert.equal(validateWorkerResult({ ...held, outcome: "failed" }, input).outcome, "failed");
  assert.throws(() => validateWorkerResult({ ...held, nextAction: "" }, input));
});
