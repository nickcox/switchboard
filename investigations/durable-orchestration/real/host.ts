import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { SwitchboardScenario } from "../design-a/driver.ts";
import { ApplicationStore } from "../design-a/store.ts";
import { ExecutionHost } from "../design-b/host.ts";
import { fixtureDirectory } from "../design-b/paths.ts";
import type { Interrupt, Request } from "../scenario/contract.ts";
import { settingsAt } from "./fixture.ts";
import { RealOwners } from "./owners.ts";

// A has no general host. This small fixture transport adds ownership and lifecycle only;
// submit/advance still run A's unchanged foreground driver. B uses its existing host unchanged.
export async function openHost(directory: string, interrupt?: Interrupt): Promise<{ close(): Promise<void> }> {
  directory = await fixtureDirectory(directory);
  const settings = await settingsAt(directory);
  // Opening this adapter only reads Git. Its runtime database opens on prompt, after the
  // design has acquired exclusive host ownership and recorded its launch fence.
  const owners = await RealOwners.open(directory, settings, interrupt);
  if (settings.design === "B") {
    return ExecutionHost.open(directory, owners, { ...(interrupt ? { interrupt } : {}), closeWorkers: () => owners.close() });
  }
  const claim = join(directory, "host", "owner");
  await mkdir(claim, { mode: 0o700 });
  const ownerId = randomUUID();
  let store: ApplicationStore | undefined;
  let server: Server | undefined;
  try {
    await writeFile(join(claim, "claim.json"), JSON.stringify({ ownerId, pid: process.pid }), { flag: "wx", flush: true });
    store = await ApplicationStore.open(join(directory, "host"));
    const driver = new SwitchboardScenario(store, owners, interrupt ? { interrupt } : {});
    const token = randomUUID();
    let closing: Promise<void> | undefined;
    server = createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json");
      try {
        if (request.method !== "POST" || request.url !== "/" || request.headers.authorization !== `Bearer ${token}`) {
          response.writeHead(403).end(); return;
        }
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 65_536) throw new Error("Request exceeds 64 KiB");
        }
        const command = JSON.parse(body);
        let value: unknown;
        if (command.method === "submit") value = await driver.submit(command.request as Request);
        else if (command.method === "advance") value = await driver.advance(command.requestId);
        else if (command.method === "inspect") value = await driver.inspect();
        else if (command.method === "cancel") value = await driver.cancel(command.requestId);
        else if (command.method === "shutdown") {
          response.end(JSON.stringify({ status: "stopping", workerTermination: "unverified", leases: "retained" }));
          void close().catch(error => { console.error(error); process.exitCode = 1; });
          return;
        } else throw new Error("Unknown host command");
        response.end(JSON.stringify(value));
      } catch (error) { response.writeHead(400).end(JSON.stringify({ error: String(error) })); }
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 15_000;
    const close = (): Promise<void> => closing ??= (async () => {
      await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
      await driver.close();
      await owners?.close();
      const current = JSON.parse(await readFile(join(claim, "claim.json"), "utf8"));
      if (current.ownerId !== ownerId) throw new Error("Host identity changed; retain claim");
      await rm(claim, { recursive: true });
    })();
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => { server!.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No host address");
    await writeFile(join(claim, "endpoint.json"), JSON.stringify({ port: address.port, token, ownerId, pid: process.pid }), { flag: "wx", flush: true, mode: 0o600 });
    return { close };
  } catch (error) {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    store?.close();
    await owners?.close();
    await rm(claim, { recursive: true, force: true });
    throw error;
  }
}
