import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readJsonFile } from "./records.ts";

const heartbeatSchema = z.strictObject({ version: z.literal(1), at: z.iso.datetime(), pid: z.number().int().positive() });
const freshMs = 30_000;

/** Diagnostic only: absence never proves that the worker has stopped. */
export async function dispatcherRunning(directory: string, now = Date.now()): Promise<boolean> {
  try {
    const heartbeat = heartbeatSchema.parse(await readJsonFile(join(directory, "heartbeat.json"), 1024));
    const age = now - Date.parse(heartbeat.at);
    return age >= 0 && age < freshMs;
  } catch { return false; }
}

/** Refresh while this dispatcher owns the worker; atomically replace so readers never see a partial write. */
export async function startHeartbeat(directory: string, intervalMs = 5000): Promise<() => Promise<void>> {
  const path = join(directory, "heartbeat.json");
  const refresh = async () => {
    const temporary = join(directory, `.heartbeat.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, at: new Date().toISOString(), pid: process.pid }), { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } catch { /* A failed diagnostic write must not affect the worker. */ }
    finally { await unlink(temporary).catch(() => {}); }
  };
  await refresh();
  let pending = Promise.resolve();
  const timer = setInterval(() => { pending = pending.then(refresh); }, intervalMs);
  return async () => {
    clearInterval(timer);
    await pending;
    await unlink(path).catch(() => {});
  };
}
