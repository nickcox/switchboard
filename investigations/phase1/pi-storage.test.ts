import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { command, fixture, object, objects, runDir } from "./helpers.ts";

// These are storage probes with synthetic records, not worker runs or model evidence.
function storage(name: string) {
  const f = fixture(name);
  const workspace = join(f.dir, "workspace");
  const sessions = join(f.dir, "runtime-sessions");
  mkdirSync(workspace);
  const manager = SessionManager.create(workspace, sessions, { id: `probe-${name}` });
  const binding = { version: 1, contextId: "fixture-context", taskId: "fixture-a1", leaseId: "lease-1", sessionId: manager.getSessionId() };
  return { ...f, workspace, sessions, manager, binding };
}

test("Pi metadata alone is not persisted or discoverable before a conversation message", async () => {
  const f = storage("metadata-only");
  f.manager.appendCustomEntry("switchboard.binding.v1", f.binding);
  expect(existsSync(f.manager.getSessionFile()!)).toBe(false);
  expect(await SessionManager.listAll(f.sessions)).toEqual([]);
  appendFileSync(join(runDir, "pi-storage-results.jsonl"), `${JSON.stringify({ test: "metadata-only", sessionId: f.binding.sessionId, persisted: false })}\n`);
});

test("supported Pi session APIs persist binding on a user message and permit discovery in a fresh process", async () => {
  const f = storage("discovery");
  f.manager.appendCustomEntry("switchboard.binding.v1", f.binding);
  f.manager.appendMessage({ role: "user", content: "Synthetic instruction snapshot; no agent executes this", timestamp: Date.now() });
  expect(existsSync(f.manager.getSessionFile()!)).toBe(true);
  const output = await command(f, [process.execPath, join(import.meta.dir, "fixtures/pi-storage-reader.ts"), f.sessions]);
  const discovered = objects(JSON.parse(output.stdout));
  expect(discovered).toHaveLength(1);
  expect(discovered[0]?.id).toBe(f.binding.sessionId);
  expect(discovered[0]?.cwd).toBe(f.workspace);
  const bindingEntry = objects(discovered[0]?.entries).find(entry => entry.type === "custom" && entry.customType === "switchboard.binding.v1");
  expect(bindingEntry?.data).toEqual(f.binding);
});

test("structured custom results survive workspace removal, but session files do not establish process liveness", async () => {
  const f = storage("result-retention");
  f.manager.appendCustomEntry("switchboard.binding.v1", f.binding);
  f.manager.appendMessage({ role: "user", content: "Synthetic storage probe", timestamp: Date.now() });
  const result = { ...f.binding, outcome: "completed", summary: "Synthetic result, not an agent completion", evidence: [{ name: "probe", result: "passed" }], workReferences: [] };
  f.manager.appendCustomEntry("switchboard.result.v1", result);
  rmSync(f.workspace, { recursive: true }); // Only an owned fixture inside this repository.
  const discovered = objects(JSON.parse((await command(f, [process.execPath, join(import.meta.dir, "fixtures/pi-storage-reader.ts"), f.sessions])).stdout));
  const entries = objects(discovered[0]?.entries);
  expect(entries.find(entry => entry.type === "custom" && entry.customType === "switchboard.result.v1")?.data).toEqual(result);
  const header = object(f.manager.getHeader());
  expect(header.pid).toBeUndefined();
  expect(header.liveness).toBeUndefined();
});
