import { expect, test } from "bun:test";
import { validateWorkerResult } from "../../src/runtime/contracts.ts";
import { fixture, resultFor } from "../helpers.ts";

test("completed worker report retains review-required delivery semantics without claiming task acceptance", () => {
  const { input } = fixture();
  const result = validateWorkerResult(resultFor(input), input);
  expect(result.outcome).toBe("completed");
  expect(input.delivery.acceptance).toBe("review_or_integration");
  expect("taskState" in result).toBe(false);
});

test("identity, evidence and named deliverables are mandatory for completed work", () => {
  const { input } = fixture();
  const valid = resultFor(input);
  expect(() => validateWorkerResult({ ...valid, identity: { ...valid.identity, leaseId: "other" } }, input)).toThrow("identity");
  expect(() => validateWorkerResult({ ...valid, validationEvidence: [] }, input)).toThrow("evidence");
  expect(() => validateWorkerResult({ ...valid, workReferences: [] }, input)).toThrow("deliverable");
  expect(() => validateWorkerResult({ ...valid, validationEvidence: [...valid.validationEvidence, ...valid.validationEvidence] }, input)).toThrow("Duplicate");
  expect(() => validateWorkerResult({ ...valid, workReferences: [{ ...valid.workReferences[0], branch: "wrong" }] }, input)).toThrow("output branch");
  expect(() => validateWorkerResult({ ...valid, independentlyVerified: true }, input)).toThrow();
});

test("completed artefact work requires an artefact reference even without configured deliverable names", () => {
  const { input } = fixture();
  input.delivery.kind = "artefact";
  input.delivery.requiredDeliverables = [];
  const result = resultFor(input);
  expect(() => validateWorkerResult(result, input)).toThrow("artefact reference");
  expect(validateWorkerResult({ ...result, workReferences: [
    { kind: "artefact", name: "design", path: "design.md", description: "Retained design draft" },
  ] }, input).outcome).toBe("completed");
});

test("hold and failure require a reason and next action but need not claim successful evidence", () => {
  const { input } = fixture();
  const held = { ...resultFor(input), outcome: "hold", validationEvidence: [], workReferences: [], reason: "Needs operator input", nextAction: "Inspect retained workspace" };
  expect(validateWorkerResult(held, input).outcome).toBe("hold");
  expect(validateWorkerResult({ ...held, outcome: "failed" }, input).outcome).toBe("failed");
  expect(() => validateWorkerResult({ ...held, nextAction: "" }, input)).toThrow();
});
