import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { bindingSchema, key, writeOnce, type ChildExit, type RuntimeBinding } from "../../src/runtime/records.ts";
import type { WorkerInput } from "../../src/runtime/contracts.ts";

/** Produces the retired file format, only for offline import tests. */
export class LegacyRuntimeFixture {
  private readonly root: string;
  constructor(root: string) { this.root = root; }
  async reserve(input: WorkerInput) {
    const directory = join(this.root, key(input.identity.contextId), key(input.identity.leaseId));
    await mkdir(directory, { recursive: true });
    const binding = bindingSchema.parse({ version: 1, createdAt: new Date().toISOString(), input,
      sessionDirectory: join(directory, "sessions"), artefactDirectory: join(directory, "artefacts"), resultPath: join(directory, "result.json") });
    await writeOnce(join(directory, "binding.json"), binding);
    return { directory, binding };
  }
  async recordChildExit(record: { directory: string; binding: RuntimeBinding }, childExit: ChildExit) {
    await writeOnce(join(record.directory, "child-exit.json"), { version: 1, identity: record.binding.input.identity, observedAt: new Date().toISOString(), childExit });
  }
  async recordOperatorStop(record: { directory: string; binding: RuntimeBinding }, note?: string) {
    await writeOnce(join(record.directory, "operator-stopped.json"), { version: 1, identity: record.binding.input.identity, confirmedAt: new Date().toISOString(), ...(note ? { note } : {}) });
  }
}
