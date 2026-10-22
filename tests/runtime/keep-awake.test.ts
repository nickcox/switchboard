import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { configSchema, loadConfig } from "../../src/config.ts";
import { startKeepAwake, defaultKeepAwakeCommand, type KeepAwake } from "../../src/runtime/keep-awake.ts";
import { RuntimeFailure } from "../../src/runtime/async.ts";
import { WorkerSupervisor, type RuntimeSession } from "../../src/runtime/supervisor.ts";
import type { ChildExit } from "../../src/runtime/records.ts";
import { readActivity } from "../../src/runtime/activity.ts";
import { fixture, resultFor } from "../helpers.ts";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error("Timed out waiting for keep-awake command");
    await sleep(10);
  }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

for (const path of ["reported", "failed", "interrupted", "over_budget", "worker_timeout", "start_failure", "open_failure", "shutdown_failure"]) {
  test(`supervisor holds and releases keep-awake on ${path}`, async () => {
    const f = fixture();
    const marker = join(f.dir, "keep-awake.json");
    const notes: string[] = [];
    let childExit: ChildExit | undefined;
    let resolveExit: (exit: ChildExit) => void;
    const exited = new Promise<ChildExit>(resolve => { resolveExit = resolve; });
    const operator = new AbortController();
    const supervisor = new WorkerSupervisor(f.records, {
      open(binding) {
        assert.ok(notes.some(note => note.startsWith("Keep-awake command started")), "command starts before the worker");
        if (path === "open_failure") throw new Error("Cannot spawn worker");
        const session: RuntimeSession = {
          exited, get childExit() { return childExit; }, failure: undefined, stderrTail: "",
          async start() {
            await until(async () => !!(await readFile(marker, "utf8").catch(() => "")));
            const command = JSON.parse(await readFile(marker, "utf8"));
            assert.equal(command.dispatcher, String(process.pid));
            assert.equal(command.embedded, `parent=${process.pid}/${process.pid}`);
            assert.ok(alive(command.pid), "command runs while the worker runs");
            if (path === "start_failure") throw new Error("Worker could not start");
          },
          async waitForEnd(_ms, signal) {
            if (path === "interrupted") operator.abort();
            if (["interrupted", "over_budget"].includes(path)) {
              await until(() => signal.aborted);
              throw new RuntimeFailure("interrupted", "Stopped");
            }
            if (path === "worker_timeout") throw new RuntimeFailure("worker_timeout", "Too long");
            if (path === "failed") throw new Error("Worker failed");
          },
          async confirmEnd() { await writeFile(binding.resultPath, JSON.stringify(resultFor(f.input))); },
          async usage() { return { cost: 2, tokens: 2 }; },
          async deliver() { return "accepted"; },
          async shutdown() {
            childExit = { started: true, code: 0, signal: null };
            resolveExit(childExit);
            if (path === "shutdown_failure") throw new Error("Shutdown failed");
          },
          async closed() {},
        };
        return session;
      },
    }, {
      keepAwake: { command: [process.execPath, resolve(import.meta.dirname, "../fixtures/keep-awake.ts"), marker, "{pid}", "parent={pid}/{pid}"] },
      requestMs: 1000, runMs: 1000, statsMs: 10, requestPollMs: 1000,
      ...(path === "over_budget" ? { maxCost: 1 } : {}),
    });
    const running = supervisor.execute(f.input, operator.signal, { onActivity: entry => { if (entry.kind === "note") notes.push(entry.text); } });
    if (path === "shutdown_failure") await assert.rejects(running, /Shutdown failed/);
    else {
      const report = await running;
      assert.equal(report.status, path === "reported" ? "reported" : ["interrupted", "over_budget"].includes(path) ? "interrupted" : "failed");
      if (path === "over_budget" || path === "worker_timeout") assert.equal(report.reason, path);
    }
    const pid = Number(/started \(pid (\d+)\)/.exec(notes.find(note => note.startsWith("Keep-awake command started"))!)![1]);
    await until(() => !alive(pid));
    assert.equal(notes.some(note => note.includes("computer may sleep")), false);
  });
}

for (const [name, setting] of [
  ["disabled", false],
  ["missing", { command: ["switchboard-nonexistent-keep-awake-command"] }],
  ["early exit", { command: [process.execPath, "-e", "console.error('Power assertion refused'); process.exit(7)"] }],
] as [string, KeepAwake][]) {
  test(`keep-awake ${name} does not change a worker result`, async () => {
    const f = fixture("delay-exit", { keepAwake: setting });
    const report = await f.worker.execute(f.input);
    assert.equal(report.status, "reported");
    const record = (await f.records.discover(f.input.identity.contextId))[0]!;
    const notes = (await readActivity(record)).filter(entry => entry.kind === "note").map(entry => entry.text);
    if (name === "disabled") assert.equal(notes.some(note => note.includes("Keep-awake")), false);
    else {
      assert.ok(notes.some(note => note.includes("computer may sleep")), notes.join("\n"));
      if (name === "early exit") assert.ok(notes.some(note => note.includes("Power assertion refused")));
    }
  });
}

test("configuration validates the single keepAwake setting when loaded", async () => {
  const f = fixture();
  const config = {
    contextId: "fixture", runtimeRoot: join(f.dir, "runtime"), tasks: { repo: "fixture" },
    workspaces: { repository: f.dir, poolRoot: join(f.dir, "pool") }, delivery: { baseRef: "main" },
    worker: { piEntrypoint: resolve(import.meta.dirname, "../fixtures/pi-rpc.ts"), provider: "fixture", model: "fixture" },
  };
  const file = join(f.dir, "config.json");
  await writeFile(file, JSON.stringify(config));
  assert.equal((await loadConfig(file)).keepAwake, true);
  for (const keepAwake of [true, false, { command: ["custom", "{pid}", ""] }]) {
    await writeFile(file, JSON.stringify({ ...config, keepAwake }));
    assert.deepEqual((await loadConfig(file)).keepAwake, keepAwake);
  }
  for (const keepAwake of [null, "true", [], {}, { command: [] }, { command: [""] }, { command: ["  "] }, { command: ["custom", 2] }, { command: ["custom"], display: true }]) {
    await writeFile(file, JSON.stringify({ ...config, keepAwake }));
    await assert.rejects(loadConfig(file));
  }
  assert.equal(configSchema.shape.keepAwake.parse(undefined), true);
});

test("platform defaults use a dispatcher-bound system assertion, not a display assertion", () => {
  assert.deepEqual(defaultKeepAwakeCommand("darwin"), ["caffeinate", "-i", "-w", "{pid}"]);
  const linux = defaultKeepAwakeCommand("linux")!;
  assert.equal(linux[0], "systemd-inhibit");
  assert.ok(linux.includes("--what=idle:sleep"));
  assert.ok(linux.includes("--why=Switchboard worker running"));
  assert.ok(linux.includes("{pid}"));
  const windows = defaultKeepAwakeCommand("win32")!;
  assert.equal(windows[0], "powershell.exe");
  assert.match(windows.at(-1)!, /SetThreadExecutionState\(\[uint32\]2147483649\)/);
  assert.match(windows.at(-1)!, /Wait-Process -Id \{pid\}/);
});

test("native default starts and stops, or reports the host's inhibitor refusal", async t => {
  const notes: string[] = [];
  const stop = await startKeepAwake(true, note => notes.push(note));
  try {
    await sleep(process.platform === "win32" ? 3000 : 300);
    const warning = notes.find(note => note.includes("computer may sleep"));
    if (warning) {
      // Hosted Linux runners may have no system bus or permission to inhibit sleep.
      assert.equal(process.platform, "linux", warning);
      t.diagnostic(`Native inhibitor not available: ${notes.join("; ")}`);
    } else {
      const pid = Number(/started \(pid (\d+)\)/.exec(notes.find(note => note.includes("command started"))!)![1]);
      assert.ok(alive(pid));
    }
  } finally { await stop(); }
  const started = notes.find(note => note.includes("command started"));
  if (started) await until(() => !alive(Number(/pid (\d+)/.exec(started)![1])));
});
