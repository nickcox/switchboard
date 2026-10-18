// Child process for the cross-process exclusive-creation test. Waits for a start file so the children race.
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { AttemptConflict, AttemptLog } from "../../src/attempts/log.ts";

const [root, contextId, taskId, go] = process.argv.slice(2);
while (!existsSync(go!)) await sleep(5);
try {
  await new AttemptLog(root!, contextId!).create(taskId!, {}, 0);
  console.log("created");
} catch (error) {
  console.log(error instanceof AttemptConflict ? "conflict" : `error: ${String(error)}`);
}
