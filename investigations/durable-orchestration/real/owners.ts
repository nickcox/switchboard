import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AttemptStore } from "../../../src/attempts/store.ts";
import type { Config } from "../../../src/config.ts";
import { onPath } from "../../../src/infra/executables.ts";
import { PiWorker, type PiRunReport } from "../../../src/runtime/pi/worker.ts";
import { RuntimeRecords } from "../../../src/runtime/records.ts";
import { SqliteTaskStore } from "../../../src/tasks/sqlite.ts";
import type { Allocation } from "../../../src/workspaces/provider.ts";
import { checkRetention } from "../../../src/workspaces/retention.ts";
import { TreehouseProvider } from "../../../src/workspaces/treehouse.ts";
import { fixtureDirectory } from "../design-b/paths.ts";
import type { Effect, Identity, Interrupt, Request, WorkerResult } from "../scenario/contract.ts";
import { FakeOwners, type EffectRecord, type OwnerControls } from "../scenario/owners.ts";

export type RealSettings = {
  design: "A" | "B";
  request: Request;
  instructions: string;
  baseRef: string;
  worker: Config["worker"];
  keepAwake: Config["keepAwake"];
};
export const environment = (): Record<string, string> => Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));

// The scenario's launch rows contain deliberately synthetic bindings. PiWorker therefore owns a
// separate runtime fixture database, outside host storage, with the actual allocation and input.
// Neither ledger can authorise replay: the designs' intent and PiWorker's launch fence both remain.
export class RealOwners extends FakeOwners {
  readonly provider: TreehouseProvider;
  readonly settings: RealSettings;
  private readonly root: string;
  private tasks: SqliteTaskStore | undefined;
  private readonly stops = new Map<string, AbortController>();
  private readonly runs = new Map<string, Promise<void>>();

  private constructor(root: string, provider: TreehouseProvider, settings: RealSettings, interrupt?: Interrupt) {
    super(join(root, "owners"), join(root, "host"), interrupt);
    this.root = root;
    this.provider = provider;
    this.settings = settings;
  }

  static async open(root: string, settings: RealSettings, interrupt?: Interrupt): Promise<RealOwners> {
    root = await fixtureDirectory(root);
    const provider = await TreehouseProvider.open({ treehouse: onPath("treehouse"), git: onPath("git"),
      repository: join(root, "repository"), poolRoot: join(root, "pool"), fetch: false, environment: environment() });
    return new RealOwners(root, provider, settings, interrupt);
  }

  private workerDirectory(attemptId: string): string { return join(this.directory, "workers", attemptId); }
  async allocation(attemptId: string): Promise<Allocation> {
    return JSON.parse(await readFile(join(this.workerDirectory(attemptId), "allocation.json"), "utf8"));
  }
  async report(attemptId: string): Promise<PiRunReport> {
    return JSON.parse(await readFile(join(this.workerDirectory(attemptId), "report.json"), "utf8"));
  }

  private async receipt(effect: Effect, identity: Identity, result: WorkerResult | null = null): Promise<void> {
    const record: EffectRecord = { id: randomUUID(), effect, attemptId: identity.attemptId, identity,
      result, decision: null, commit: null };
    await writeFile(join(this.directory, "effects", `${record.id}.json`), JSON.stringify(record), { flag: "wx", flush: true });
  }

  override async acquire(contextId: string, taskId: string, attemptId: string): Promise<Identity> {
    await this.interrupt("acquire:effect:before");
    const allocation = await this.provider.acquire({ holder: `durable-${this.settings.design}:${attemptId}`,
      baseRef: this.settings.baseRef, branch: this.settings.request.delivery.outputBranch });
    const identity = { contextId, taskId, attemptId, leaseId: allocation.leaseId, sessionId: randomUUID() };
    await mkdir(this.workerDirectory(attemptId), { recursive: true });
    await writeFile(join(this.workerDirectory(attemptId), "allocation.json"), JSON.stringify(allocation), { flag: "wx", flush: true });
    await this.receipt("acquire", identity);
    await this.interrupt("acquire:effect:after");
    return identity;
  }

  override async launch(identity: Identity): Promise<void> {
    // A receipt is a launch intent, not proof of spawn. Write it before execute can start.
    await super.launch(identity);
  }

  override async prompt(identity: Identity): Promise<void> {
    if (this.runs.has(identity.attemptId)) throw new Error("A worker run already exists; never reprompt");
    const allocation = await this.allocation(identity.attemptId);
    const { request, worker, instructions, baseRef } = this.settings;
    const tasks = this.tasks ??= await SqliteTaskStore.open({ path: join(this.directory, "runtime", "switchboard.db") });
    const records = new RuntimeRecords(join(this.directory, "runtime"), tasks.database);
    const attempts = new AttemptStore(tasks.database, identity.contextId);
    if (!await tasks.read(identity.taskId)) await tasks.add({ id: identity.taskId, title: identity.taskId, body: instructions });
    const reserved = await attempts.reserveAttempt({ taskId: identity.taskId, maximum: 1, requested: {
      requestId: request.requestId, contract: { name: "real-runtime", kind: "code", acceptance: "review_or_integration",
        requiredEvidence: request.delivery.requiredEvidence, requiredDeliverables: request.delivery.requiredDeliverables } } });
    if (!reserved.created) throw new Error("Runtime attempt already reserved; inspect it instead of replaying");
    await attempts.append(reserved.ref, "leased", { leaseId: allocation.leaseId, workspace: allocation.path,
      outputBranch: allocation.branch, baseRef, startingCommit: allocation.startingCommit });
    const stop = new AbortController();
    this.stops.set(identity.attemptId, stop);
    let startedResolve!: () => void;
    let startedReject!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => { startedResolve = resolve; startedReject = reject; });
    let promptReceipt: Promise<void> | undefined;
    const pi = new PiWorker(records, { executable: process.execPath, entrypoint: worker.piEntrypoint,
      provider: worker.provider, model: worker.model, thinking: worker.thinking, shellTool: worker.shellTool,
      runMs: worker.runMs, statsMs: worker.statsMs, maxCost: worker.maxCost, maxTokens: worker.maxTokens,
      keepAwake: this.settings.keepAwake, environment: worker.environment ?? Object.fromEntries(
        ["PATH", "HOME", "USER", "TMPDIR", "LANG", "USERPROFILE", "USERNAME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "SystemRoot", "PATHEXT", "ComSpec"]
          .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]])) });
    const { attemptId: _, ...workerIdentity } = identity;
    const running = (async () => {
      const report = await pi.execute({ identity: workerIdentity, workspace: allocation.path, instructions,
        acceptanceCriteria: [], delivery: { ...request.delivery, baseRef, startingCommit: allocation.startingCommit,
          kind: "code", acceptance: "review_or_integration" } }, stop.signal, {
        onActivity: entry => {
          // This note follows the checked RPC 'started' disposition, not just session startup.
          if (entry.kind === "note" && entry.text === `Worker started (session ${identity.sessionId})`) {
            promptReceipt = super.prompt(identity);
            void promptReceipt.then(startedResolve, startedReject);
          }
        },
      });
      await promptReceipt;
      await writeFile(join(this.workerDirectory(identity.attemptId), "report.json"), JSON.stringify(report), { flag: "wx", flush: true });
      if (report.childExit?.started) {
        const reference = report.result?.workReferences.find(ref => ref.kind === "git" && ref.branch === request.delivery.outputBranch);
        const result: WorkerResult = { identity, outcome: report.result?.outcome ?? "failed",
          branch: request.delivery.outputBranch, commit: reference?.kind === "git" ? reference.commit : "0".repeat(40),
          evidence: report.result?.validationEvidence.map(item => item.name) ?? [],
          deliverables: report.result?.workReferences.map(item => item.name) ?? [] };
        await super.exit(result);
      }
      if (!promptReceipt) startedReject(new Error(`Worker did not start: ${report.reason ?? report.status}`));
    })().catch(error => { startedReject(error); throw error; });
    this.runs.set(identity.attemptId, running);
    void running.catch(() => {});
    await started;
  }

  override async controls(): Promise<OwnerControls> {
    const controls = await super.controls();
    const exits = (await this.records()).filter(record => record.effect === "worker_exit" && record.result?.outcome === "completed");
    if (exits.length !== 1) return { ...controls, clean: false, retainedCommit: null };
    const exit = exits[0]!;
    const allocation = await this.allocation(exit.attemptId);
    const report = await this.report(exit.attemptId);
    const leases = await this.provider.leases();
    const returned = (await this.forAttempt(exit.attemptId)).some(record => record.effect === "return");
    if (!returned && !leases.some(lease => lease.leaseId === allocation.leaseId && lease.holder === allocation.holder &&
      lease.path === allocation.path && lease.branch === allocation.branch)) {
      return { ...controls, unknown: true, clean: false, retainedCommit: null };
    }
    const retention = await checkRetention(onPath("git"), environment(), {
      repository: join(this.root, "repository"), workspace: allocation.path, outputBranch: allocation.branch,
      resultCommit: exit.result!.commit, gitReferences: report.result!.workReferences.filter(ref => ref.kind === "git"),
      artefacts: report.result!.workReferences.filter(ref => ref.kind === "artefact").map(ref => ref.path),
      artefactDirectory: report.binding.artefactDirectory, recyclableRoots: [join(this.root, "pool")],
    });
    return { ...controls, clean: retention.retained, retainedCommit: retention.retained ? exit.result!.commit : null };
  }

  override async returnWorkspace(identity: Identity): Promise<void> {
    await this.interrupt("return:effect:before");
    const controls = await this.controls();
    if (controls.unknown || !controls.clean || !controls.retainedCommit || !controls.approvals.some(approval =>
      approval.by === "operator" && approval.attemptId === identity.attemptId && approval.leaseId === identity.leaseId &&
      approval.commit === controls.retainedCommit && approval.expiresAt > Date.now() && approval.accept && approval.noProcesses)) {
      throw new Error("Real return requires retained output and current scoped accept/no-processes approval");
    }
    const allocation = await this.allocation(identity.attemptId);
    if (allocation.leaseId !== identity.leaseId) throw new Error("Allocation identity differs from the requested return");
    await this.provider.returnLease(allocation, { discardChanges: false });
    await this.receipt("return", identity);
    await this.interrupt("return:effect:after");
  }

  override async cancel(identity: Identity): Promise<void> {
    await super.cancel(identity);
    this.stops.get(identity.attemptId)?.abort();
  }

  async waitForWorker(): Promise<void> { await Promise.all(this.runs.values()); }
  async close(): Promise<void> {
    for (const stop of this.stops.values()) stop.abort();
    try { await this.waitForWorker(); } finally { this.tasks?.close(); }
  }
}
