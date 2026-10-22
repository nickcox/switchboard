import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acceptReview, finishWorker, sampleRequest } from "./common-tests.ts";
import type { Point } from "./contract.ts";
import { pauseAt } from "./interruptions.ts";
import { FakeOwners } from "./owners.ts";
import { InProcessScenario } from "./reference.ts";

const [directory, target] = process.argv.slice(2);
if (!directory || !target) throw new Error("Usage: interruption-child.ts <directory> <point>");
const host = join(directory, "host");
await mkdir(host, { recursive: true });
await writeFile(join(host, "canary"), "Disposable execution-host storage\n");
const interrupt = pauseAt(target as Point);
const owners = new FakeOwners(join(directory, "owners"), host, interrupt);
const now = 1_000_000;
const driver = new InProcessScenario(owners, { now: () => now, interrupt });
const fixture = { driver, owners, now, close: async () => {} };
const request = sampleRequest("interruption", target.startsWith("merge:") ? "forge_merge" : "review");
await driver.submit(request);
if (target.startsWith("cancel:") || target.startsWith("cancelled:")) {
  await driver.cancel(request.requestId);
} else {
  await finishWorker(fixture, request);
  await driver.advance(request.requestId);
  await acceptReview(fixture, request);
  await driver.advance(request.requestId);
}
throw new Error(`The scenario did not reach ${target}`);
