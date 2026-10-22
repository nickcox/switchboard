import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Attempt, Effect, Identity, Interrupt, WorkerResult } from "./contract.ts";
import { uninterrupted } from "./contract.ts";

export type EffectRecord = {
  id: string;
  effect: Effect;
  attemptId: string;
  identity: Identity | null;
  result: WorkerResult | null;
  decision: "accepted" | "rejected" | null;
  commit: string | null;
};
export type Approval = {
  id: string;
  by: "operator";
  attemptId: string;
  leaseId: string;
  commit: string;
  expiresAt: number;
  accept: boolean;
  noProcesses: boolean;
};
export type OwnerControls = {
  ready: boolean;
  unknown: boolean;
  clean: boolean;
  retainedCommit: string | null;
  approvals: Approval[];
};

function contains(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

// All paths are supplied by the test fixture, never by worker output or a request.
export class FakeOwners {
  readonly directory: string;
  readonly interrupt: Interrupt;

  constructor(directory: string, hostDirectory: string, interrupt: Interrupt = uninterrupted) {
    if (contains(hostDirectory, directory) || contains(directory, hostDirectory)) {
      throw new Error("Owner evidence and execution-host storage must be disjoint directories");
    }
    this.directory = resolve(directory);
    this.interrupt = interrupt;
  }

  async initialise(): Promise<void> {
    await mkdir(join(this.directory, "effects"), { recursive: true });
    await this.setControls({ ready: true, unknown: false, clean: true, retainedCommit: null, approvals: [] });
  }

  async setControls(controls: OwnerControls): Promise<void> {
    const temporary = join(this.directory, `controls-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(controls), { flag: "wx", flush: true });
    await rename(temporary, join(this.directory, "controls.json"));
  }

  async controls(): Promise<OwnerControls> {
    return JSON.parse(await readFile(join(this.directory, "controls.json"), "utf8"));
  }

  async records(): Promise<EffectRecord[]> {
    const names = (await readdir(join(this.directory, "effects"))).filter(name => name.endsWith(".json"));
    return Promise.all(names.map(async name => JSON.parse(await readFile(join(this.directory, "effects", name), "utf8"))));
  }

  async forAttempt(attemptId: string): Promise<EffectRecord[]> {
    return (await this.records()).filter(record => record.attemptId === attemptId);
  }

  async counters(attemptId: string): Promise<Record<Effect, number>> {
    const records = await this.forAttempt(attemptId);
    return Object.fromEntries(["acquire", "launch", "prompt", "worker_exit", "review", "merge", "return", "cancel"]
      .map(effect => [effect, records.filter(record => record.effect === effect).length])) as Record<Effect, number>;
  }

  // Each invocation leaves a new receipt. Deliberately do not deduplicate unsafe adapter calls:
  // otherwise assertions could miss an execution design issuing the same effect twice.
  private async effect(effect: Effect, attemptId: string, details: Partial<EffectRecord> = {}): Promise<EffectRecord> {
    await this.interrupt(`${effect}:effect:before`);
    const record: EffectRecord = {
      id: randomUUID(), effect, attemptId, identity: null, result: null, decision: null, commit: null, ...details,
    };
    await writeFile(join(this.directory, "effects", `${record.id}.json`), JSON.stringify(record), { flag: "wx", flush: true });
    await this.interrupt(`${effect}:effect:after`);
    return record;
  }

  async acquire(contextId: string, taskId: string, attemptId: string): Promise<Identity> {
    const identity = { contextId, taskId, attemptId, leaseId: randomUUID(), sessionId: randomUUID() };
    await this.effect("acquire", attemptId, { identity });
    return identity;
  }

  async launch(identity: Identity): Promise<void> {
    await this.effect("launch", identity.attemptId, { identity });
  }

  async prompt(identity: Identity): Promise<void> {
    await this.effect("prompt", identity.attemptId, { identity });
  }

  async exit(result: WorkerResult): Promise<void> {
    await this.effect("worker_exit", result.identity.attemptId, { identity: result.identity, result });
  }

  async review(attemptId: string, commit: string, decision: "accepted" | "rejected"): Promise<void> {
    await this.effect("review", attemptId, { commit, decision });
  }

  // A test/operator drives this simulated forge transition, never an orchestration design.
  async merge(attemptId: string, commit: string): Promise<void> {
    await this.effect("merge", attemptId, { commit });
  }

  async returnWorkspace(identity: Identity): Promise<void> {
    await this.effect("return", identity.attemptId, { identity });
  }

  async cancel(identity: Identity): Promise<void> {
    await this.effect("cancel", identity.attemptId, { identity });
  }
}

export function approvalFor(attempt: Attempt, now: number, controls: OwnerControls): Approval | undefined {
  return controls.approvals.find(approval => approval.by === "operator" && approval.attemptId === attempt.id &&
    approval.leaseId === attempt.identity?.leaseId && approval.commit === attempt.result?.commit &&
    approval.expiresAt > now && approval.accept);
}
