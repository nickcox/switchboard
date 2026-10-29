import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { requireScope } from "../../src/dispatch/safety.ts";
import { ObjectiveStore, defaultPermissions } from "../../src/objectives/store.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";

const person = { kind: "person", id: "operator:creator" } as const;
const supervisor = { kind: "supervisor", objectiveId: "goal" } as const;
const root = resolve(".investigation/scope");
mkdirSync(root, { recursive: true });

test("scope permits people always and supervisors only for their existing objective and its current tasks, without reading permissions", async () => {
  const tasks = await SqliteTaskStore.open({ caller: person, path: join(mkdtempSync(join(root, "case-")), "switchboard.db") });
  const database = tasks.database;
  try {
    const objectives = new ObjectiveStore(database, person);
    for (const id of ["goal", "other"]) await objectives.add({ id, request: "Work", acceptanceCriteria: ["Useful output"] });
    await tasks.add({ id: "own", title: "Own task", objectiveId: "goal" });
    await tasks.add({ id: "foreign", title: "Foreign task", objectiveId: "other" });
    await tasks.add({ id: "unlinked", title: "Unlinked task" });
    await objectives.update("goal", { permissions: Object.fromEntries(Object.keys(defaultPermissions).map(key => [key, false])) as typeof defaultPermissions });
    assert.doesNotThrow(() => requireScope(database, supervisor, { objectiveId: "goal" }));
    assert.doesNotThrow(() => requireScope(database, supervisor, { taskId: "own" }));
    for (const options of [{}, { objectiveId: null }, { objectiveId: "other" }, { objectiveId: "missing" },
      { taskId: "foreign" }, { taskId: "unlinked" }, { taskId: "missing" }, { taskId: "foreign", objectiveId: "goal" }]) {
      assert.throws(() => requireScope(database, supervisor, options), /outside_objective/);
      assert.doesNotThrow(() => requireScope(database, person, options));
    }
    assert.throws(() => requireScope(database, { kind: "supervisor", objectiveId: "missing" }, { objectiveId: "missing" }), /outside_objective/);
    await tasks.update("own", { objectiveId: "other" });
    assert.throws(() => requireScope(database, supervisor, { taskId: "own" }), /outside_objective/);

    // Scope does not depend on any fields in the permissions record.
    await database.transaction(() => database.run("UPDATE objectives SET permissions = '{}' WHERE id = 'goal'"));
    assert.doesNotThrow(() => requireScope(database, supervisor, { objectiveId: "goal" }));
    assert.doesNotThrow(() => requireScope(database, person));
  } finally { tasks.close(); }
});
