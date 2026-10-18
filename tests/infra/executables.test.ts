import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { onPath } from "../../src/infra/executables.ts";

const executable = process.platform === "win32" ? "tool.exe" : "tool";

function directories() {
  const root = resolve(import.meta.dirname, "../../.investigation/executables-unit");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "case-"));
  const [first, second] = [join(dir, "first"), join(dir, "second")];
  mkdirSync(first);
  mkdirSync(second);
  return { first, second };
}

function withPath<T>(entries: string[], run: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = entries.join(delimiter);
  try { return run(); } finally { process.env.PATH = saved; }
}

test("onPath finds an executable by name, adding .exe on Windows", () => {
  const { first, second } = directories();
  writeFileSync(join(second, executable), "", { mode: 0o755 });
  assert.equal(withPath([first, second], () => onPath("tool")), join(second, executable));
});

test("onPath skips a directory with the executable's name", () => {
  const { first, second } = directories();
  mkdirSync(join(first, executable));
  writeFileSync(join(second, executable), "", { mode: 0o755 });
  assert.equal(withPath([first, second], () => onPath("tool")), join(second, executable));
});

test("onPath ignores a .cmd file, which cannot be started without a shell", { skip: process.platform !== "win32" }, () => {
  const { first } = directories();
  writeFileSync(join(first, "tool.cmd"), "");
  assert.throws(() => withPath([first], () => onPath("tool")), /tool was not found on PATH/);
});

test("onPath reports a missing executable", () => {
  const { first } = directories();
  assert.throws(() => withPath([first], () => onPath("tool")), /tool was not found on PATH/);
});
