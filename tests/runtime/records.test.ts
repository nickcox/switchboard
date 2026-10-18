import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { RuntimeRecords, readJsonFile } from "../../src/runtime/records.ts";
import { fixture } from "../helpers.ts";

test("reserved identity is discoverable without memory; no exit receipt means unknown, not absent", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input);
  const fresh = new RuntimeRecords(join(f.dir, "runtime"));
  const discovered = await fresh.discover(f.input.identity.contextId);
  expect(discovered).toHaveLength(1);
  expect(discovered[0]?.binding.input.identity).toEqual(f.input.identity);
  expect(discovered[0]?.child.status).toBe("unknown");
  expect(reserved.binding.resultPath.startsWith(f.input.workspace)).toBe(false);
});

test("one lease cannot launch another session, even after a child-exit observation", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input);
  // Synthetic observed-exit record; no child is started by this unit test.
  await f.records.recordChildExit(reserved, { started: true, code: 0, signal: null });
  await expect(f.records.reserve({ ...f.input, identity: { ...f.input.identity, sessionId: randomUUID() } })).rejects.toThrow();
  const discovered = await f.records.discover(f.input.identity.contextId);
  expect(discovered[0]?.child.status).toBe("exited");
  const other = { ...f.input, identity: { ...f.input.identity, contextId: "another-context", sessionId: randomUUID() } };
  await f.records.reserve(other);
  expect(await f.records.discover("another-context")).toHaveLength(1);
});

test("invalid or incomplete runtime records cause refusal, not an empty inventory", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input);
  await writeFile(join(reserved.directory, "binding.json"), "{partial");
  await expect(f.records.discover(f.input.identity.contextId)).rejects.toThrow();
});

test("stale exit receipts cannot certify another session", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input);
  await f.records.recordChildExit(reserved, { started: true, code: 0, signal: null });
  const path = join(reserved.directory, "child-exit.json");
  const receipt = JSON.parse(await readFile(path, "utf8"));
  receipt.identity.sessionId = randomUUID();
  await writeFile(path, JSON.stringify(receipt));
  await expect(f.records.discover(f.input.identity.contextId)).rejects.toThrow("Stale");
});

test("identity and instruction snapshot text are retained without trimming", async () => {
  const f = fixture();
  const input = { ...f.input, instructions: "  Keep this indentation\n" };
  await f.records.reserve(input);
  expect((await f.records.discover(input.identity.contextId))[0]?.binding.input.instructions).toBe(input.instructions);
});

test.skipIf(process.platform === "win32")("a symlinked runtime context cannot redirect evidence into the workspace", async () => {
  const f = fixture();
  const root = join(f.dir, "runtime");
  await mkdir(root);
  const key = createHash("sha256").update(f.input.identity.contextId).digest("hex");
  await symlink(f.input.workspace, join(root, key));
  await expect(f.records.reserve(f.input)).rejects.toThrow("Unsafe");
  await expect(f.records.discover(f.input.identity.contextId)).rejects.toThrow("Unsafe");
});

test("relative workspace paths are refused rather than resolved through an incidental cwd", async () => {
  const f = fixture();
  await expect(f.records.reserve({ ...f.input, workspace: "relative" })).rejects.toThrow("absolute");
});

test("runtime evidence cannot live under the recyclable workspace", async () => {
  const f = fixture();
  const inside = new RuntimeRecords(join(f.input.workspace, "runtime"));
  await expect(inside.reserve(f.input)).rejects.toThrow("outside");
});

test.skipIf(process.platform === "win32")("symlinked JSON results are refused", async () => {
  const f = fixture();
  const file = join(f.dir, "real.json");
  const link = join(f.dir, "link.json");
  await writeFile(file, "{}");
  await symlink(file, link);
  await expect(readJsonFile(link)).rejects.toThrow("regular");
  const directory = join(f.dir, "directory");
  await mkdir(directory);
  await expect(readJsonFile(directory)).rejects.toThrow("regular");
});
