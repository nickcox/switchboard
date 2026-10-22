import assert from "node:assert/strict";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ApplicationStore } from "../design-a/store.ts";
import { sampleRequest } from "../scenario/common-tests.ts";
import { interruptionPoints, type Attempt, type Outcome, type Snapshot, type WorkerResult } from "../scenario/contract.ts";
import { FakeOwners } from "../scenario/owners.ts";

const root = fileURLToPath(new URL("../../../.investigation/durable-orchestration/", import.meta.url));
const hostFile = fileURLToPath(new URL("./host-child.ts", import.meta.url));
const clientFile = fileURLToPath(new URL("./client.ts", import.meta.url));
const repeats = Number(process.env.MATRIX_REPEATS ?? 3);
assert.ok(Number.isInteger(repeats) && repeats > 0);
const report = process.env.MATRIX_REPORT ?? join(root, "matrix-results.jsonl");
const commit = "a".repeat(40);
const now = 1_000_000;

type Host = { child: ChildProcess; exited: Promise<{ code: number | null; signal: string | null }>; messages: unknown[]; output: () => string };
function start(directory: string, design: string, point = "", worker = "fake", initialNow = now): Host {
  const child = fork(hostFile, [design, directory, point, worker], { execArgv: [], env: { ...process.env, MATRIX_NOW: String(initialNow) }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  child.stdout!.on("data", data => { output += data; });
  child.stderr!.on("data", data => { output += data; });
  const messages: unknown[] = [];
  child.on("message", value => messages.push(value));
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal })); child.once("error", reject);
  });
  return { child, exited, messages, output: () => output };
}
async function until(host: Host, type: string): Promise<void> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    if (host.messages.some(value => (value as { type: string }).type === type)) return;
    if (host.child.exitCode !== null || host.child.signalCode !== null) throw new Error(`Host exited: ${host.output()}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`No ${type}: ${host.output()}`);
}
async function kill(host: Host): Promise<void> {
  if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill("SIGKILL");
  await host.exited;
}
async function call<T = Outcome>(directory: string, command: object): Promise<T> {
  const { port } = JSON.parse(await readFile(join(directory, "matrix-endpoint.json"), "utf8"));
  const response = await fetch(`http://127.0.0.1:${port}`, { method: "POST", body: JSON.stringify(command), signal: AbortSignal.timeout(12_000) });
  const value = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value as T;
}
function cli(directory: string, command: object): Promise<Outcome> {
  return new Promise((resolve, reject) => execFile(process.execPath, [clientFile, directory, JSON.stringify(command)], { timeout: 18_000 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${error}: ${stderr}`)); else {
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    }
  }));
}
async function fixture() {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "matrix-"));
  const owners = new FakeOwners(join(directory, "owners"), join(directory, "host"));
  await owners.initialise();
  const store = await ApplicationStore.open(join(directory, "host"));
  await store.seed(["request-1", "one", "two", "three"].map(id => `task-${id}`));
  store.close();
  return { directory, owners };
}
function result(attempt: Attempt): WorkerResult {
  assert.ok(attempt.identity);
  return { identity: attempt.identity, outcome: "completed", branch: attempt.request.delivery.outputBranch, commit,
    evidence: attempt.request.delivery.requiredEvidence, deliverables: attempt.request.delivery.requiredDeliverables };
}
async function snapshot(directory: string): Promise<Snapshot> { return call(directory, { method: "inspect" }); }
async function approve(owners: FakeOwners, attempt: Attempt, expiresAt = now + 100_000) {
  await owners.setControls({ ...await owners.controls(), retainedCommit: commit, approvals: [{ id: "operator-approval", by: "operator",
    attemptId: attempt.id, leaseId: attempt.identity!.leaseId, commit, expiresAt, accept: true, noProcesses: true }] });
}
async function countersSafe(owners: FakeOwners, state: Snapshot) {
  assert.ok(state.active <= state.maxAttempts);
  assert.equal(new Set(state.attempts.map(attempt => attempt.request.requestId)).size, state.attempts.length);
  const counts = [];
  // Include orphan acquisitions whose acknowledgement was lost, not only recorded identities.
  const ids = new Set([...state.attempts.map(attempt => attempt.id), ...(await owners.records()).map(record => record.attemptId)]);
  for (const id of ids) {
    const count = await owners.counters(id);
    for (const effect of ["acquire", "launch", "prompt", "return", "cancel"] as const) assert.ok(count[effect] <= 1, `${id}: duplicate ${effect}`);
    if (count.return) assert.ok(state.attempts.find(attempt => attempt.id === id)?.done);
    counts.push({ id, ...count });
  }
  return counts;
}
async function record(value: object) {
  await mkdir(root, { recursive: true });
  await appendFile(report, JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, ...value }) + "\n", { flush: true });
}

for (const design of ["A", "B"]) for (let repeat = 1; repeat <= repeats; repeat++) {
  for (const point of interruptionPoints) test(`${design} crash ${point} repeat ${repeat}`, async t => {
    const { directory, owners } = await fixture();
    const hosts: Host[] = [];
    t.after(async () => { for (const host of hosts) await kill(host); await rm(directory, { recursive: true, force: true }); });
    const host = start(directory, design, point); hosts.push(host); await until(host, "ready");
    const request = sampleRequest();
    if (point.startsWith("merge:")) request.delivery.acceptance = "forge_merge";
    let pending: Promise<unknown>;
    const submitBoundary = /^(reserved|workspace|started|launched|prompted):ack:|^(acquire|launch|prompt):effect:/.test(point);
    if (submitBoundary) pending = call(directory, { method: "submit", request });
    else {
      assert.equal((await call(directory, { method: "submit", request })).status, "waiting");
      const attempt = (await snapshot(directory)).attempts[0]!;
      if (point.startsWith("cancel")) pending = call(directory, { method: "cancel", requestId: request.requestId });
      else if (point.startsWith("worker_exit:")) pending = call(directory, { method: "effect", effect: "worker_exit", result: result(attempt) });
      else {
        await owners.exit(result(attempt));
        if (point.startsWith("result:")) pending = call(directory, { method: "advance", requestId: request.requestId });
        else {
          assert.equal((await call(directory, { method: "advance", requestId: request.requestId })).status, "waiting");
          await approve(owners, attempt);
          if (/^(review|merge):effect:/.test(point)) pending = call(directory, { method: "effect", effect: point.split(":")[0], attemptId: attempt.id, commit });
          else {
            await owners.review(attempt.id, commit, "accepted");
            pending = call(directory, { method: "advance", requestId: request.requestId });
          }
        }
      }
    }
    // Observe transport rejection immediately, even if the process dies before reaching the marker.
    const settled = pending.catch(error => ({ transportLost: String(error) }));
    await until(host, "boundary");
    const before = await owners.records();
    await kill(host);
    assert.equal((await host.exited).signal, "SIGKILL");
    await settled;
    const blocked = start(directory, design); hosts.push(blocked);
    assert.equal((await blocked.exited).code, 2, "A crashed owner must exclude a replacement until operator action");
    // Explicit fixture-operator action: old host joined, fake worker has no process. Never
    // apply this removal to Treehouse or a production claim, or infer worker termination.
    await rm(join(directory, "host", "owner"), { recursive: true });
    const recovered = start(directory, design); hosts.push(recovered); await until(recovered, "ready");
    let outcome = await call(directory, { method: "submit", request });
    const state = await snapshot(directory);
    if (state.attempts.length) outcome = await call(directory, { method: "advance", requestId: request.requestId });
    const after = await snapshot(directory);
    const counts = await countersSafe(owners, after);
    assert.ok(after.attempts.length <= 1);
    for (const receipt of before) assert.ok((await owners.records()).some(record => record.id === receipt.id));
    if (outcome.status === "refused") assert.ok(outcome.nextAction.length > 0);
    if (/^(acquire|launch|prompt):effect:|^(workspace|started|launched|prompted):ack:/.test(point)) {
      assert.equal(outcome.status, "refused", "Uncertain pre-worker progress must not silently continue");
      assert.equal(counts.reduce((sum, count) => sum + count.return, 0), 0);
    }
    if (point === "return:effect:after" || point === "returned:ack:before") {
      assert.equal(outcome.status, "refused");
      if (outcome.status === "refused") assert.equal(outcome.code, "finalisation_uncertain");
    }
    await record({ design, repeat, case: point, killed: "SIGKILL", outcome, counts });
  });

  test(`${design} concurrent CLI capacity and lost response repeat ${repeat}`, async t => {
    const { directory, owners } = await fixture();
    const hosts: Host[] = [];
    t.after(async () => { for (const host of hosts) await kill(host); await rm(directory, { recursive: true, force: true }); });
    const host = start(directory, design); hosts.push(host); await until(host, "ready");
    const second = start(directory, design); hosts.push(second);
    assert.equal((await second.exited).code, 2, "A live host excludes a competing host before storage opens");
    const requests = ["one", "two", "three"].map(id => sampleRequest(id));
    const outcomes = await Promise.all(requests.map(request => cli(directory, { method: "submit", request })));
    assert.equal(outcomes.filter(outcome => outcome.status === "waiting").length, 2);
    assert.equal(outcomes.filter(outcome => outcome.status === "refused" && outcome.code === "capacity").length, 1);
    const state = await snapshot(directory);
    assert.equal(state.active, 2);
    const admitted = requests[outcomes.findIndex(outcome => outcome.status === "waiting")]!;
    // Discard the client response, then crash the owner. Retry from a fresh CLI process.
    await cli(directory, { method: "submit", request: admitted });
    await kill(host);
    await rm(join(directory, "host", "owner"), { recursive: true });
    const recovered = start(directory, design); hosts.push(recovered); await until(recovered, "ready");
    const retry = await cli(directory, { method: "submit", request: admitted });
    assert.equal(retry.status, "refused");
    if (retry.status === "refused") assert.equal(retry.code, "possibly_running");
    const after = await snapshot(directory);
    assert.equal(after.attempts.length, 2);
    await record({ design, repeat, case: "concurrent_clients_lost_response", outcomes, retry, counts: await countersSafe(owners, after) });
  });

  for (const approval of ["missing", "stale", "model"]) test(`${design} ${approval} approval across restart repeat ${repeat}`, async t => {
    const { directory, owners } = await fixture();
    const hosts: Host[] = [];
    t.after(async () => { for (const host of hosts) await kill(host); await rm(directory, { recursive: true, force: true }); });
    const host = start(directory, design); hosts.push(host); await until(host, "ready");
    const request = sampleRequest();
    if (approval === "model") Object.assign(request, { approval: { by: "operator", accept: true, noProcesses: true } });
    await call(directory, { method: "submit", request });
    const attempt = (await snapshot(directory)).attempts[0]!;
    await owners.exit(result(attempt));
    await call(directory, { method: "advance", requestId: request.requestId });
    await owners.review(attempt.id, commit, "accepted");
    await owners.setControls({ ...await owners.controls(), retainedCommit: commit });
    if (approval === "stale") await approve(owners, attempt, now - 1);
    await kill(host);
    await rm(join(directory, "host", "owner"), { recursive: true });
    const recovered = start(directory, design); hosts.push(recovered); await until(recovered, "ready");
    const outcome = await call(directory, { method: "advance", requestId: request.requestId });
    assert.equal(outcome.status, "refused");
    if (outcome.status === "refused") assert.equal(outcome.code, "approval_required");
    const state = await snapshot(directory);
    assert.equal(state.attempts[0]!.accepted, false);
    assert.equal((await owners.counters(attempt.id)).return, 0);
    await record({ design, repeat, case: `approval_${approval}`, outcome, counts: await countersSafe(owners, state) });
  });

  test(`${design} duplicate review and wait deadline across SIGKILL repeat ${repeat}`, async t => {
    const { directory, owners } = await fixture();
    const hosts: Host[] = [];
    t.after(async () => { for (const host of hosts) await kill(host); await rm(directory, { recursive: true, force: true }); });
    const host = start(directory, design); hosts.push(host); await until(host, "ready");
    const request = sampleRequest();
    await call(directory, { method: "submit", request });
    const attempt = (await snapshot(directory)).attempts[0]!;
    await owners.exit(result(attempt));
    await call(directory, { method: "advance", requestId: request.requestId });
    let deadline: number | undefined;
    if (design === "B") {
      const diagnostic = await call<{ engine: { tasks: { record: { state: { status: string; until?: number } } }[] } }>(directory, { method: "diagnostics" });
      deadline = diagnostic.engine.tasks[0]!.record.state.until;
      assert.ok(deadline! > now);
    }
    await owners.review(attempt.id, commit, "accepted");
    await kill(host);
    // Second signal delivered while no host exists. Neither signal is a transient engine message.
    await owners.review(attempt.id, commit, "accepted");
    await approve(owners, attempt);
    await rm(join(directory, "host", "owner"), { recursive: true });
    const recovered = start(directory, design); hosts.push(recovered); await until(recovered, "ready");
    if (design === "B") {
      const diagnostic = await call<{ engine: { tasks: { record: { state: { until?: number } } }[] } }>(directory, { method: "diagnostics" });
      assert.equal(diagnostic.engine.tasks[0]!.record.state.until, deadline, "Reopen must retain the absolute deadline");
    }
    // B's explicit advance moves its controlled clock to the saved deadline and resumes.
    const outcome = await call(directory, { method: "advance", requestId: request.requestId });
    assert.equal(outcome.status, "completed");
    const state = await snapshot(directory);
    assert.equal(state.attempts[0]!.reviewAccepted, true);
    const store = await ApplicationStore.open(join(directory, "host"));
    assert.equal(store.tasks.database.get("SELECT count(*) AS n FROM prototype_facts WHERE name = 'review'")!.n, 1);
    store.close();
    await record({ design, repeat, case: "duplicate_review_wait_deadline", deadline: deadline ?? "A has no persisted timer", outcome, counts: await countersSafe(owners, state) });
  });

  test(`${design} storage write failure stays visible across crash repeat ${repeat}`, async t => {
    const { directory, owners } = await fixture();
    const hosts: Host[] = [];
    t.after(async () => { for (const host of hosts) await kill(host); await rm(directory, { recursive: true, force: true }); });
    const host = start(directory, design); hosts.push(host); await until(host, "ready");
    await call(directory, { method: "queryOnly" });
    const outcome = await call(directory, { method: "submit", request: sampleRequest() });
    assert.equal(outcome.status, "refused");
    if (outcome.status === "refused") assert.equal(outcome.code, "host_unavailable");
    assert.equal((await owners.records()).length, 0);
    await kill(host);
    const blocked = start(directory, design); hosts.push(blocked);
    assert.equal((await blocked.exited).code, 2);
    await record({ design, repeat, case: "storage_read_only", outcome, effects: 0, staleClaimBlocksRestart: true });
  });

  for (const invalid of [false, true]) test(`${design} unrecorded worker result identity ${invalid ? "invalid" : "valid"} repeat ${repeat}`, async t => {
    const { directory, owners } = await fixture();
    const hosts: Host[] = [];
    t.after(async () => { for (const host of hosts) await kill(host); await rm(directory, { recursive: true, force: true }); });
    const host = start(directory, design); hosts.push(host); await until(host, "ready");
    const request = sampleRequest();
    await call(directory, { method: "submit", request });
    const attempt = (await snapshot(directory)).attempts[0]!;
    await kill(host);
    const report = result(attempt);
    if (invalid) report.identity = { ...report.identity, sessionId: "another-session" };
    // External result arrives while orchestration is stopped. Absence of a process alone
    // would have no positive receipt and is covered by the synthetic-child crash cases.
    await owners.exit(report);
    await rm(join(directory, "host", "owner"), { recursive: true });
    const recovered = start(directory, design); hosts.push(recovered); await until(recovered, "ready");
    const outcome = await call(directory, { method: "advance", requestId: request.requestId });
    assert.equal(outcome.status, invalid ? "refused" : "waiting");
    if (outcome.status === "refused") assert.equal(outcome.code, "invalid_result");
    else if (outcome.status === "waiting") assert.equal(outcome.waitingFor, "review");
    await record({ design, repeat, case: `unrecorded_result_${invalid ? "invalid" : "valid"}`, outcome, counts: await countersSafe(owners, await snapshot(directory)) });
  });

  test(`${design} corrupt application storage cannot silently resume repeat ${repeat}`, async t => {
    const { directory, owners } = await fixture();
    const hosts: Host[] = [];
    t.after(async () => { for (const host of hosts) await kill(host); await rm(directory, { recursive: true, force: true }); });
    const host = start(directory, design); hosts.push(host); await until(host, "ready");
    await call(directory, { method: "submit", request: sampleRequest() });
    const before = await owners.records();
    await kill(host);
    await rm(join(directory, "host", "owner"), { recursive: true });
    for (const suffix of ["-wal", "-shm"]) await rm(join(directory, "host", `switchboard.db${suffix}`), { force: true });
    await writeFile(join(directory, "host", "switchboard.db"), "deliberately invalid SQLite fixture");
    const failed = start(directory, design); hosts.push(failed);
    assert.equal((await failed.exited).code, 2);
    assert.match(failed.output(), /database|SQLite|file/i);
    assert.deepEqual(await owners.records(), before);
    await record({ design, repeat, case: "corrupt_application_storage", startupFailed: true, failure: failed.output().trim(), effectsUnchanged: true });
  });

  test(`${design} simulated lost execution records are distinct from process crashes repeat ${repeat}`, async t => {
    const { directory, owners } = await fixture();
    const hosts: Host[] = [];
    t.after(async () => { for (const host of hosts) await kill(host); await rm(directory, { recursive: true, force: true }); });
    const initial = start(directory, design); hosts.push(initial); await until(initial, "ready");
    await call(directory, { method: "shutdown" });
    assert.equal((await initial.exited).code, 0);
    const backup = join(directory, "offline-backup");
    await mkdir(backup);
    for (const name of await readdir(join(directory, "host"))) if (/\.db$/.test(name)) await cp(join(directory, "host", name), join(backup, name));
    const host = start(directory, design); hosts.push(host); await until(host, "ready");
    const request = sampleRequest();
    await call(directory, { method: "submit", request });
    await kill(host);
    await rm(join(directory, "host", "owner"), { recursive: true });
    if (design === "B") {
      // Artificially lose only NORMAL engine progress, preserving FULL domain fences.
      for (const suffix of ["", "-wal", "-shm"]) await rm(join(directory, "host", `durable.db${suffix}`), { force: true });
      await cp(join(backup, "durable.db"), join(directory, "host", "durable.db"));
    } else {
      // A has no engine database. Lose only its presentation cache, never the domain facts.
      const store = await ApplicationStore.open(join(directory, "host"));
      await store.tasks.database.transaction(() => store.tasks.database.run("DELETE FROM prototype_responses"));
      store.close();
    }
    const fenced = start(directory, design); hosts.push(fenced); await until(fenced, "ready");
    const outcome = await call(directory, { method: "submit", request });
    assert.equal(outcome.status, "refused");
    const safe = await countersSafe(owners, await snapshot(directory));
    await kill(fenced);
    await rm(join(directory, "host", "owner"), { recursive: true });
    // Separate, deliberately unsupported disaster: roll back ALL execution/domain stores.
    // This is not power-loss emulation. It demonstrates why losing FULL exclusion facts
    // cannot be made safe by checkpoint replay or a stable caller ID alone.
    for (const name of await readdir(join(directory, "host"))) if (/\.db(?:-wal|-shm)?$/.test(name)) await rm(join(directory, "host", name));
    for (const name of await readdir(backup)) await cp(join(backup, name), join(directory, "host", name));
    const rolledBack = start(directory, design); hosts.push(rolledBack); await until(rolledBack, "ready");
    const unsafeOutcome = await call(directory, { method: "submit", request });
    const records = await owners.records();
    assert.equal(records.filter(receipt => receipt.effect === "launch").length, 2, "Full record rollback is a demonstrated deduplication hazard, not supported recovery");
    assert.equal(records.filter(receipt => receipt.effect === "prompt").length, 2);
    await record({ design, repeat, case: "simulated_record_loss_not_crash_evidence", survivingDomainFences: { outcome, counts: safe },
      allStoresRolledBack: { outcome: unsafeOutcome, launchesForSameCaller: 2, promptsForSameCaller: 2, adoptionHazard: true } });
  });

  test(`${design} restart after review deadline repeat ${repeat}`, async t => {
    const { directory, owners } = await fixture();
    const hosts: Host[] = [];
    t.after(async () => { for (const host of hosts) await kill(host); await rm(directory, { recursive: true, force: true }); });
    const host = start(directory, design); hosts.push(host); await until(host, "ready");
    const request = sampleRequest();
    await call(directory, { method: "submit", request });
    const attempt = (await snapshot(directory)).attempts[0]!;
    await owners.exit(result(attempt));
    await call(directory, { method: "advance", requestId: request.requestId });
    await kill(host);
    await rm(join(directory, "host", "owner"), { recursive: true });
    const recovered = start(directory, design, "", "fake", now + 10_000); hosts.push(recovered); await until(recovered, "ready");
    if (design === "B") {
      const diagnostic = await call<{ engine: { tasks: { record: { state: { status: string; until: number } } }[] } }>(directory, { method: "diagnostics" });
      assert.equal(diagnostic.engine.tasks[0]!.record.state.status, "sleeping");
      assert.ok(diagnostic.engine.tasks[0]!.record.state.until > now + 10_000, "The overdue checkpoint must run at host resume, without a client advance");
    }
    const outcome = await call(directory, { method: "advance", requestId: request.requestId });
    assert.equal(outcome.status, "waiting");
    if (outcome.status === "waiting") assert.equal(outcome.waitingFor, "review");
    await record({ design, repeat, case: "overdue_review_wait", operatorStartedHost: true, outcome, counts: await countersSafe(owners, await snapshot(directory)) });
  });

  for (const operation of ["crash", "cancel", "shutdown"]) test(`${design} synthetic child ${operation} repeat ${repeat}`, async t => {
    const { directory, owners } = await fixture();
    const hosts: Host[] = [];
    let workerPid: number | undefined;
    t.after(async () => {
      for (const host of hosts) await kill(host);
      if (workerPid) {
        try { process.kill(workerPid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      await rm(directory, { recursive: true, force: true });
    });
    const host = start(directory, design, "", "process"); hosts.push(host); await until(host, "ready");
    const request = sampleRequest();
    await call(directory, { method: "submit", request });
    const attempt = (await snapshot(directory)).attempts[0]!;
    const workerDirectory = join(directory, "owners", "workers", attempt.id);
    workerPid = JSON.parse(await readFile(join(workerDirectory, "pid.json"), "utf8")).pid;
    assert.equal((await readFile(join(workerDirectory, "prompts.jsonl"), "utf8")).trim().split("\n").length, 1);
    await readFile(join(workerDirectory, "result.json"));
    assert.equal((await owners.counters(attempt.id)).worker_exit, 0, "A result file is not exit evidence");
    let observation: unknown;
    if (operation === "shutdown") {
      observation = await call(directory, { method: "shutdown" });
      assert.equal((observation as { workerTermination: string }).workerTermination, "unverified");
      assert.equal((await host.exited).code, 0);
    } else {
      if (operation === "cancel") observation = await call(directory, { method: "cancel", requestId: request.requestId });
      await kill(host);
      await rm(join(directory, "host", "owner"), { recursive: true });
    }
    // The fixture child has no descendants. Join-by-observation is test cleanup only; neither
    // execution design is supplied with termination evidence or permission to return its lease.
    for (let tries = 0; tries < 200; tries++) {
      try { process.kill(workerPid!, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { workerPid = undefined; break; } throw error; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(workerPid, undefined, "The synthetic child must exit when its IPC owner disappears");
    const recovered = start(directory, design); hosts.push(recovered); await until(recovered, "ready");
    const outcome = await call(directory, { method: "advance", requestId: request.requestId });
    assert.equal(outcome.status, "refused");
    if (outcome.status === "refused") assert.ok(["possibly_running", "cancelled"].includes(outcome.code));
    assert.equal((await owners.counters(attempt.id)).return, 0);
    assert.equal((await owners.counters(attempt.id)).worker_exit, 0);
    await record({ design, repeat, case: `synthetic_child_${operation}`, observation, outcome, counts: await countersSafe(owners, await snapshot(directory)) });
  });
}
