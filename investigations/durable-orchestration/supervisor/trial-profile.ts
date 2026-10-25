import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Models } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ApplicationStore } from "../design-a/store.ts";
import { budgetedModels } from "./trial-budget.ts";
import { piModels, piSourceSchema } from "./trial-pi.ts";

const positive = z.number().finite().positive();
const limits = z.object({ maxRequests: positive.int().max(100), maxDurationMs: positive.int().max(3_600_000), maxInputBytes: positive.int().max(1_000_000),
  maxOutputTokens: positive.int().max(8192).nullable(), maxObservedTokens: positive.int().max(2_000_000), maxObservedCostUsd: positive.max(100) }).strict();
export const dependencyDigest = async () => createHash("sha256").update(await readFile(fileURLToPath(new URL("../package-lock.json", import.meta.url)))).digest("hex");
export const planSchema = z.object({ version: z.literal(1), fixtureId: z.string().uuid(), dependencyLockSha256: z.string().regex(/^[a-f0-9]{64}$/), scenario: z.enum(["lost_result", "stale_approval"]),
  provider: z.enum(["UNSET", "openai", "openai-codex"]), model: z.string(), credentialEnv: z.literal("OPENAI_API_KEY").nullable(), pi: piSourceSchema.nullable(), limits: limits.nullable(),
}).strict();
export type TrialPlan = z.infer<typeof planSchema>;
export const planDigest = (plan: TrialPlan) => createHash("sha256").update(JSON.stringify(planSchema.parse(plan))).digest("hex");
export const offlineLimits = { maxRequests: 12, maxDurationMs: 120_000, maxInputBytes: 250_000, maxOutputTokens: 2048,
  maxObservedTokens: 200_000, maxObservedCostUsd: 10 };

// No credential access, real-provider import or network request while reading a plan or rehearsal.
export async function trialProfile(directory: string, flag: string | undefined, scenario: TrialPlan["scenario"]) {
  if (flag === undefined) return null;
  if (flag !== "--trial-offline" && flag !== "--trial-real") throw new Error("Unknown trial mode");
  const plan = planSchema.parse(JSON.parse(await readFile(join(directory, "trial.json"), "utf8")));
  if (plan.scenario !== scenario) throw new Error("Trial scenario mismatch");
  if (plan.dependencyLockSha256 !== await dependencyDigest()) throw new Error("Trial dependency lock changed");
  const offline = flag === "--trial-offline";
  const digest = planDigest(plan);
  let expiresAt = Number.MAX_SAFE_INTEGER;
  if (!offline) {
    if (plan.provider === "UNSET" || !plan.model.trim() || !plan.limits) throw new Error("Trial provider/model/limits are not approved or configured");
    const approval = z.object({ planDigest: z.literal(digest), approvedBy: z.string().trim().min(1),
      expiresAt: positive, acceptObservedLimitOvershoot: z.literal(true), acceptUnsupportedOutputLimit: z.literal(true).optional() }).strict()
      .parse(JSON.parse(await readFile(join(directory, "approval.json"), "utf8")));
    expiresAt = approval.expiresAt;
    if (expiresAt <= Date.now()) throw new Error("Trial authorisation expired");
    if (plan.provider === "openai-codex") {
      if (!plan.pi || plan.credentialEnv !== null || plan.limits.maxOutputTokens !== null || !approval.acceptUnsupportedOutputLimit) throw new Error("Pi subscription trial requires explicit approval of its unsupported output-token limit");
    } else if (plan.pi || plan.credentialEnv !== "OPENAI_API_KEY" || plan.limits.maxOutputTokens === null) throw new Error("Invalid API-key trial profile");
  }
  const selectedLimits = offline ? offlineLimits : plan.limits!;
  try {
    const started = JSON.parse(await readFile(join(directory, "started.json"), "utf8"));
    if (started.digest !== digest || started.offline !== offline || !Number.isFinite(started.at)) throw new Error("Trial profile changed");
    expiresAt = Math.min(expiresAt, started.at + selectedLimits.maxDurationMs);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (expiresAt <= Date.now()) throw new Error("Trial authorisation or duration expired");
  return {
    plan, digest, offline, limits: selectedLimits,
    async models(store: ApplicationStore) {
      const models = createModels();
      let base: Models = models;
      let model = { provider: "faux", modelId: "faux-1" };
      if (offline) {
        const faux = fauxProvider();
        const respond: Parameters<typeof faux.setResponses>[0][number] = async transcript => {
          const results = transcript.messages.filter(message => message.role === "toolResult");
          const tool = scenario === "lost_result" ? !results.length ? "dispatch" : !results.some(result => result.toolName === "inspect_attempt") ? "inspect_attempt" : null
            : !results.some(result => result.toolName === "inspect_decision") ? "inspect_decision" : !results.some(result => result.toolName === "finalise") ? "finalise" : null;
          if (tool === "finalise") {
            const inspection = results.find(result => result.toolName === "inspect_decision")!;
            const text = inspection.content.find(item => item.type === "text")!;
            if (text.type !== "text") throw new Error("Missing decision scope");
            const { scope } = JSON.parse(text.text);
            return fauxAssistantMessage(fauxToolCall(tool, { attemptId: scope.attemptId, commit: scope.commit }, { id: "trial-finalise" }), { stopReason: "toolUse" });
          }
          return tool ? fauxAssistantMessage(fauxToolCall(tool, {}, { id: `trial-${tool}` }), { stopReason: "toolUse" })
            : fauxAssistantMessage("Current state remains unresolved; no replacement or approval requested.");
        };
        faux.setResponses(Array.from({ length: selectedLimits.maxRequests }, () => respond));
        models.setProvider(faux.provider);
      } else if (plan.pi) {
        base = await piModels(plan.pi, plan.provider, plan.model);
        model = { provider: plan.provider, modelId: plan.model };
      } else {
        // This import and credential read are unreachable without a matching, unexpired approval.
        const { openaiProvider } = await import("@earendil-works/pi-ai/providers/openai");
        const key = process.env[plan.credentialEnv!];
        if (!key) throw new Error(`Approved credential variable ${plan.credentialEnv} is not set`);
        models.setProvider(openaiProvider());
        model = { provider: "openai", modelId: plan.model };
      }
      const selected = base.getModel(model.provider, model.modelId);
      if (!selected || (selectedLimits.maxOutputTokens !== null && selectedLimits.maxOutputTokens > selected.maxTokens)) throw new Error("Unknown model or unsupported output token limit");
      // Credentials remain in memory/provider resolution, never in trial metadata or transcripts.
      const bounded = await budgetedModels(base, store, `${offline ? "offline" : "real"}:${digest}`, selectedLimits, expiresAt);
      return { models: bounded, model };
    },
  };
}
