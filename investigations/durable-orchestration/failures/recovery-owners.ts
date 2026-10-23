import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApplicationStore } from "../design-a/store.ts";
import { FakeOwners } from "../scenario/owners.ts";
import type { EffectRecord, OwnerControls } from "../scenario/owners.ts";

export type Fault = { mode: "before_return" | "after_intent" | "after_return"; remaining: number };

// Test-only boundary targeting. Host facts choose where to inject, never what an owner reports.
export class RecoveryOwners extends FakeOwners {
  store!: ApplicationStore;
  private async fail(records: EffectRecord[]): Promise<void> {
    let fault: Fault;
    try { fault = JSON.parse(await readFile(join(this.directory, "read-fault.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (fault.remaining <= 0) return;
    const attempt = this.store.list()[0];
    if (!attempt) return;
    const intent = this.store.record(attempt).entries.some(entry => entry.kind === "lease_return_started");
    const returned = records.some(record => record.effect === "return");
    const matches = fault.mode === "before_return" ? attempt.done && !intent
      : fault.mode === "after_intent" ? intent && !returned : returned;
    if (!matches) return;
    await writeFile(join(this.directory, "read-fault.json"), JSON.stringify({ ...fault, remaining: fault.remaining - 1 }), { flush: true });
    throw Object.assign(new Error("Treehouse status failed"), { owner: "Treehouse", detail: "treehouse status --json: exit 1\nstdout: partial listing\nstderr: injected read failure",
      command: "treehouse status --json", stdout: "partial listing", stderr: "injected read failure", exitCode: 1 });
  }
  override async controls(): Promise<OwnerControls> {
    await this.fail(await super.records());
    return super.controls();
  }
  override async forAttempt(attemptId: string): Promise<EffectRecord[]> {
    const records = await super.forAttempt(attemptId);
    await this.fail(records);
    return records;
  }
}
