import { randomUUID } from "node:crypto";
import { Database } from "../database.ts";
import type { RuntimeBinding, ChildExit, ThinkingLevel } from "./records.ts";
import type { ActivityEntry } from "./activity.ts";
import type { ControlRequest, RequestResult } from "./requests.ts";

const ownerStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
const operator = `operator:${process.env.USER ?? process.env.USERNAME ?? "unknown"}`;
export type RuntimeAddress = { directory: string; storage: RuntimeStore; claimId: string };
export type Launch = { context: string; task: string; attempt: number; leaseId: string; directory: string; createdAt: string };
const exists = () => Object.assign(new Error("This attempt already has a launch row"), { code: "EEXIST" });

/** Transactional worker records. No filesystem, provider or worker call happens inside a transaction. */
export class RuntimeStore {
  private readonly source: Database | string;
  constructor(source: Database | string) { this.source = source; }

  private async use<T>(operation: (database: Database) => T | Promise<T>): Promise<T> {
    const database = typeof this.source === "string" ? await Database.open(this.source) : this.source;
    try { return await operation(database); }
    finally { if (typeof this.source === "string") database.close(); }
  }

  async attempt(context: string, leaseId: string): Promise<{ task: string; attempt: number }> {
    return this.use(database => {
      const row = database.get(`SELECT task, attempt FROM attempt_entries WHERE context = ?
        AND json_extract(entry, '$.kind') = 'leased' AND json_extract(entry, '$.data.leaseId') = ?`, context, leaseId);
      if (!row) throw new Error("The launch has no leased attempt");
      return { task: String(row.task), attempt: Number(row.attempt) };
    });
  }

  async claimLaunch(launch: Launch, binding?: RuntimeBinding): Promise<string | undefined> {
    return this.use(database => database.transaction(() => {
      if (database.get("SELECT 1 FROM launches WHERE context = ? AND task = ? AND attempt = ?", launch.context, launch.task, launch.attempt)) {
        if (binding) throw exists();
        return undefined;
      }
      const claimId = binding ? randomUUID() : undefined;
      if (claimId) database.run(`INSERT INTO worker_claims(id,context,task,attempt,owner_pid,owner_started_at,heartbeat_at)
        VALUES(?,?,?,?,?,?,?)`, claimId, launch.context, launch.task, launch.attempt, process.pid, ownerStartedAt, launch.createdAt);
      database.run("INSERT INTO launches VALUES(?,?,?,?,?,?,?,?,?)", launch.context, launch.task, launch.attempt, launch.leaseId,
        launch.createdAt, binding ? "launch" : "fence", launch.directory, binding ? JSON.stringify(binding) : null, claimId ?? null);
      return claimId ?? "fence";
    }));
  }

  async launchKind(context: string, leaseId: string): Promise<"launch" | "fence" | undefined> {
    return this.use(database => database.get("SELECT kind FROM launches WHERE context = ? AND lease_id = ?", context, leaseId)?.kind as "launch" | "fence" | undefined);
  }

  async discover(context: string) {
    return this.use(database => database.all("SELECT * FROM launches WHERE context = ? AND kind = 'launch' ORDER BY created_at, directory", context));
  }

  async observation(directory: string, kind: string): Promise<unknown> {
    return this.use(database => {
      const row = database.get("SELECT value FROM worker_observations WHERE directory = ? AND kind = ?", directory, kind);
      return row ? JSON.parse(String(row.value)) : undefined;
    });
  }

  async recordObservation(directory: string, kind: "exit" | "session_start", value: ChildExit | ThinkingLevel): Promise<void> {
    await this.use(database => database.transaction(() => {
      database.run("INSERT INTO worker_observations VALUES(?,?,?,?)", directory, kind, new Date().toISOString(), JSON.stringify(value));
    }));
  }

  async confirmStopped(directory: string, note?: string): Promise<void> {
    await this.use(database => database.transaction(() => {
      const launch = database.get("SELECT * FROM launches WHERE directory = ? AND kind = 'launch'", directory);
      if (!launch) throw new Error("A stop confirmation requires a launch");
      const binding = JSON.parse(String(launch.binding)) as RuntimeBinding;
      database.run("INSERT INTO confirmations(context,task,attempt,fact,confirmed_by,confirmed_at,scope,note) VALUES(?,?,?,?,?,?,?,?)",
        String(launch.context), String(launch.task), Number(launch.attempt), "worker_stopped", operator, new Date().toISOString(),
        JSON.stringify({ leaseId: binding.input.identity.leaseId, sessionId: binding.input.identity.sessionId }), note ?? null);
    }));
  }

  async stopConfirmation(directory: string): Promise<{ confirmedAt: string; note?: string } | undefined> {
    return this.use(database => {
      const row = database.get(`SELECT c.confirmed_at, c.note FROM confirmations c JOIN launches l
        ON l.context = c.context AND l.task = c.task AND l.attempt = c.attempt
        WHERE l.directory = ? AND c.fact = 'worker_stopped'`, directory);
      return row ? { confirmedAt: String(row.confirmed_at), ...(row.note === null ? {} : { note: String(row.note) }) } : undefined;
    });
  }

  async heartbeat(claimId: string) {
    return this.use(database => database.get("SELECT * FROM worker_claims WHERE id = ?", claimId));
  }

  async refreshClaim(claimId: string): Promise<void> {
    await this.use(database => database.transaction(() => {
      const changed = database.run(`UPDATE worker_claims SET heartbeat_at = ? WHERE id = ? AND owner_pid = ?
        AND owner_started_at = ? AND released_at IS NULL`, new Date().toISOString(), claimId, process.pid, ownerStartedAt);
      if (!changed.changes) throw new Error("The dispatcher no longer owns this claim");
    }));
  }

  async releaseClaim(claimId: string): Promise<void> {
    await this.use(database => database.transaction(() => {
      database.run("UPDATE worker_claims SET released_at = ? WHERE id = ? AND owner_pid = ? AND owner_started_at = ?",
        new Date().toISOString(), claimId, process.pid, ownerStartedAt);
    }));
  }

  async appendActivity(directory: string, entry: ActivityEntry): Promise<void> {
    await this.use(database => database.transaction(() => {
      database.run(`INSERT INTO worker_activity SELECT ?, COALESCE(MAX(sequence), -1) + 1, ?
        FROM worker_activity WHERE directory = ?`, directory, JSON.stringify(entry), directory);
    }));
  }

  async activity(directory: string): Promise<unknown[]> {
    return this.use(database => database.all("SELECT entry FROM worker_activity WHERE directory = ? ORDER BY sequence", directory).map(row => JSON.parse(String(row.entry))));
  }

  async submit(claimId: string, request: ControlRequest): Promise<void> {
    await this.use(database => database.transaction(() => {
      database.run("INSERT INTO control_requests(id,claim_id,request,created_at,sender_pid,sender_started_at) VALUES(?,?,?,?,?,?)",
        request.id, claimId, JSON.stringify(request), request.createdAt, process.pid, ownerStartedAt);
    }));
  }

  async unclaimed(claimId: string): Promise<unknown[]> {
    return this.use(database => database.all("SELECT request FROM control_requests WHERE claim_id = ? AND claimed_by IS NULL ORDER BY created_at, id", claimId)
      .map(row => JSON.parse(String(row.request))));
  }

  async claimRequest(claimId: string, id: string, by: "dispatcher" | "withdrawn"): Promise<boolean> {
    return this.use(database => database.transaction(() => Boolean(database.run(`UPDATE control_requests SET claimed_by = ?, claimed_at = ?
      WHERE id = ? AND claim_id = ? AND claimed_by IS NULL AND
        ((? = 'withdrawn' AND sender_pid = ? AND sender_started_at = ?) OR (? = 'dispatcher' AND EXISTS(
          SELECT 1 FROM worker_claims WHERE id = ? AND owner_pid = ? AND owner_started_at = ? AND released_at IS NULL)))`,
    by, new Date().toISOString(), id, claimId, by, process.pid, ownerStartedAt, by, claimId, process.pid, ownerStartedAt).changes)));
  }

  async recordResult(claimId: string, id: string, result: RequestResult): Promise<void> {
    await this.use(database => database.transaction(() => {
      const changed = database.run(`UPDATE control_requests SET result = ? WHERE id = ? AND claim_id = ? AND claimed_by = 'dispatcher'
        AND result IS NULL AND EXISTS(SELECT 1 FROM worker_claims WHERE id = ? AND owner_pid = ? AND owner_started_at = ?)`,
      JSON.stringify(result), id, claimId, claimId, process.pid, ownerStartedAt);
      if (!changed.changes) throw new Error("The request is not owned by this dispatcher or already has a result");
    }));
  }

  async delivery(claimId: string, id: string) {
    return this.use(database => database.get("SELECT claimed_by, result FROM control_requests WHERE id = ? AND claim_id = ?", id, claimId));
  }
}
