import { test } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../../src/infra/command.ts";

// Review finding 17: a descendant that inherits the output pipes must not hold runCommand past the command's exit.
test("a command whose descendant keeps its output pipes open still returns soon after the command exits", async () => {
  // The descendant sleeps briefly and then exits on its own, so the test leaves nothing running.
  const script = "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'inherit', detached: true }).unref(); console.log('done')";
  const started = Date.now();
  const result = await runCommand(process.execPath, ["-e", script], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, timeoutMs: 20000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /done/);
  assert.ok(Date.now() - started < 3000, `returned after ${Date.now() - started}ms`);
});

test("captured output is bounded, keeping the end of each stream and saying it was cut", async () => {
  const script = "process.stdout.write('x'.repeat(20 * 1024 * 1024)); process.stdout.write('END')";
  const result = await runCommand(process.execPath, ["-e", script], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, timeoutMs: 20000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length <= 16 * 1024 * 1024, `kept ${result.stdout.length} characters`);
  assert.ok(result.stdout.endsWith("END"));
  const small = await runCommand(process.execPath, ["-e", "console.log('small')"], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, timeoutMs: 20000 });
  assert.equal(small.truncated, false);
});
