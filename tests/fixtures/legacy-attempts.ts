import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AttemptLog, type AttemptRef } from "../../src/attempts/log.ts";
import { key } from "../../src/runtime/records.ts";

/** Seeds old files for import and reader tests, without the removed writer's locking or validation. */
export class LegacyAttempts extends AttemptLog {
  directory(ref: AttemptRef): string {
    return join(this.root, "attempts", key(this.contextId), key(ref.taskId), String(ref.attempt));
  }
  async create(taskId: string, data: Record<string, unknown>, previous: number): Promise<AttemptRef> {
    const ref = { contextId: this.contextId, taskId, attempt: previous + 1 };
    await mkdir(this.directory(ref), { recursive: true });
    await this.append(ref, "requested", data);
    return ref;
  }
  async append(ref: AttemptRef, kind: string, data: Record<string, unknown>): Promise<void> {
    const sequence = (await readdir(this.directory(ref))).length;
    await writeFile(join(this.directory(ref), `${String(sequence).padStart(4, "0")}.json`), JSON.stringify({
      version: 1, ...ref, sequence, kind, recordedAt: new Date().toISOString(), data,
    }));
  }
  async reserveRequest(requestId: string, taskId: string): Promise<void> {
    const directory = join(this.root, "request-ids", key(this.contextId));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${key(requestId)}.json`), JSON.stringify({
      version: 1, requestId, taskId, reservedAt: new Date().toISOString(),
    }));
  }
}
