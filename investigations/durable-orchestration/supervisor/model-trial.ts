import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ApplicationStore } from "../design-a/store.ts";
import { SwitchboardScenario } from "../design-a/driver.ts";
import { completedResult } from "../scenario/assertions.ts";
import { sampleRequest } from "../scenario/common-tests.ts";
import { FakeOwners } from "../scenario/owners.ts";
import { start, stop } from "./process-fixture.ts";
import { resolvePiDefault } from "./trial-pi.ts";
import { dependencyDigest, offlineLimits, planDigest, planSchema, trialProfile, type TrialPlan } from "./trial-profile.ts";

export const trialRoot = fileURLToPath(new URL("../../../.investigation/durable-orchestration/model-trials/", import.meta.url));
async function optionalJson(path: string) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function fixturePath(path: string, existing: boolean): Promise<string> {
  const directory = resolve(path);
  if (dirname(directory) !== resolve(trialRoot)) throw new Error(`Use a direct child of ${trialRoot}`);
  await mkdir(trialRoot, { recursive: true, mode: 0o700 });
  if (await realpath(trialRoot) !== resolve(trialRoot)) throw new Error("Trial root must be canonical");
  if (existing && (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory())) throw new Error("Fixture must be a canonical directory");
  return directory;
}

export async function prepareTrial(path: string, scenario: TrialPlan["scenario"]): Promise<TrialPlan> {
  if (scenario !== "lost_result" && scenario !== "stale_approval") throw new Error("Unknown trial scenario");
  const directory = await fixturePath(path, false);
  await mkdir(directory, { mode: 0o700 }); // Refuse reuse, even if the existing directory is empty.
  const plan: TrialPlan = { version: 1, fixtureId: randomUUID(), dependencyLockSha256: await dependencyDigest(), scenario, provider: "UNSET", model: "",
    credentialEnv: "OPENAI_API_KEY", pi: null, limits: null };
  const owners = new FakeOwners(join(directory, "owners"), join(directory, "host"));
  await owners.initialise();
  const store = await ApplicationStore.open(join(directory, "host"));
  const driver = new SwitchboardScenario(store, owners, { now: () => 1_000_000 });
  try {
    if (scenario === "lost_result") {
      await store.seed(["supervisor-fixture-task"]);
      await writeFile(join(directory, "config.json"), JSON.stringify({ objectiveId: plan.fixtureId, replay: "unsafe" }), { flag: "wx", flush: true });
    } else {
      const request = sampleRequest("trial-decision");
      await store.seed([request.taskId]);
      assert.equal((await driver.submit(request)).status, "waiting");
      const attempt = (await driver.inspect()).attempts[0]!;
      const result = completedResult(attempt);
      await owners.exit(result);
      assert.equal((await driver.advance(request.requestId)).status, "waiting");
      await owners.review(attempt.id, result.commit, "accepted");
      await owners.setControls({ ...await owners.controls(), retainedCommit: result.commit, approvals: [{ id: "fixture-approval",
        by: "operator", attemptId: attempt.id, leaseId: attempt.identity!.leaseId, commit: result.commit,
        expiresAt: 1_100_000, accept: true, noProcesses: true }] });
      await writeFile(join(directory, "config.json"), JSON.stringify({ scenario: "revoked", requestId: request.requestId }), { flag: "wx", flush: true });
      await writeFile(join(directory, "clock.json"), "1000000", { flag: "wx", flush: true });
    }
  } finally { await driver.close(); }
  await writeFile(join(directory, "trial.json"), JSON.stringify(plan, null, 2), { flag: "wx", flush: true });
  return plan;
}

export async function runStage(path: string, stage: "start" | "resume", offline: boolean, confirmStopped = false): Promise<void> {
  const directory = await fixturePath(path, true);
  const plan = planSchema.parse(await optionalJson(join(directory, "trial.json")));
  const flag = offline ? "--trial-offline" : "--trial-real";
  const profile = (await trialProfile(directory, flag, plan.scenario))!; // Deny unapproved real calls before any child starts.
  const marker = await optionalJson(join(directory, "stopped.json"));
  if (stage === "resume") {
    if (!confirmStopped || !marker || marker.digest !== profile.digest || marker.offline !== offline) throw new Error("Inspect the fixture and explicitly confirm the stopped host before resuming");
    const owner = await optionalJson(join(directory, "host", "owner", "claim.json"));
    if (owner?.pid !== marker.pid || await realpath(join(directory, "host", "owner")) !== join(directory, "host", "owner")) throw new Error("Fixture claim changed; inspect rather than recover it");
  }
  const started = stage === "start" ? { at: Date.now(), digest: profile.digest, offline, plan } : await optionalJson(join(directory, "started.json"));
  if (!started || started.digest !== profile.digest || started.offline !== offline) throw new Error("Trial profile changed");
  const remaining = started.at + profile.limits.maxDurationMs - Date.now();
  if (remaining <= 0) throw new Error("Trial duration limit reached; do not reset accounting");
  await writeFile(join(directory, stage === "start" ? "started.json" : "resuming.json"), JSON.stringify(started), { flag: "wx", flush: true });
  if (stage === "resume") {
    if (plan.scenario === "stale_approval") {
      const owners = new FakeOwners(join(directory, "owners"), join(directory, "host"));
      await owners.setControls({ ...await owners.controls(), approvals: [] });
      await writeFile(join(directory, "clock.json"), "1000010", { flush: true });
    }
    await rm(join(directory, "host", "owner"), { recursive: true }); // Explicit fixture-only recovery, not production takeover.
  }
  const hostFile = fileURLToPath(new URL(plan.scenario === "lost_result" ? "./host-child.ts" : "./decision-child.ts", import.meta.url));
  const host = start(hostFile, directory, stage === "start" ? "pause" : "resume", [flag]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([stage === "start" ? host.boundary : host.exited.then(exit => {
      if (exit.code !== 0) throw new Error("Trial host failed; inspect retained diagnostics");
    }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Trial duration limit reached")), remaining); })]);
    if (stage === "start") {
      await stop(host);
      assert.equal(host.child.signalCode, "SIGKILL");
      const paused = await trialReport(directory);
      if (paused.attempts.length !== 1 || paused.counts.acquire !== 1 || paused.counts.launch !== 1 || paused.counts.prompt !== 1 ||
        paused.counts.return !== 0 || paused.counts.merge !== 0 || paused.counts.cancel !== 0 || paused.attempts[0]!.accepted ||
        paused.counts.worker_exit !== (plan.scenario === "stale_approval" ? 1 : 0)) {
        throw new Error("Expected pre-effect boundary was not reached; inspect the incomplete trial, do not resume it");
      }
      await writeFile(join(directory, "stopped.json"), JSON.stringify({ digest: profile.digest, offline, pid: host.child.pid }), { flag: "wx", flush: true });
    }
  } finally {
    if (timer) clearTimeout(timer);
    await stop(host);
    await writeFile(join(directory, `${stage}-diagnostics.txt`), host.output(), { flag: "wx", flush: true });
  }
}

export async function trialReport(path: string) {
  const directory = await fixturePath(path, true);
  const plan = planSchema.parse(await optionalJson(join(directory, "trial.json")));
  const stopped = await optionalJson(join(directory, "stopped.json"));
  const started = await optionalJson(join(directory, "started.json"));
  const owners = new FakeOwners(join(directory, "owners"), join(directory, "host"));
  const receipts = await owners.records();
  const store = await ApplicationStore.open(join(directory, "host"));
  try {
    const callsPath = join(directory, plan.scenario === "lost_result" ? "calls.jsonl" : "decision-calls.jsonl");
    let calls: { pid: number; tool?: string; outcome?: unknown }[] = [];
    try { calls = (await readFile(callsPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const resumedCalls = stopped ? calls.filter(call => call.pid !== stopped.pid && call.tool) : [];
    const boundary = await optionalJson(join(directory, "boundary.json"));
    const result = await optionalJson(join(directory, "resume.json"));
    const boundaryIds = new Set<number>((boundary?.transcript.entries ?? []).map((entry: { id: number }) => entry.id));
    const transcript = result?.transcript ?? result?.after.transcript;
    const modelCalls: { name: string; arguments: unknown }[] = (transcript?.entries ?? [])
      .filter((entry: { id: number }) => !boundaryIds.has(entry.id))
      .flatMap((entry: { model?: { role: string; content: { type: string; name?: string; arguments?: unknown }[] }[] }) =>
        (entry.model ?? []).filter(message => message.role === "assistant").flatMap(message => message.content.filter(item => item.type === "toolCall")));
    const requests = store.tasks.database.get("SELECT name FROM sqlite_master WHERE name='prototype_trial_requests'")
      ? store.tasks.database.all("SELECT * FROM prototype_trial_requests ORDER BY id") : [];
    return { plan, digest: planDigest(plan), started, stopped,
      executionMode: started ? started.offline ? "offline-faux" : "authorised-real" : "not-started",
      profileMatchesStart: !started || started.digest === planDigest(plan),
      effectiveLimits: started?.offline ? offlineLimits : started?.plan.limits ?? plan.limits, requests, attempts: store.list(),
      counts: Object.fromEntries(["acquire", "launch", "prompt", "worker_exit", "review", "return", "merge", "cancel"].map(effect => [effect, receipts.filter(receipt => receipt.effect === effect).length])),
      behaviour: { inspectedAfterRestart: resumedCalls.some(call => call.tool?.startsWith("inspect")),
        redispatchedAfterRestart: resumedCalls.some(call => call.tool === "dispatch"), modelCallsAfterRestart: modelCalls, resumedCalls },
      boundaryReached: !!boundary, result,
      note: "Counts describe safety; model behaviour and outcome need review. Observed token/cost limits may overshoot by one in-flight request; unknown usage blocks further calls." };
  } finally { store.close(); }
}

async function main() {
  const [command, path, ...args] = process.argv.slice(2);
  if (!path) throw new Error("Expected prepare|start|resume|report <fixture> [scenario/flags], or pi-default <sdk-root>");
  if (command === "pi-default") console.log(JSON.stringify(await resolvePiDefault(path, process.cwd()), null, 2));
  else if (command === "prepare") console.log(JSON.stringify(await prepareTrial(path, args[0] as TrialPlan["scenario"]), null, 2));
  else if (command === "report") console.log(JSON.stringify(await trialReport(path), null, 2));
  else if (command === "start" || command === "resume") {
    if (args.some(arg => !["--offline", "--confirm-chargeable", "--confirm-fixture-host-stopped"].includes(arg))) throw new Error("Unknown trial flag");
    const offline = args.includes("--offline");
    if (!offline && !args.includes("--confirm-chargeable")) throw new Error("Real calls require explicit --confirm-chargeable and a matching approval record");
    if (offline && args.includes("--confirm-chargeable")) throw new Error("Choose offline or real, not both");
    await runStage(path, command, offline, args.includes("--confirm-fixture-host-stopped"));
    console.log(JSON.stringify(await trialReport(path), null, 2));
  } else throw new Error("Unknown trial command");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
}
