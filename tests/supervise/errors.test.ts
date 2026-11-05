import assert from "node:assert/strict";
import { test } from "node:test";
import { AttemptStore } from "../../src/attempts/store.ts";
import { ObjectiveStore } from "../../src/objectives/store.ts";
import { briefing } from "../../src/supervise/briefing.ts";
import { ObjectiveNotOpenError, requireOpenObjective } from "../../src/supervise/errors.ts";
import { handleEvent, pendingEvents, waitForEvent } from "../../src/supervise/events.ts";
import { appendNote } from "../../src/supervise/notes.ts";
import { askPerson } from "../../src/supervise/questions.ts";
import { recordSupervisorUsage } from "../../src/supervise/usage.ts";
import { TaskStoreError } from "../../src/tasks/store.ts";
import { fixture } from "../dispatch/fixture.ts";
import { specificationFor } from "../helpers.ts";

const supervisor = { kind: "supervisor", objectiveId: "goal" } as const;

for (const state of ["completed", "abandoned"] as const) test(`supervisor operations identify ${state} refusals, including an in-flight wait`, async () => {
  const f = await fixture();
  const database = f.tasks.database;
  const objectives = new ObjectiveStore(database, f.deps.caller);
  const attempts = new AttemptStore(database, f.deps.contextId, supervisor);
  const deps = { ...f.deps, caller: supervisor, attempts };
  try {
    await objectives.add({ id: "goal", request: "Useful work", acceptanceCriteria: ["Useful output"] });
    await f.tasks.add({ id: "work", title: "Work", objectiveId: "goal" });
    const { ref } = await f.deps.attempts.reserveAttempt({ taskId: "work", requested: {}, maximum: 1, specification: specificationFor });
    const commit = "a".repeat(40);
    await f.deps.attempts.appendConfirmed(ref, "output_accepted", { commit }, { fact: "output_accepted", scope: { commit } });
    for (let next; (next = pendingEvents(database, "goal").first);) await handleEvent(database, supervisor, "goal", next.id);
    const refuses = (detail: string) => (error: unknown) => {
      assert.ok(error instanceof TaskStoreError);
      assert.ok(error instanceof ObjectiveNotOpenError);
      assert.equal(error.reason, "rejected");
      assert.equal(error.message, detail);
      assert.equal(error.code, "objective_not_open");
      assert.equal(error.state, state);
      return true;
    };
    const eventsDetail = "Objective goal must be open before supervising its events";
    const waiting = assert.rejects(waitForEvent(database, supervisor, "goal", 5), refuses(eventsDetail));
    if (state === "completed") await objectives.complete("goal", [{ position: 1, statement: "Met", references: objectives.show("goal").availableReferences }]);
    else await objectives.abandon("goal");
    await waiting;
    const operations: [() => Promise<unknown>, string][] = [
      [() => waitForEvent(database, supervisor, "goal", 0), eventsDetail],
      [() => handleEvent(database, supervisor, "goal", "unknown"), eventsDetail],
      [() => briefing(deps, "goal"), "Objective goal must be open before supervising it"],
      [() => appendNote(database, supervisor, "goal", "Remember"), "Objective goal must be open before writing a note"],
      [() => askPerson(database, supervisor, "goal", "Which?"), "Objective goal must be open before asking a question"],
      [() => recordSupervisorUsage(database, supervisor, "goal", { sessionId: "new" }), "Objective goal must be open before registering supervisor usage"],
    ];
    for (const [operation, detail] of operations) await assert.rejects(operation, refuses(detail));
  } finally { f.tasks.close(); }
});

test("the open-objective guard preserves ordinary refusals for missing or unrecognised states", () => {
  requireOpenObjective("open", "Unused");
  for (const state of [undefined, null, "unknown"]) {
    assert.throws(() => requireOpenObjective(state, "Existing detail"), error => {
      assert.ok(error instanceof TaskStoreError);
      assert.equal(error.reason, "rejected");
      assert.equal(error.message, "Existing detail");
      assert.equal(Object.hasOwn(error, "code"), false);
      assert.equal(Object.hasOwn(error, "state"), false);
      return true;
    });
  }
});
