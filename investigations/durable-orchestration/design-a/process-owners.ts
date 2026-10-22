import { fork, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Identity, Request, WorkerResult } from "../scenario/contract.ts";
import { FakeOwners } from "../scenario/owners.ts";

function message(child: ChildProcess, type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Worker did not report ${type}`)), 5000);
    const onMessage = (value: unknown) => {
      if (typeof value === "object" && value !== null && "type" in value && value.type === type) finish();
    };
    const onExit = () => finish(new Error(`Worker exited before ${type}`));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", finish);
      if (error) reject(error); else resolve();
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", finish);
  });
}

// Only the worker changes here. Workspace/forge effects and all counters remain the shared fakes.
// This one-worker fixture has no adoption, containment or automatic workspace-return mechanism.
export class ProcessOwners extends FakeOwners {
  private readonly request: Request;
  private child: ChildProcess | undefined;
  private exited: Promise<void> | undefined;
  private workerDirectory: string | undefined;
  private permitExit = false;

  constructor(directory: string, hostDirectory: string, request: Request) {
    super(directory, hostDirectory);
    this.request = request;
  }

  override async launch(identity: Identity): Promise<void> {
    if (this.child) throw new Error("The child fixture permits one launch only");
    await super.launch(identity);
    this.workerDirectory = join(this.directory, "workers", identity.attemptId);
    const child = fork(new URL("./worker-child.ts", import.meta.url), [this.workerDirectory], {
      execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.child = child;
    this.exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        void (async () => {
          if (code === 0 && signal === null && this.permitExit) {
            const result = JSON.parse(await readFile(join(this.workerDirectory!, "result.json"), "utf8")) as WorkerResult;
            await super.exit(result);
          }
        })().then(resolve, reject);
      });
    });
    // Keep an early spawn/storage error observed even before the test joins the worker.
    void this.exited.catch(() => {});
    await message(child, "ready");
  }

  override async prompt(identity: Identity): Promise<void> {
    if (!this.child) throw new Error("No child was launched");
    await super.prompt(identity);
    const resultWritten = message(this.child, "result");
    this.child.send({ type: "prompt", identity, request: this.request });
    await resultWritten;
  }

  async observeExit(): Promise<void> {
    if (!this.child || !this.exited) throw new Error("No child was launched");
    this.permitExit = true;
    this.child.send({ type: "exit" });
    await this.exited;
  }

  async close(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    await this.exited;
  }
}
