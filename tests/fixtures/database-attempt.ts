import { AttemptStore } from "../../src/attempts/store.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";

const [path, mode] = process.argv.slice(2);
const tasks = await SqliteTaskStore.open({ path: path! });
const attempts = new AttemptStore(tasks.database, "context");
try {
  if (mode === "reserve") {
    const reservation = await attempts.reserveAttempt({ taskId: "task", requested: { requestId: "request" }, maximum: 2 });
    if (reservation.created) {
      await attempts.append(reservation.ref, "leased", {
        leaseId: "lease", workspace: "/fixture", baseRef: "main", outputBranch: "output", startingCommit: "a".repeat(40),
      });
      await attempts.startReservedTask(reservation.ref);
    }
    console.log(JSON.stringify(reservation));
  } else {
    await tasks.database.transaction(() => {
      if (mode === "crash") {
        tasks.database.run("INSERT INTO attempt_numbers VALUES('context','task',1)");
        tasks.database.run("INSERT INTO attempts(context,task,number,request_id,reserved_at) VALUES('context','task',1,'request',?)", new Date().toISOString());
        tasks.database.run("INSERT INTO attempt_entries VALUES('context','task',1,0,?)", JSON.stringify({
          version: 1, contextId: "context", taskId: "task", attempt: 1, sequence: 0, kind: "requested",
          recordedAt: new Date().toISOString(), data: { requestId: "request" },
        }));
      }
      process.stdout.write("locked\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });
  }
} finally { tasks.close(); }
