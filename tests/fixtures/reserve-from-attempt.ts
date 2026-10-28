import { AttemptStore, AttemptStoreError } from "../../src/attempts/store.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";
import { specificationFor } from "../helpers.ts";

const [path, mode, requestId] = process.argv.slice(2);
const tasks = await SqliteTaskStore.open({ path: path! });
const attempts = new AttemptStore(tasks.database, "context");
function boundary() {
  process.stdout.write("boundary\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
try {
  if (mode === "before") boundary();
  const reservation = await attempts.reserveAttempt({
    taskId: "task", requested: { requestId: requestId! }, maximum: 2, maximumPerTask: 2,
    startingPoint: { taskId: "task", attempt: 1 },
    startingPointEvidence: { records: attempts.list(), unknown: [], retainedCommit: "b".repeat(40) },
    specification: (task, ref) => {
      if (mode === "during") boundary();
      return specificationFor(task, ref, { outputBranch: `output-${ref.attempt}` });
    },
  });
  if (mode === "after") boundary();
  console.log(JSON.stringify({ ...reservation, requestId }));
} catch (error) {
  if (!(error instanceof AttemptStoreError)) throw error;
  console.log(JSON.stringify({ reason: error.reason }));
} finally { tasks.close(); }
