import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";
import { finish } from "../../src/dispatch/finish.ts";
import { readActivity } from "../../src/runtime/activity.ts";
import { fixture, task } from "./fixture.ts";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for keep-awake command");
    await sleep(10);
  }
}

function assertion(f: Awaited<ReturnType<typeof fixture>>) {
  const marker = join(f.dir, "assertions.jsonl");
  const script = "require('node:fs').appendFileSync(process.argv[1], JSON.stringify({ pid: process.pid, dispatcher: process.argv[2] }) + '\\n'); setInterval(() => { try { process.kill(Number(process.argv[2]), 0); } catch { process.exit(0); } }, 100)";
  f.deps.keepAwake = { command: [process.execPath, "-e", script, marker, "{pid}"] };
  const records = (): { pid: number; dispatcher: string }[] => existsSync(marker) ? readFileSync(marker, "utf8").split("\n").slice(0, -1).map(line => JSON.parse(line)) : [];
  return {
    marker, records,
    async running() {
      await until(() => records().length > 0 && alive(records().at(-1)!.pid));
      const latest = records().at(-1)!;
      assert.equal(latest.dispatcher, String(process.pid));
      assert.ok(alive(latest.pid), "Power assertion is held");
      return latest.pid;
    },
    async stopped() { for (const record of records()) await until(() => !alive(record.pid)); },
  };
}

for (const outcome of ["worker", "acquisition failure", "interruption", "launch failure"] as const) {
  test(`dispatch holds one keep-awake before preflight and through ${outcome}`, async () => {
    const f = await fixture({ tasks: [task("awake-a1")], scenario: "commit-result" });
    const power = assertion(f);
    const controller = new AbortController();
    const roots = f.deps.workspaces.recyclableRoots.bind(f.deps.workspaces);
    f.deps.workspaces.recyclableRoots = async () => {
      await power.running();
      return roots();
    };
    const acquire = f.deps.workspaces.acquire.bind(f.deps.workspaces);
    f.deps.workspaces.acquire = async request => {
      await power.running();
      if (outcome === "acquisition failure") throw new Error("Acquisition timed out");
      if (outcome === "interruption") controller.abort();
      return acquire(request);
    };
    const retention = f.deps.retention;
    f.deps.retention = async request => { await power.running(); return retention(request); };
    if (outcome === "launch failure") f.deps.launch = async () => { await power.running(); throw new Error("Launch failed"); };
    try {
      const result = await dispatchOnce(f.deps, { signal: controller.signal });
      assert.equal(result.ok, false, result.detail ?? "");
      if (outcome === "worker") assert.equal(result.reason, "held");
      assert.equal(power.records().length, 1, "The worker supervisor must share the dispatch assertion");
      await power.stopped();
      if (outcome === "worker") {
        const runtime = (await f.runtime.discover(f.deps.contextId))[0]!;
        const notes = (await readActivity(runtime)).filter(entry => entry.kind === "note").map(entry => entry.text);
        assert.ok(notes.some(note => note.includes(`Keep-awake command started (pid ${power.records()[0]!.pid})`)), notes.join("\n"));
      }
    } finally { f.tasks.close(); }
  });
}

test("dispatch releases keep-awake on preflight refusal", async () => {
  const f = await fixture();
  const power = assertion(f);
  f.deps.workspaces.recyclableRoots = async () => { await power.running(); throw new Error("Owner unavailable"); };
  try {
    assert.equal((await dispatchOnce(f.deps)).ok, false);
    assert.equal(power.records().length, 1);
    await power.stopped();
  } finally { f.tasks.close(); }
});

test("a keep-awake failure before acquisition is replayed into the attempt's activity log", async () => {
  const f = await fixture({ tasks: [task("awake-a1")], scenario: "commit-result" });
  f.deps.keepAwake = { command: ["switchboard-nonexistent-keep-awake-command"] };
  try {
    assert.equal((await dispatchOnce(f.deps)).reason, "held");
    const runtime = (await f.runtime.discover(f.deps.contextId))[0]!;
    const notes = (await readActivity(runtime)).filter(entry => entry.kind === "note").map(entry => entry.text);
    assert.ok(notes.some(note => note.includes("Keep-awake command unavailable; the computer may sleep")), notes.join("\n"));
  } finally { f.tasks.close(); }
});

for (const mode of ["dry run", "disabled"] as const) {
  test(`${mode} starts no dispatch or finish keep-awake`, async () => {
    const f = await fixture({ tasks: [task("awake-a1")], scenario: "commit-result" });
    const power = assertion(f);
    const dryRun = mode === "dry run";
    if (!dryRun) f.deps.keepAwake = false;
    try {
      const dispatched = await dispatchOnce(f.deps, { dryRun });
      assert.equal(dispatched.reason, dryRun ? "dry_run" : "held");
      await finish(f.deps, { leaseId: dispatched.attempt?.leaseId ?? "missing", noProcesses: false, dryRun });
      assert.equal(existsSync(power.marker), false);
      if (!dryRun) {
        const runtime = (await f.runtime.discover(f.deps.contextId))[0]!;
        assert.equal((await readActivity(runtime)).some(entry => entry.kind === "note" && entry.text.includes("Keep-awake")), false);
      }
    } finally { f.tasks.close(); }
  });
}

test("finish holds keep-awake during configured checks and task completion, and releases it on refusal", async () => {
  const f = await fixture({ tasks: [task("awake-a1")], scenario: "commit-result" });
  f.deps.keepAwake = false;
  try {
    const dispatched = await dispatchOnce(f.deps);
    assert.equal(dispatched.reason, "held");
    const power = assertion(f);
    f.deps.checks = [{ name: "power", command: [process.execPath, "-e", `const fs = require('node:fs'); const records = fs.readFileSync(${JSON.stringify(power.marker)}, 'utf8').trim().split('\\n').map(JSON.parse); process.kill(records.at(-1).pid, 0); console.log('Power assertion held during check')`], timeoutMs: 5000 }];
    const recordDone = f.deps.attempts.finishAttempt.bind(f.deps.attempts);
    f.deps.attempts.finishAttempt = async (...args) => { await power.running(); return recordDone(...args); };
    // Wait at the first owner read, before any configured check or owner change.
    const discover = f.runtime.discover.bind(f.runtime);
    f.runtime.discover = async (...args) => { await power.running(); return discover(...args); };
    const finished = await finish(f.deps, { leaseId: dispatched.attempt!.leaseId!, noProcesses: false });
    assert.equal(finished.reason, "finished", finished.detail ?? "");
    assert.equal(finished.checks?.[0]?.status, "passed");
    assert.match(finished.checks![0]!.stdout, /Power assertion held during check/);
    await power.stopped();
    const refused = await finish(f.deps, { leaseId: "missing", noProcesses: false });
    assert.equal(refused.ok, false);
    assert.equal(power.records().length, 2);
    await power.stopped();
  } finally { f.tasks.close(); }
});

for (const operation of ["dispatch", "finish"] as const) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`${operation} releases keep-awake on ${signal}`, { skip: process.platform === "win32" }, async () => {
      const f = await fixture({ tasks: [task("awake-a1")], scenario: operation === "finish" ? "commit-result" : "await-steer" });
      let leaseId: string | undefined;
      if (operation === "finish") {
        f.deps.keepAwake = false;
        leaseId = (await dispatchOnce(f.deps)).attempt!.leaseId!;
      }
      const power = assertion(f);
      const ready = join(f.dir, "ready.json");
      const config = JSON.parse(readFileSync(f.config, "utf8"));
      config.keepAwake = f.deps.keepAwake;
      if (operation === "finish") {
        config.checks = [{ name: "wait", command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid })); const parent = process.ppid; setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 100)`], timeoutMs: 10_000 }];
      }
      writeFileSync(f.config, JSON.stringify(config));
      const args = [resolve("src/cli.ts"), operation, ...(operation === "dispatch" ? ["--once"] : ["--lease", leaseId!]), "--json", "--config", f.config];
      // The check watches its dispatcher so interruption cannot leave a test subprocess behind.
      const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
      let stderr = "";
      child.stdout.resume();
      child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
      const exited = new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
      let checkPid: number | undefined;
      try {
        if (operation === "finish") {
          await until(() => existsSync(ready));
          checkPid = JSON.parse(readFileSync(ready, "utf8")).pid;
        } else await until(() => existsSync(join(f.dir, "requests.jsonl")) && readFileSync(join(f.dir, "requests.jsonl"), "utf8").includes('"type":"prompt"'));
        await until(() => power.records().length > 0);
        assert.ok(alive(power.records()[0]!.pid), stderr);
        child.kill(signal);
        await exited;
        assert.equal(power.records().length, 1);
        await power.stopped();
        if (checkPid) await until(() => !alive(checkPid!));
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        if (checkPid && alive(checkPid)) process.kill(checkPid, "SIGKILL");
        f.tasks.close();
      }
    });
  }
}
