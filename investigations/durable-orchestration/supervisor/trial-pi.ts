import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Models } from "@earendil-works/pi-ai";

const absolute = z.string().refine(isAbsolute, "Expected an absolute path");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const piSourceSchema = z.object({ sdkRoot: absolute, agentDir: absolute, sdkVersion: z.literal("1.4.0"),
  sdkSha256: digest, modelsSha256: digest, modelSha256: digest, credentialType: z.literal("oauth"),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
}).strict();
export type PiSource = z.infer<typeof piSourceSchema>;
type Runtime = Models & { getError(): string | undefined };
type PiSdk = { ModelRuntime: { create(options: object): Promise<Runtime> }; SettingsManager: { create(cwd: string, agentDir: string): {
  getDefaultProvider(): string | undefined; getDefaultModel(): string | undefined;
  getDefaultThinkingLevel(): string | undefined; getModelThinkingLevel(provider: string, model: string): string | undefined;
  drainErrors(): unknown[];
} } };
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function modelsDigest(agentDir: string) {
  try { return sha256(await readFile(join(agentDir, "models.json"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return sha256("absent"); throw error; }
}
async function sdkIdentity(sdkRoot: string) {
  if (await realpath(sdkRoot) !== sdkRoot) throw new Error("Pi SDK root must be canonical");
  const pkg = await readFile(join(sdkRoot, "package.json"), "utf8");
  if (JSON.parse(pkg).name !== "@earendil-works/pi-coding-agent" || JSON.parse(pkg).version !== "1.4.0") throw new Error("Trial requires the qualified Pi SDK 1.4.0");
  const entry = await readFile(join(sdkRoot, "dist/index.js"));
  const runtime = await readFile(join(sdkRoot, "dist/core/model-runtime.js"));
  return sha256(Buffer.concat([Buffer.from(pkg), entry, runtime]));
}
async function openRuntime(source: Pick<PiSource, "sdkRoot" | "agentDir">) {
  // No AgentSession, resource loader, project tools, catalog refresh or alternate model selection.
  const sdk = await import(pathToFileURL(join(source.sdkRoot, "dist/index.js")).href) as PiSdk;
  const runtime = await sdk.ModelRuntime.create({ authPath: join(source.agentDir, "auth.json"), modelsPath: join(source.agentDir, "models.json"),
    refreshOnCreate: false, allowModelNetwork: false });
  if (runtime.getError()) throw new Error("Pi model configuration has errors; inspect privately before continuing");
  return { sdk, runtime };
}

// Resolves explicit saved defaults only. This reads non-secret model metadata and auth type;
// it does not refresh OAuth, generate a response or inspect/log credential values.
export async function resolvePiDefault(sdkRoot: string, cwd: string, agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent")) {
  sdkRoot = await realpath(sdkRoot); agentDir = await realpath(agentDir);
  const sdkSha256 = await sdkIdentity(sdkRoot);
  const { sdk, runtime } = await openRuntime({ sdkRoot, agentDir });
  const settings = sdk.SettingsManager.create(cwd, agentDir);
  if (settings.drainErrors().length) throw new Error("Pi settings have errors; do not infer another model");
  const provider = settings.getDefaultProvider(); const model = settings.getDefaultModel();
  if (!provider || !model) throw new Error("An explicit saved Pi default is required; no fallback is allowed");
  if (provider !== "openai-codex") throw new Error("This qualified Pi adapter supports the saved OpenAI Codex OAuth default only");
  const selected = runtime.getModel(provider, model);
  if (!selected || selected.api !== "openai-codex-responses") throw new Error("Saved Pi default is unavailable or uses an unqualified API");
  if ((await runtime.checkAuth(provider))?.type !== "oauth") throw new Error("Saved Pi default requires existing OAuth authentication");
  const pi = piSourceSchema.parse({ sdkRoot, agentDir, sdkVersion: "1.4.0", sdkSha256, modelsSha256: await modelsDigest(agentDir),
    modelSha256: sha256(JSON.stringify(selected)), credentialType: "oauth",
    thinkingLevel: settings.getModelThinkingLevel(provider, model) ?? settings.getDefaultThinkingLevel() ?? "medium" });
  return { provider: "openai-codex" as const, model, credentialEnv: null, pi };
}

// Called only beyond the real-plan approval gate. OAuth resolution/refresh remains owned
// by Pi's file-locked credential store, not copied credentials in the trial fixture.
export async function piModels(source: PiSource, provider: string, model: string): Promise<Models> {
  if (await sdkIdentity(source.sdkRoot) !== source.sdkSha256 || await modelsDigest(source.agentDir) !== source.modelsSha256) throw new Error("Approved Pi SDK/configuration changed");
  if (provider !== "openai-codex") throw new Error("Unqualified Pi trial provider");
  const { runtime } = await openRuntime(source);
  const selected = runtime.getModel(provider, model);
  if (!selected || selected.api !== "openai-codex-responses" || sha256(JSON.stringify(selected)) !== source.modelSha256) throw new Error("Approved Pi model metadata changed; no fallback is allowed");
  if ((await runtime.checkAuth(provider))?.type !== source.credentialType) throw new Error("Approved Pi authentication type changed or is missing");
  return runtime;
}
