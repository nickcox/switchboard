import { writeSync } from "node:fs";
import { testCaller } from "../caller.ts";
import { createDependencies, loadConfig } from "../../src/config.ts";
import { Database } from "../../src/database.ts";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";

const deps = await createDependencies(await loadConfig(process.argv[2]!), testCaller, { dispatch: true });
const run = Database.prototype.run;
Database.prototype.run = function(sql, ...values) {
  const result = run.call(this, sql, ...values);
  if (sql.startsWith("INSERT INTO attempts(")) {
    writeSync(1, "locked\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return result;
};
await dispatchOnce(deps, { requestId: "crash-reservation" });
throw new Error("The reservation should have been killed");
