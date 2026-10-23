import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ApplicationStore } from "../design-a/store.ts";
import { completedResult, assertRefused } from "../scenario/assertions.ts";
import { sampleRequest } from "../scenario/common-tests.ts";
import type { Outcome, Snapshot } from "../scenario/contract.ts";
import { FakeOwners } from "../scenario/owners.ts";
import { ownerReadLimit } from "../scenario/recovery.ts";
import type { Fault } from "./recovery-owners.ts";

const root = fileURLToPath(new URL("../../../.investigation/durable-orchestration/", import.meta.url));
const hostFile = fileURLToPath(new URL("./host-child.ts", import.meta.url));
const now = 1_000_000;
type Host = { child: ChildProcess; exited: Promise<void>; ready: Promise<void> };
function start(directory: string, design: string): Host {
  const child = fork(hostFile, [design, directory, "", "recovery"], { execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  child.stdout!.on("data", data => { output += data; });
  child.stderr!.on("data", data => { output += data; });
  const exited = new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
  const ready = new Promise<void>((resolve, reject) => {
    child.on("message", message => { if ((message as { type: string }).type === "ready") resolve(); });
    child.once("exit", () => reject(new Error(`Host exited before ready: ${output}`)));
    child.once("error", reject);
  });
  return { child, exited, ready };
}
async function kill(host: Host) {
  if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill("SIGKILL");
  await host.exited;
}
async function call<T = Outcome>(directory: string, command: object): Promise<T> {
  const endpoint = JSON.parse(await readFile(join(directory, "matrix-endpoint.json"), "utf8"));
  const response = await fetch(`http://127.0.0.1:${endpoint.port}`, { method: "POST", body: JSON.stringify(command), signal: AbortSignal.timeout(12_000) });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value as T;
}

for (const design of ["A", "B"]) for (let repeat = 1; repeat <= 3; repeat++) {
  for (const scenario of ["retry", "restart", "after_intent", "after_return", "persistent"] as const) {
    test(`${design} classified recovery ${scenario} – repeat ${repeat}`, async t => {
      await mkdir(root, { recursive: true });
      const directory = await mkdtemp(join(root, "classified-recovery-"));
      const hosts: Host[] = [];
      t.after(async () => { for (const host of hosts) await kill(host); await rm(directory, { recursive: true, force: true }); });
      const owners = new FakeOwners(join(directory, "owners"), join(directory, "host"));
      await owners.initialise();
      const store = await ApplicationStore.open(join(directory, "host"));
      const request = sampleRequest();
      await store.seed([request.taskId]);
      store.close();
      const host = start(directory, design); hosts.push(host); await host.ready;
      assert.equal((await call(directory, { method: "submit", request })).status, "waiting");
      const attempt = (await call<Snapshot>(directory, { method: "inspect" })).attempts[0]!;
      const result = completedResult(attempt);
      await owners.exit(result);
      await owners.review(attempt.id, result.commit, "accepted");
      const approval = { id: "approval", by: "operator" as const, attemptId: attempt.id, leaseId: attempt.identity!.leaseId,
        commit: result.commit, expiresAt: now + 100_000, accept: true, noProcesses: true };
      const controls = { ...await owners.controls(), retainedCommit: result.commit, approvals: [approval] };
      await owners.setControls(controls);
      const fault: Fault = { mode: scenario === "after_intent" || scenario === "after_return" ? scenario : "before_return",
        remaining: scenario === "persistent" ? 10 : 1 };
      const faultPath = join(owners.directory, "read-fault.json");
      await writeFile(faultPath, JSON.stringify(fault), { flush: true });
      const advance = () => call(directory, { method: "advance", requestId: request.requestId });
      const first = await advance();
      const uncertain = scenario === "after_intent" || scenario === "after_return";
      assertRefused(first, uncertain ? "finalisation_uncertain" : "owner_unknown");
      assert.match(first.status === "refused" ? first.nextAction : "", /Treehouse.*partial listing.*injected read failure/s);
      let sleep: unknown;
      if (scenario === "restart") {
        if (design === "B") {
          const diagnostic = await call<{ engine: { tasks: { record: { state: { status: string; until: number; checkpoint: { phase: string } } } }[] } }>(directory, { method: "diagnostics" });
          sleep = diagnostic.engine.tasks[0]!.record.state;
          assert.equal((sleep as { status: string }).status, "sleeping");
          assert.equal((sleep as { checkpoint: { phase: string } }).checkpoint.phase, "return");
        }
        await kill(host);
        assert.equal(host.child.signalCode, "SIGKILL");
        // Explicit disposable-fixture recovery only, after joining the old host; no workers exist.
        await rm(join(directory, "host", "owner"), { recursive: true });
        const reopened = start(directory, design); hosts.push(reopened); await reopened.ready;
        if (design === "B") {
          const diagnostic = await call<{ engine: { tasks: { record: { state: unknown } }[] } }>(directory, { method: "diagnostics" });
          assert.deepEqual(diagnostic.engine.tasks[0]!.record.state, sleep);
        }
      }
      let outcome = first;
      if (uncertain) {
        for (let i = 0; i < 3; i++) assertRefused(await advance(), "finalisation_uncertain");
      } else if (scenario === "persistent") {
        for (let i = 1; i < ownerReadLimit; i++) outcome = await advance();
        assertRefused(outcome, "owner_unknown");
        assert.match(outcome.status === "refused" ? outcome.nextAction : "", /Treehouse.*after 3 attempts/);
        await writeFile(faultPath, JSON.stringify({ ...fault, remaining: 0 }), { flush: true });
        assertRefused(await advance(), "owner_unknown");
      } else {
        // The approval was valid on the failed read. Expire it before retry: a saved phase is not authority.
        await owners.setControls({ ...controls, approvals: [{ ...approval, expiresAt: now }] });
        assertRefused(await advance(), "approval_required");
        assert.equal((await owners.counters(attempt.id)).return, 0);
        await owners.setControls(controls);
        outcome = await advance();
        assert.equal(outcome.status, "completed");
        assert.equal((await advance()).status, "completed");
      }
      const failures = await call<{ name: string; value: { kind: string; owner: string; diagnostics: { stdout: string; stderr: string } } }[]>(directory, { method: "readFailures" });
      const reads = failures.filter(row => row.name.startsWith("owner_read_failure:"));
      assert.equal(reads.length, scenario === "persistent" ? ownerReadLimit : 1);
      for (const row of reads) {
        assert.equal(row.value.kind, uncertain ? "effect_uncertain" : "owner_read");
        assert.equal(row.value.owner, "Treehouse");
        assert.equal(row.value.diagnostics.stdout, "partial listing");
        assert.equal(row.value.diagnostics.stderr, "injected read failure");
      }
      const counts = await owners.counters(attempt.id);
      assert.equal(counts.return, scenario === "after_return" || scenario === "retry" || scenario === "restart" ? 1 : 0);
      for (const effect of ["acquire", "launch", "prompt"] as const) assert.equal(counts[effect], 1);
      console.log(JSON.stringify({ experiment: "classified-recovery", design, scenario, repeat, outcome, counts, sleep, failures }));
    });
  }
}
