import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApplicationStore } from "../design-a/store.ts";
import { SwitchboardScenario } from "../design-a/driver.ts";
import { ProcessOwners } from "../design-a/process-owners.ts";
import { sampleRequest } from "../scenario/common-tests.ts";
import { ExecutionHost } from "../design-b/host.ts";
import { FakeOwners } from "../scenario/owners.ts";
import type { Interrupt, Point, Request } from "../scenario/contract.ts";

const [design, directory, target = "", worker = "fake"] = process.argv.slice(2) as [string, string, string, string];
const interrupt: Interrupt = async point => {
  if (point !== target) return;
  process.send?.({ type: "boundary", point });
  await new Promise<void>(() => {});
};
const owners = worker === "process"
  ? new ProcessOwners(join(directory, "owners"), join(directory, "host"), sampleRequest())
  : new FakeOwners(join(directory, "owners"), join(directory, "host"), interrupt);
const closeWorkers = async () => { if (owners instanceof ProcessOwners) await owners.close(); };
let close: () => Promise<void>;
let store: ApplicationStore;
let driver: SwitchboardScenario | ExecutionHost["engine"];
try {
  if (design === "B") {
    const host = await ExecutionHost.open(directory, owners, { interrupt, manualClock: true, maxAttempts: 2, now: () => 1_000_000, initialNow: Number(process.env.MATRIX_NOW ?? 1_000_000), closeWorkers });
    driver = host.engine;
    store = host.engine.operations.store;
    close = () => host.close();
  } else {
    // A had no context owner in step 4. This fixture host supplies the minimal Phase 3
    // exclusion protocol: exclusive creation, no stale takeover, explicit operator recovery.
    const claim = join(directory, "host", "owner");
    await mkdir(claim, { mode: 0o700 });
    await writeFile(join(claim, "claim.json"), JSON.stringify({ pid: process.pid }), { flag: "wx", flush: true });
    store = await ApplicationStore.open(join(directory, "host"));
    driver = new SwitchboardScenario(store, owners, { interrupt, maxAttempts: 2, now: () => 1_000_000 });
    close = async () => { await driver.close(); await closeWorkers(); await rm(claim, { recursive: true }); };
  }
  // Test transport is separate from B's real host transport. Both accept actual independent
  // CLI clients here; only commands below can alter fixture controls, never worker arguments.
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const command = JSON.parse(body);
      let value: unknown;
      if (command.method === "submit") value = await driver.submit(command.request as Request);
      else if (command.method === "advance") value = await driver.advance(command.requestId);
      else if (command.method === "cancel") value = await driver.cancel(command.requestId);
      else if (command.method === "inspect") value = await driver.inspect();
      else if (command.method === "observeExit" && owners instanceof ProcessOwners) { await owners.observeExit(); value = { status: "observed" }; }
      else if (command.method === "diagnostics" && "diagnostics" in driver) value = await driver.diagnostics();
      else if (command.method === "queryOnly") { await store.tasks.database.transaction(() => store.tasks.database.run("PRAGMA query_only = ON")); value = { status: "read_only" }; }
      else if (command.method === "effect") {
        if (command.effect === "worker_exit") await owners.exit(command.result);
        else if (command.effect === "review") await owners.review(command.attemptId, command.commit, "accepted");
        else if (command.effect === "merge") await owners.merge(command.attemptId, command.commit);
        value = { status: "recorded" };
      } else if (command.method === "pause") { await interrupt(command.point as Point); value = null; }
      else if (command.method === "shutdown") {
        response.end(JSON.stringify({ workerTermination: "unverified", leases: "retained" }));
        server.close();
        await close();
        process.disconnect?.();
        return;
      } else throw new Error("Unknown fixture command");
      response.end(JSON.stringify(value));
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  await writeFile(join(directory, "matrix-endpoint.json"), JSON.stringify({ port: address.port }));
  process.send?.({ type: "ready" });
} catch (error) {
  console.error(String(error));
  process.exitCode = 2;
  process.disconnect?.();
}
