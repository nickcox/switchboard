import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ApplicationStore } from "../design-a/store.ts";
import { budgetedModels } from "./trial-budget.ts";
import { offlineLimits, planDigest, trialProfile, type TrialPlan } from "./trial-profile.ts";
import { prepareTrial, runStage, trialReport, trialRoot } from "./model-trial.ts";
import { piModels, resolvePiDefault } from "./trial-pi.ts";

async function fixture(t: test.TestContext, scenario: TrialPlan["scenario"] = "lost_result") {
  const path = join(trialRoot, `offline-${randomUUID()}`);
  const plan = await prepareTrial(path, scenario);
  t.after(() => rm(path, { recursive: true, force: true }));
  return { path, plan };
}

for (const scenario of ["lost_result", "stale_approval"] as const) {
  test(`real-trial offline rehearsal uses existing hosts: ${scenario}`, { timeout: 25_000 }, async t => {
    const { path, plan } = await fixture(t, scenario);
    assert.equal(plan.provider, "UNSET"); assert.equal(plan.limits, null);
    await runStage(path, "start", true);
    const paused = await trialReport(path);
    assert.equal(paused.stopped.offline, true);
    assert.equal(paused.boundaryReached, true);
    assert.equal(paused.counts.return, 0);
    assert.ok(paused.requests.length > 0 && paused.requests.every(request => request.status === "settled"));
    await assert.rejects(runStage(path, "resume", true), /confirm the stopped host/);
    await runStage(path, "resume", true, true);
    const result = await trialReport(path);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.counts.acquire, 1); assert.equal(result.counts.launch, 1); assert.equal(result.counts.prompt, 1);
    assert.equal(result.counts.return, 0);
    assert.equal(result.behaviour.redispatchedAfterRestart, false);
    if (scenario === "lost_result") assert.equal(result.behaviour.inspectedAfterRestart, true);
    else {
      // The old inspection is deliberately retained. The offline script tries finalise, whose
      // current application checks refuse. A real model's choices must be reviewed separately.
      assert.equal((result.behaviour.resumedCalls[0]!.outcome as { code: string }).code, "approval_required");
      const controls = JSON.parse(await readFile(join(path, "owners", "controls.json"), "utf8"));
      assert.deepEqual(controls.approvals, []);
    }
    assert.ok(result.requests.every(request => request.status === "settled"));
    assert.match(result.note, /overshoot/);
    const transcript = JSON.stringify(result.result);
    assert.match(transcript, /faux/);
    assert.equal(result.plan.provider, "UNSET", "Rehearsal must not populate a real provider or approval");
    await assert.rejects(readFile(join(path, "approval.json")), /ENOENT/);
    await assert.rejects(runStage(path, "start", true), /EEXIST/);
    console.log(JSON.stringify({ scenario, offline: true, counts: result.counts, requests: result.requests.length }));
  });
}

test("real trial denies missing configuration/approval before spawning a host", async t => {
  const { path, plan } = await fixture(t);
  await assert.rejects(runStage(path, "start", false), /not approved or configured/);
  const configured: TrialPlan = { ...plan, provider: "openai", model: "not-selected-for-a-real-run", limits: offlineLimits };
  await writeFile(join(path, "trial.json"), JSON.stringify(configured));
  await assert.rejects(trialProfile(path, "--trial-real", "lost_result"), /ENOENT/);
  const approval = { planDigest: planDigest(configured), approvedBy: "offline-unit-test-only", expiresAt: Date.now() + 60_000, acceptObservedLimitOvershoot: true };
  await writeFile(join(path, "approval.json"), JSON.stringify({ ...approval, expiresAt: 1 }));
  await assert.rejects(trialProfile(path, "--trial-real", "lost_result"), /expired/);
  await writeFile(join(path, "approval.json"), JSON.stringify({ ...approval, planDigest: "changed" }));
  await assert.rejects(trialProfile(path, "--trial-real", "lost_result"));
  await writeFile(join(path, "approval.json"), JSON.stringify({ ...approval, acceptObservedLimitOvershoot: false }));
  await assert.rejects(trialProfile(path, "--trial-real", "lost_result"));
  const report = await trialReport(path);
  assert.equal(report.stopped, null); assert.deepEqual(report.requests, []);
  await assert.rejects(readFile(join(path, "started.json")), /ENOENT/);
});

test("trial preparation refuses reuse and paths outside its dedicated fixture root", async t => {
  const { path } = await fixture(t);
  await assert.rejects(prepareTrial(path, "lost_result"), /EEXIST/);
  await assert.rejects(prepareTrial(join(trialRoot, "..", "wrong-root"), "lost_result"), /direct child/);
  await assert.rejects(trialProfile(path, "--trial-offline", "stale_approval"), /scenario mismatch/);
});

test("changed profile cannot reuse admissions across restarts", { timeout: 25_000 }, async t => {
  const { path, plan } = await fixture(t);
  await runStage(path, "start", true);
  await writeFile(join(path, "trial.json"), JSON.stringify({ ...plan, model: "changed" }));
  await assert.rejects(runStage(path, "resume", true, true), /profile changed/);
  assert.ok(await readFile(join(path, "host", "owner", "claim.json")), "Changed profile cannot remove the surviving claim");
});

test("persisted request budget denies extra calls and enforces output limits", async t => {
  const { path } = await fixture(t);
  const store = await ApplicationStore.open(join(path, "host")); t.after(() => store.close());
  const faux = fauxProvider();
  faux.setResponses([(_input, options) => { assert.equal(options!.maxTokens, 32); assert.equal(options!.maxRetries, 0); return fauxAssistantMessage("ok"); }]);
  const base = createModels(); base.setProvider(faux.provider);
  const bounded = await budgetedModels(base, store, "budget-test", { ...offlineLimits, maxRequests: 1, maxOutputTokens: 32 }, Date.now() + 60_000);
  const input = { messages: [{ role: "user" as const, content: "test", timestamp: 1 }] };
  assert.equal((await bounded.streamSimple(faux.getModel(), input).result()).stopReason, "stop");
  assert.match((await bounded.streamSimple(faux.getModel(), input).result()).errorMessage!, /request limit/);
  assert.equal(faux.state.callCount, 1);
  assert.equal(bounded.getModel("faux", "faux-1")!.id, "faux-1", "Public Models prototype methods remain available");
  assert.throws(() => bounded.completeSimple(faux.getModel(), input), /only budgeted/);
  await assert.rejects(budgetedModels(base, store, "different-profile", offlineLimits, Date.now() + 60_000), /profile changed/);
});

test("unsettled/error usage blocks subsequent calls, including after reopen", async t => {
  const { path } = await fixture(t);
  const faux = fauxProvider(); faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "unknown provider billing" })]);
  const base = createModels(); base.setProvider(faux.provider);
  let store = await ApplicationStore.open(join(path, "host"));
  try {
    const bounded = await budgetedModels(base, store, "unknown-test", offlineLimits, Date.now() + 60_000);
    assert.equal((await bounded.streamSimple(faux.getModel(), { messages: [] }).result()).stopReason, "error");
  } finally { store.close(); }
  store = await ApplicationStore.open(join(path, "host"));
  try {
    const bounded = await budgetedModels(base, store, "unknown-test", offlineLimits, Date.now() + 60_000);
    assert.match((await bounded.streamSimple(faux.getModel(), { messages: [] }).result()).errorMessage!, /Unsettled model usage/);
    assert.equal(faux.state.callCount, 1);
    assert.equal(store.tasks.database.get("SELECT status FROM prototype_trial_requests")!.status, "unknown");
  } finally { store.close(); }
});

for (const reason of ["input", "expired"] as const) test(`trial denies ${reason} before provider invocation`, async t => {
  const { path } = await fixture(t);
  const store = await ApplicationStore.open(join(path, "host")); t.after(() => store.close());
  const faux = fauxProvider(); const base = createModels(); base.setProvider(faux.provider);
  const bounded = await budgetedModels(base, store, reason, { ...offlineLimits, maxInputBytes: reason === "input" ? 1 : 250_000 },
    reason === "expired" ? 1 : Date.now() + 60_000);
  const result = await bounded.streamSimple(faux.getModel(), { messages: [] }).result();
  assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, reason === "input" ? /byte limit/ : /expired/);
  assert.equal(faux.state.callCount, 0);
  assert.equal(store.tasks.database.get("SELECT count(*) AS n FROM prototype_trial_requests")!.n, 0);
});

test("observed usage threshold converts a tool-use response to an error", async t => {
  const { path } = await fixture(t);
  const store = await ApplicationStore.open(join(path, "host")); t.after(() => store.close());
  const base = createModels(); const faux = fauxProvider(); base.setProvider(faux.provider);
  const counted = { ...base, streamSimple: () => {
    const stream = createAssistantMessageEventStream();
    const message = { ...fauxAssistantMessage(fauxToolCall("dispatch", {}), { stopReason: "toolUse" }), usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
      cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 } } };
    stream.push({ type: "done", reason: "toolUse", message }); stream.end(message); return stream;
  } };
  const bounded = await budgetedModels(counted, store, "usage-test", { ...offlineLimits, maxObservedCostUsd: 0.5 }, Date.now() + 60_000);
  const result = await bounded.streamSimple(faux.getModel(), { messages: [] }).result();
  assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /observed usage/);
  assert.equal(store.tasks.database.get("SELECT cost FROM prototype_trial_requests")!.cost, 1);
});

async function fakePi(path: string) {
  const sdkRoot = join(path, "sdk"); const agentDir = join(path, "agent");
  await mkdir(join(sdkRoot, "dist/core"), { recursive: true }); await mkdir(agentDir);
  await writeFile(join(sdkRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.4.0", type: "module" }));
  await writeFile(join(sdkRoot, "dist/core/model-runtime.js"), "// Offline SDK identity fixture\n");
  await writeFile(join(sdkRoot, "dist/index.js"), `
    import { createModels } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/models"))};
    import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
    export const defaults = { provider: 'openai-codex', model: 'fixture-default', auth: 'oauth' };
    export const observed = [];
    export const ModelRuntime = { async create(options) {
      if (options.refreshOnCreate !== false || options.allowModelNetwork !== false) throw new Error('Unexpected refresh');
      const base = createModels();
      const faux = fauxProvider({ provider: 'openai-codex', api: 'openai-codex-responses', models: [{ id: 'fixture-default' }] });
      faux.setResponses([(_input, options) => { observed.push(options); return fauxAssistantMessage('offline SDK response'); }]);
      base.setProvider(faux.provider);
      base.getError = () => undefined;
      base.checkAuth = async () => ({ type: defaults.auth });
      return base;
    } };
    export const SettingsManager = { create() { return {
      getDefaultProvider: () => defaults.provider, getDefaultModel: () => defaults.model,
      getDefaultThinkingLevel: () => 'medium', getModelThinkingLevel: () => undefined, drainErrors: () => []
    }; } };
  `);
  const module = await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href);
  return { sdkRoot, agentDir, module };
}

test("Pi adapter freezes the saved default and uses only budgeted SDK generation", async t => {
  const { path } = await fixture(t); const fake = await fakePi(path);
  const selected = await resolvePiDefault(fake.sdkRoot, path, fake.agentDir);
  assert.equal(selected.model, "fixture-default"); assert.equal(selected.pi.credentialType, "oauth");
  assert.equal(selected.pi.thinkingLevel, "medium"); assert.equal(selected.credentialEnv, null);
  fake.module.defaults.model = "a-changed-default-must-not-be-selected";
  const runtime = await piModels(selected.pi, selected.provider, selected.model);
  const store = await ApplicationStore.open(join(path, "host")); t.after(() => store.close());
  const bounded = await budgetedModels(runtime, store, "pi-offline-sdk", { ...offlineLimits, maxOutputTokens: null }, Date.now() + 60_000);
  const result = await bounded.streamSimple(runtime.getModel(selected.provider, selected.model)!, { messages: [] }).result();
  assert.equal(result.stopReason, "stop"); assert.equal(fake.module.observed.length, 1);
  assert.equal(fake.module.observed[0].maxTokens, undefined); assert.equal(fake.module.observed[0].maxRetries, 0);
  assert.equal(store.tasks.database.get("SELECT status FROM prototype_trial_requests")!.status, "settled");
});

test("Pi profiles require a separate output-limit exception and unchanged SDK/model configuration", async t => {
  const { path, plan } = await fixture(t); const fake = await fakePi(path);
  const selected = await resolvePiDefault(fake.sdkRoot, path, fake.agentDir);
  const configured: TrialPlan = { ...plan, ...selected, limits: { ...offlineLimits, maxOutputTokens: null } };
  await writeFile(join(path, "trial.json"), JSON.stringify(configured));
  const approval = { planDigest: planDigest(configured), approvedBy: "offline-unit-test-only", expiresAt: Date.now() + 60_000, acceptObservedLimitOvershoot: true };
  await writeFile(join(path, "approval.json"), JSON.stringify(approval));
  await assert.rejects(trialProfile(path, "--trial-real", "lost_result"), /unsupported output-token limit/);
  await writeFile(join(path, "approval.json"), JSON.stringify({ ...approval, acceptUnsupportedOutputLimit: true }));
  assert.ok(await trialProfile(path, "--trial-real", "lost_result"));
  const badModel = { ...selected.pi, modelSha256: "0".repeat(64) };
  await assert.rejects(piModels(badModel, selected.provider, selected.model), /model metadata changed/);
  fake.module.defaults.auth = "api_key";
  await assert.rejects(piModels(selected.pi, selected.provider, selected.model), /authentication type changed/);
  fake.module.defaults.auth = "oauth";
  await writeFile(join(fake.agentDir, "models.json"), "{}");
  await assert.rejects(piModels(selected.pi, selected.provider, selected.model), /SDK\/configuration changed/);
  await rm(join(fake.agentDir, "models.json"));
  await writeFile(join(fake.sdkRoot, "dist/core/model-runtime.js"), "// changed\n");
  await assert.rejects(piModels(selected.pi, selected.provider, selected.model), /SDK\/configuration changed/);
  assert.equal(fake.module.observed.length, 0, "All refusals precede generation");
});

test("Pi default resolution refuses missing defaults and non-OAuth authentication", async t => {
  const { path } = await fixture(t); const fake = await fakePi(path);
  fake.module.defaults.model = undefined;
  await assert.rejects(resolvePiDefault(fake.sdkRoot, path, fake.agentDir), /explicit saved Pi default/);
  fake.module.defaults.model = "fixture-default"; fake.module.defaults.auth = "api_key";
  await assert.rejects(resolvePiDefault(fake.sdkRoot, path, fake.agentDir), /existing OAuth/);
  fake.module.defaults.provider = "unapproved-provider";
  await assert.rejects(resolvePiDefault(fake.sdkRoot, path, fake.agentDir), /supports the saved OpenAI Codex/);
  assert.equal(fake.module.observed.length, 0);
});
