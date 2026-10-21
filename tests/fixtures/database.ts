import { writeSync } from "node:fs";
import { Database } from "../../src/database.ts";

const db = await Database.open(process.argv[2]!);
await db.transaction(() => {
  db.run("UPDATE tasks SET title = 'Uncommitted' WHERE id = 'a'");
  writeSync(1, "locked\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
