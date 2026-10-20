import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { RuntimeRecords, readJsonFile } from "../../src/runtime/records.ts";
import { fixture } from "../helpers.ts";

const posixOnly = { skip: process.platform === "win32" };

test("reserved identity is discoverable without memory; no exit receipt means unknown, not absent", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input);
  const fresh = new RuntimeRecords(join(f.dir, "runtime"));
  const discovered = await fresh.discover(f.input.identity.contextId);
  assert.equal(discovered.length, 1);
  assert.deepEqual(discovered[0]?.binding.input.identity, f.input.identity);
  assert.equal(discovered[0]?.child.status, "unknown");
  assert.equal(reserved.binding.resultPath.startsWith(f.input.workspace), false);
});

test("one lease cannot launch another session, even after a child-exit observation", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input);
  // Synthetic observed-exit record; no child is started by this unit test.
  await f.records.recordChildExit(reserved, { started: true, code: 0, signal: null });
  await assert.rejects(f.records.reserve({ ...f.input, identity: { ...f.input.identity, sessionId: randomUUID() } }));
  const discovered = await f.records.discover(f.input.identity.contextId);
  assert.equal(discovered[0]?.child.status, "exited");
  const other = { ...f.input, identity: { ...f.input.identity, contextId: "another-context", sessionId: randomUUID() } };
  await f.records.reserve(other);
  assert.equal((await f.records.discover("another-context")).length, 1);
});

test("invalid or incomplete runtime records cause refusal, not an empty inventory", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input);
  await writeFile(join(reserved.directory, "binding.json"), "{partial");
  await assert.rejects(f.records.discover(f.input.identity.contextId));
});

test("stale exit receipts cannot certify another session", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input);
  await f.records.recordChildExit(reserved, { started: true, code: 0, signal: null });
  const path = join(reserved.directory, "child-exit.json");
  const receipt = JSON.parse(await readFile(path, "utf8"));
  receipt.identity.sessionId = randomUUID();
  await writeFile(path, JSON.stringify(receipt));
  await assert.rejects(f.records.discover(f.input.identity.contextId), /Stale/);
});

test("reserve runs its hook after claiming the directory and before writing the binding", async () => {
  const f = fixture();
  let bindingExisted: boolean | undefined;
  await f.records.reserve(f.input, async directory => {
    bindingExisted = await readFile(join(directory, "binding.json")).then(() => true, () => false);
  });
  assert.equal(bindingExisted, false);
  assert.equal((await f.records.discover(f.input.identity.contextId)).length, 1);
});

test("startup observations are write-once and discovery checks their identity", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input);
  assert.equal((await f.records.discover(f.input.identity.contextId))[0]?.thinkingLevel, undefined);
  await f.records.recordSessionStart(reserved, "high");
  await assert.rejects(f.records.recordSessionStart(reserved, "low"));
  assert.equal((await f.records.discover(f.input.identity.contextId))[0]?.thinkingLevel, "high");
  const path = join(reserved.directory, "session-start.json");
  const start = JSON.parse(await readFile(path, "utf8"));
  start.identity.sessionId = randomUUID();
  await writeFile(path, JSON.stringify(start));
  await assert.rejects(f.records.discover(f.input.identity.contextId), /Stale session-start/);
});

test("identity and instruction snapshot text are retained without trimming", async () => {
  const f = fixture();
  const input = { ...f.input, instructions: "  Keep this indentation\n" };
  await f.records.reserve(input);
  assert.equal((await f.records.discover(input.identity.contextId))[0]?.binding.input.instructions, input.instructions);
});

test("a symlinked runtime context cannot redirect evidence into the workspace", posixOnly, async () => {
  const f = fixture();
  const root = join(f.dir, "runtime");
  await mkdir(root);
  const key = createHash("sha256").update(f.input.identity.contextId).digest("hex");
  await symlink(f.input.workspace, join(root, key));
  await assert.rejects(f.records.reserve(f.input), /Unsafe/);
  await assert.rejects(f.records.discover(f.input.identity.contextId), /Unsafe/);
});

test("relative workspace paths are refused rather than resolved through an incidental cwd", async () => {
  const f = fixture();
  await assert.rejects(f.records.reserve({ ...f.input, workspace: "relative" }), /absolute/);
});

test("runtime evidence cannot live under the recyclable workspace", async () => {
  const f = fixture();
  const inside = new RuntimeRecords(join(f.input.workspace, "runtime"));
  await assert.rejects(inside.reserve(f.input), /outside/);
});

test("symlinked JSON results are refused", posixOnly, async () => {
  const f = fixture();
  const file = join(f.dir, "real.json");
  const link = join(f.dir, "link.json");
  await writeFile(file, "{}");
  await symlink(file, link);
  await assert.rejects(readJsonFile(link), /regular/);
  const directory = join(f.dir, "directory");
  await mkdir(directory);
  await assert.rejects(readJsonFile(directory), /regular/);
});

test("an operator stop is recorded once and never overrides an observed exit", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input);
  await f.records.recordOperatorStop(reserved, "Checked by hand");
  const confirmed = (await f.records.discover(f.input.identity.contextId))[0]?.child;
  assert.equal(confirmed?.status, "operator_confirmed_stopped");
  await assert.rejects(f.records.recordOperatorStop(reserved));
  await f.records.recordChildExit(reserved, { started: true, code: 0, signal: null });
  assert.equal((await f.records.discover(f.input.identity.contextId))[0]?.child.status, "exited");
});

test("a JSON read accepts a file at the byte limit and refuses one over it", async () => {
  const f = fixture();
  const path = join(f.dir, "limit.json");
  const value = { text: "x".repeat(5000) };
  await writeFile(path, JSON.stringify(value));
  const size = JSON.stringify(value).length;
  assert.deepEqual(await readJsonFile(path, size), value);
  await assert.rejects(readJsonFile(path, size - 1), /exceeds byte limit/);
  await writeFile(path, "");
  await assert.rejects(readJsonFile(path), SyntaxError);
});
