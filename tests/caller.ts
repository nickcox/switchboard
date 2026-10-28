import type { Caller } from "../src/caller.ts";
import { AttemptStore as ApplicationAttemptStore } from "../src/attempts/store.ts";
import { ObjectiveStore as ApplicationObjectiveStore } from "../src/objectives/store.ts";
import { SqliteTaskStore as ApplicationTaskStore } from "../src/tasks/sqlite.ts";
import { createDependencies as openDependencies } from "../src/config.ts";
import { importAttempts as migrateAttempts, importRuntime as migrateRuntime } from "../src/attempts/import.ts";
import { importTasks as migrateTasks } from "../src/tasks/import.ts";

/** Existing fixtures run as this person; authority tests supply their own host callers. */
export const testCaller: Caller = { kind: "person", id: "operator:test" };
export class AttemptStore extends ApplicationAttemptStore {
  constructor(database: ConstructorParameters<typeof ApplicationAttemptStore>[0], contextId: string, caller = testCaller) {
    super(database, contextId, caller);
  }
}
export class ObjectiveStore extends ApplicationObjectiveStore {
  constructor(database: ConstructorParameters<typeof ApplicationObjectiveStore>[0], actor: string) {
    super(database, { kind: "person", id: actor });
  }
}
export type SqliteTaskStore = ApplicationTaskStore;
export const SqliteTaskStore = {
  prototype: ApplicationTaskStore.prototype,
  open: (options: Omit<Parameters<typeof ApplicationTaskStore.open>[0], "caller">) => ApplicationTaskStore.open({ ...options, caller: testCaller }),
};
export const createDependencies = (config: Parameters<typeof openDependencies>[0], options?: Parameters<typeof openDependencies>[2]) => openDependencies(config, testCaller, options);
export const importAttempts = (config: Parameters<typeof migrateAttempts>[0]) => migrateAttempts(config, testCaller);
export const importRuntime = (config: Parameters<typeof migrateRuntime>[0]) => migrateRuntime(config, testCaller);
export const importTasks = (config: Parameters<typeof migrateTasks>[0], backlog: string, archive?: string) => migrateTasks(config, testCaller, backlog, archive);
export { AttemptStoreError } from "../src/attempts/store.ts";
export { defaultPermissions, type CompletionStatement } from "../src/objectives/store.ts";
