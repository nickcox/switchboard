import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { identitySchema, sameIdentity } from "../runtime/contracts.ts";
import { bindingSchema, childExitSchema, isMissing, key, readJsonFile, thinkingLevelSchema, type RuntimeBinding, type RuntimeRecord } from "../runtime/records.ts";

const oldBindingSchema = bindingSchema.extend({ artefactDirectory: z.string().optional() });
const receiptSchema = z.strictObject({ version: z.literal(1), identity: identitySchema, observedAt: z.iso.datetime(), childExit: childExitSchema });
const stopSchema = z.strictObject({ version: z.literal(1), identity: identitySchema, confirmedAt: z.iso.datetime(), note: z.string().max(2000).optional() });
const startSchema = z.strictObject({ version: z.literal(1), identity: identitySchema, observedAt: z.iso.datetime(), thinkingLevel: thinkingLevelSchema });
const heartbeatSchema = z.strictObject({ version: z.literal(1), at: z.iso.datetime(), pid: z.number().int().positive() });
export type LegacyRuntime = {
  directory: string; binding: RuntimeBinding; child: RuntimeRecord["child"]; thinkingLevel?: RuntimeRecord["thinkingLevel"];
  exit?: z.infer<typeof receiptSchema>; stop?: z.infer<typeof stopSchema>;
};
const optionalJson = async (path: string) => readJsonFile(path).catch(error => { if (!isMissing(error)) throw error; return undefined; });
const names = async (path: string) => readdir(path).catch(error => { if (!isMissing(error)) throw error; return []; });

/** Old paths and record forms are understood only by the offline import. */
export async function readLegacyRuntime(root: string, contextId: string) {
  const context = join(root, key(contextId));
  const records: LegacyRuntime[] = [];
  const directories: string[] = [];
  let freshHeartbeat = false;
  let pendingRequest = false;
  for (const name of await names(context)) {
    const directory = join(context, name);
    const entry = await lstat(directory);
    if (!/^[a-f0-9]{64}$/.test(name) || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Uninspectable runtime storage entry");
    directories.push(directory);
    const heartbeatValue = await optionalJson(join(directory, "heartbeat.json"));
    if (heartbeatValue !== undefined) {
      const heartbeat = heartbeatSchema.parse(heartbeatValue);
      const age = Date.now() - Date.parse(heartbeat.at);
      if (age < 30_000) freshHeartbeat = true;
    }
    for (const request of (await names(join(directory, "requests"))).filter(n => n.endsWith(".request.json"))) {
      const base = join(directory, "requests", request.slice(0, -".request.json".length));
      const claim = await optionalJson(`${base}.claim.json`) as { by?: string } | undefined;
      const result = await optionalJson(`${base}.result.json`);
      if (claim?.by !== "withdrawn" && result === undefined) pendingRequest = true;
    }
    const value = await optionalJson(join(directory, "binding.json"));
    if (value === undefined) continue;
    const old = oldBindingSchema.parse(value);
    // Earlier paths may be relative to their runtime directory. Record only canonical current paths from now on.
    const path = (value: string) => resolve(directory, value);
    const binding = bindingSchema.parse({ ...old, resultPath: path(old.resultPath), sessionDirectory: path(old.sessionDirectory),
      artefactDirectory: old.artefactDirectory === undefined ? join(directory, "artefacts") : path(old.artefactDirectory) });
    if (binding.input.identity.contextId !== contextId || key(binding.input.identity.leaseId) !== name ||
      binding.resultPath !== join(directory, "result.json") || binding.sessionDirectory !== join(directory, "sessions") ||
      binding.artefactDirectory !== join(directory, "artefacts")) throw new Error("Runtime binding does not match its storage identity");
    const exitValue = await optionalJson(join(directory, "child-exit.json"));
    const stopValue = await optionalJson(join(directory, "operator-stopped.json"));
    const startValue = await optionalJson(join(directory, "session-start.json"));
    const exit = exitValue === undefined ? undefined : receiptSchema.parse(exitValue);
    const stop = stopValue === undefined ? undefined : stopSchema.parse(stopValue);
    const start = startValue === undefined ? undefined : startSchema.parse(startValue);
    for (const fact of [exit, stop, start]) if (fact && !sameIdentity(fact.identity, binding.input.identity)) throw new Error("Stale runtime observation");
    records.push({ directory, binding, child: exit ? { status: "exited", exit: exit.childExit } : stop ? { status: "operator_confirmed_stopped", confirmedAt: stop.confirmedAt, ...(stop.note ? { note: stop.note } : {}) } : { status: "unknown" },
      ...(exit ? { exit } : {}), ...(stop ? { stop } : {}), ...(start ? { thinkingLevel: start.thinkingLevel } : {}) });
  }
  return { records, directories, freshHeartbeat, pendingRequest };
}
