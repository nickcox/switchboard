import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { ApplicationStore } from "../design-a/store.ts";
import type { FakeOwners } from "../scenario/owners.ts";
import { refuse } from "../scenario/contract.ts";
import { DurableScenario, type EngineOptions } from "./engine.ts";
import { Operations, type Options } from "./operations.ts";
import { fixtureDirectory } from "./paths.ts";

export type Endpoint = { port: number; token: string; ownerId: string; pid: number };
export type HostOptions = Options & EngineOptions & { seedTaskIds?: string[]; closeWorkers?: () => Promise<void> };
// Exclusive creation is deliberately not a stale-lock takeover protocol. A crash leaves a claim
// for an operator to inspect and remove only after confirming the old host and workers stopped.
export class ExecutionHost {
  readonly engine: DurableScenario;
  readonly endpoint: Endpoint;
  private readonly server: Server;
  private readonly claimDirectory: string;
  private readonly closeWorkers: (() => Promise<void>) | undefined;
  private closing: Promise<void> | undefined;

  private constructor(engine: DurableScenario, server: Server, endpoint: Endpoint, claimDirectory: string, options: HostOptions) {
    this.engine = engine;
    this.server = server;
    this.endpoint = endpoint;
    this.claimDirectory = claimDirectory;
    this.closeWorkers = options.closeWorkers;
  }

  static async open(directory: string, owners: FakeOwners, options: HostOptions = {}): Promise<ExecutionHost> {
    directory = await fixtureDirectory(directory);
    const hostDirectory = join(directory, "host");
    await mkdir(hostDirectory, { recursive: true });
    const claimDirectory = join(hostDirectory, "owner");
    try { await mkdir(claimDirectory, { mode: 0o700 }); }
    catch (error) {
      throw new Error(`Host ownership unavailable at ${claimDirectory}; inspect the existing claim and confirm host/worker termination before removing it`, { cause: error });
    }
    const ownerId = randomUUID();
    let store: ApplicationStore | undefined;
    let engine: DurableScenario | undefined;
    let server: Server | undefined;
    try {
      await writeFile(join(claimDirectory, "claim.json"), JSON.stringify({ ownerId, pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx", flush: true });
      store = await ApplicationStore.open(hostDirectory);
      if (options.seedTaskIds) await store.seed(options.seedTaskIds);
      engine = await DurableScenario.open(new Operations(store, owners, options), options);
      let host: ExecutionHost;
      const token = randomUUID();
      server = createServer(async (request, response) => {
        response.setHeader("Content-Type", "application/json");
        try {
          if (request.method !== "POST" || request.url !== "/" || request.headers.authorization !== `Bearer ${token}`) {
            response.writeHead(403).end(JSON.stringify(refuse("host_unavailable")));
            return;
          }
          let body = "";
          for await (const chunk of request) {
            body += chunk;
            if (Buffer.byteLength(body) > 65_536) throw new Error("Request exceeds 64 KiB");
          }
          const command = JSON.parse(body);
          let result: unknown;
          if (command.method === "submit") result = await engine!.submit(command.request);
          else if (command.method === "advance" && typeof command.requestId === "string") result = await engine!.advance(command.requestId);
          else if (command.method === "cancel" && typeof command.requestId === "string") result = await engine!.cancel(command.requestId);
          else if (command.method === "inspect") result = await engine!.inspect();
          else if (command.method === "diagnostics") result = await engine!.diagnostics();
          else if (command.method === "shutdown") {
            const leases = await owners.leases().then(list => list.length > 0 ? "retained" : "none", () => "not checked");
            response.end(JSON.stringify({ status: "stopping", workerTermination: "unverified", leases }));
            void host.close().catch(error => { console.error(error); process.exitCode = 1; });
            return;
          } else throw new Error("Unknown host command");
          response.end(JSON.stringify(result));
        } catch (error) {
          response.writeHead(400).end(JSON.stringify({ ...refuse("host_unavailable"), nextAction: `Inspect host request/storage: ${String(error)}` }));
        }
      });
      server.requestTimeout = 15_000;
      server.headersTimeout = 15_000;
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => { server!.off("error", reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No host TCP address");
      const endpoint = { port: address.port, token, ownerId, pid: process.pid };
      await writeFile(join(claimDirectory, "endpoint.json"), JSON.stringify(endpoint), { flag: "wx", flush: true, mode: 0o600 });
      host = new ExecutionHost(engine, server, endpoint, claimDirectory, options);
      return host;
    } catch (error) {
      if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
      if (engine) await engine.close(); else store?.close();
      await rm(claimDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      // First seal transport and join admitted requests. Closing Durable stops orchestration,
      // not external workers. Only the host's adapter can join handles it actually owns.
      await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
      await this.engine.close();
      await this.closeWorkers?.();
      const claim = JSON.parse(await readFile(join(this.claimDirectory, "claim.json"), "utf8"));
      if (claim.ownerId !== this.endpoint.ownerId) throw new Error("Host claim identity changed; retain it for inspection");
      await rm(this.claimDirectory, { recursive: true });
    })();
    return this.closing;
  }
}
