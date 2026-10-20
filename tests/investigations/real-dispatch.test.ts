import { test } from "node:test";
import assert from "node:assert/strict";
import { isArtefactPath } from "../../investigations/real-dispatch/paths.ts";

// Review finding 22: recursive directory listings use the platform's separator.
test("the real-dispatch demo recognises artefact paths with either separator", () => {
  assert.equal(isArtefactPath("context/lease/artefacts/report.md"), true);
  assert.equal(isArtefactPath("context\\lease\\artefacts\\report.md"), true);
  assert.equal(isArtefactPath("artefacts/report.md"), true);
  assert.equal(isArtefactPath("context/lease/artefacts"), false);
  assert.equal(isArtefactPath("context/lease/artefacts/nested/report.md"), false);
  assert.equal(isArtefactPath("context/lease/sessions/report.md"), false);
});
