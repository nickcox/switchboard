import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { refuse } from "../scenario/contract.ts";
import type { Outcome, Request, ScenarioDriver, Snapshot } from "../scenario/contract.ts";
import type { Endpoint } from "./host.ts";

// No storage handles or worker channels cross this boundary. A lost response is uncertain;
// submit again with the same caller ID, never manufacture a replacement request.
export class HostClient implements ScenarioDriver {
  readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }

  async call(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    try {
      const endpoint = JSON.parse(await readFile(join(this.directory, "host", "owner", "endpoint.json"), "utf8")) as Endpoint;
      if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535 || typeof endpoint.token !== "string") {
        throw new Error("Invalid host endpoint");
      }
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/`, {
        method: "POST", headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ method, ...args }), signal: AbortSignal.timeout(15_000),
      });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(result));
      return result;
    } catch (error) {
      return { ...refuse("host_unavailable"), nextAction: `Inspect host ownership, endpoint and storage; reuse the original request ID: ${String(error)}` };
    }
  }

  async submit(request: Request): Promise<Outcome> { return await this.call("submit", { request }) as Outcome; }
  async advance(requestId: string): Promise<Outcome> { return await this.call("advance", { requestId }) as Outcome; }
  async cancel(requestId: string): Promise<Outcome> { return await this.call("cancel", { requestId }) as Outcome; }
  async inspect(): Promise<Snapshot> {
    const result = await this.call("inspect");
    if (!result || typeof result !== "object" || !("attempts" in result)) throw new Error(JSON.stringify(result));
    return result as Snapshot;
  }
  async wait(requestId: string, timeoutMs = 10_000): Promise<Outcome> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return refuse("invalid_request");
    const deadline = Date.now() + timeoutMs;
    let result: Outcome = refuse("host_unavailable");
    while (Date.now() < deadline) {
      result = await this.advance(requestId);
      if (result.status !== "waiting") return result;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    // A bounded wait ending does not cancel the admitted workflow or pretend it completed.
    return result;
  }
}
