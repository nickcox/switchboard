import { constants } from "node:fs";
import { callerSchema, type Caller } from "./caller.ts";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { AttemptStore } from "./attempts/store.ts";
import { checkCommandsSchema } from "./attempts/checks.ts";
import { runtimeSettingsSchema } from "./runtime/settings.ts";
import type { Dependencies } from "./dispatch/dispatch.ts";
import { onPath } from "./infra/executables.ts";
import { githubBranchProtection } from "./infra/github.ts";
import { operatorPolicySchema } from "./dispatch/policy.ts";
import { requireRetainedStorage } from "./infra/storage.ts";
import { describeEntry } from "./runtime/activity.ts";
import { PiWorker } from "./runtime/pi/worker.ts";
import { keepAwakeSchema } from "./runtime/keep-awake.ts";
import { RuntimeRecords, thinkingLevelSchema } from "./runtime/records.ts";
import { SqliteTaskStore } from "./tasks/sqlite.ts";
import { checkRetention } from "./workspaces/retention.ts";
import { TreehouseProvider } from "./workspaces/treehouse.ts";

const absolute = z.string().refine(isAbsolute, "Must be an absolute path");
const nonempty = z.string().min(1);
const contractSchema = z.strictObject({
  kind: z.enum(["code", "artefact"]),
  acceptance: z.enum(["review_or_integration", "independent_deliverable"]),
  requiredEvidence: z.array(nonempty).default([]),
  requiredDeliverables: z.array(nonempty).default([]),
});

/** The Switchboard configuration file. Every path is absolute so nothing depends on the caller's directory. */
export const configSchema = z.strictObject({
  contextId: nonempty,
  /** Holds runtime records and the attempt log. Must be outside every workspace. */
  runtimeRoot: absolute,
  databasePath: absolute.optional(),
  databaseRetryMs: z.number().int().nonnegative().default(5000),
  maxAttempts: z.number().int().positive().default(1),
  maxAttemptsPerTask: z.number().int().positive().default(3),
  keepAwake: keepAwakeSchema.default(true),
  checks: checkCommandsSchema.default([]),
  tasks: z.strictObject({ repo: nonempty }),
  workspaces: z.strictObject({ repository: absolute, poolRoot: absolute, fetch: z.boolean().default(false) }),
  delivery: z.strictObject({
    baseRef: nonempty,
    branchPrefix: z.string().default("switchboard/"),
    kind: z.enum(["code", "artefact"]).default("code"),
    acceptance: z.enum(["review_or_integration", "independent_deliverable"]).default("review_or_integration"),
    requiredEvidence: z.array(nonempty).default([]),
    requiredDeliverables: z.array(nonempty).default([]),
    /** Contracts selected by task kind, for example a "scout" kind whose deliverable is a report. */
    byTaskKind: z.record(nonempty, contractSchema).default({}),
  }),
  /**
   * The context layer of the finalisation policy, and where the global layer is (default
   * ~/.config/switchboard/policy.json). The repository layer is read from the base branch.
   */
  finalisation: operatorPolicySchema.extend({ globalFile: absolute.optional() }).default({}),
  worker: z.strictObject({
    /** The Pi CLI entry point run with this Node.js executable, for example .../pi-coding-agent/dist/bundle/cli.js. */
    piEntrypoint: absolute,
    provider: nonempty,
    model: nonempty,
    thinking: thinkingLevelSchema.optional(),
    shellTool: z.enum(["bash", "powershell"]).default("bash"),
    runMs: z.number().int().positive().default(30 * 60 * 1000),
    /** Stop the worker when an attempt's reported cost (in the provider's currency, usually US dollars) exceeds this. */
    maxCost: z.number().positive().optional(),
    /** Stop the worker when an attempt's total tokens exceed this. Useful when a subscription provider reports zero cost. */
    maxTokens: z.number().int().positive().optional(),
    /** How often to record a usage snapshot while the worker runs. */
    statsMs: z.number().int().positive().default(5 * 60 * 1000),
    /** status flags a possibly running worker with no activity for this long. */
    staleMs: z.number().int().positive().default(20 * 60 * 1000),
    /**
     * The worker's complete environment. Defaults to PATH, HOME, USER, TMPDIR and LANG from Switchboard's own, plus
     * the Windows equivalents and system variables when they are set.
     */
    environment: z.record(z.string(), z.string()).optional(),
  }),
});
export type Config = z.output<typeof configSchema>;

const configurationSources = new WeakMap<Config, { path: string; raw: unknown }>();
export async function loadConfig(path: string): Promise<Config> {
  const text = await readFile(path, "utf8");
  const raw: unknown = JSON.parse(text);
  const config = configSchema.parse(raw);
  configurationSources.set(config, { path, raw });
  return config;
}

function configurationProvenance(config: Config): Record<string, string> {
  const source = configurationSources.get(config);
  const selector = (path: string, parts = path.split(".")): string => {
    if (!source) return `unknown:${path}`;
    let value: unknown = source.raw;
    for (const part of parts) value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
    return value === undefined ? `default:${path}` : `${source.path}#${path}`;
  };
  return {
    contextId: selector("contextId"), repository: selector("tasks.repo"), backingRepository: selector("workspaces.repository"),
    baseRef: selector("delivery.baseRef"), outputBranch: `${selector("delivery.branchPrefix")} + task ID + attempt number`,
    ...Object.fromEntries(Object.keys(runtimeSettingsSchema.shape).map(key => [`runtime.${key}`, key === "profile" ? "Switchboard Pi profile"
      : key === "executable" ? "Switchboard process executable" : selector(`worker.${key === "entrypoint" ? "piEntrypoint" : key}`)])),
    ...Object.fromEntries(["kind", "acceptance", "requiredEvidence", "requiredDeliverables"].map(key => [`delivery.default.${key}`, selector(`delivery.${key}`)])),
    ...Object.fromEntries(Object.keys(config.delivery.byTaskKind).flatMap(kind => ["kind", "acceptance", "requiredEvidence", "requiredDeliverables"].map(key =>
      [`delivery.byTaskKind.${kind}.${key}`, selector(`delivery.byTaskKind[${JSON.stringify(kind)}].${key}`, ["delivery", "byTaskKind", kind, key])]))),
  };
}

export const databasePath = (config: Config) => config.databasePath ?? join(config.runtimeRoot, "switchboard.db");

function inherited(names: string[]): Record<string, string> {
  return Object.fromEntries(names.flatMap(name => (process.env[name] === undefined ? [] : [[name, process.env[name]!]])));
}

/** Opens local records, deferring external owners unless dispatch needs its preflight before reservation. */
export async function createDependencies(config: Config, caller: Caller, options: { dispatch?: boolean; progress?: (message: string) => void } = {}): Promise<Dependencies & { close(): void }> {
  caller = callerSchema.parse(caller);
  const { progress } = options;
  if (options.dispatch) {
    // Otherwise a missing entrypoint would be found only after acquisition and task start.
    const entrypoint = await stat(config.worker.piEntrypoint).catch(() => undefined);
    if (!entrypoint?.isFile()) throw new Error(`Pi entrypoint is not a readable file: ${config.worker.piEntrypoint}`);
    await access(config.worker.piEntrypoint, constants.R_OK).catch(() => { throw new Error(`Pi entrypoint is not a readable file: ${config.worker.piEntrypoint}`); });
  }
  await requireRetainedStorage(config.runtimeRoot, [config.workspaces.poolRoot]);
  await requireRetainedStorage(databasePath(config), [config.workspaces.poolRoot]);
  const git = () => onPath("git");
  // Git and Treehouse use the operator's own environment, including their Git identity and credentials.
  const hostEnvironment = Object.fromEntries(Object.entries(process.env).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])));
  const runtimeSettings = runtimeSettingsSchema.parse({
    profile: "pi", executable: process.execPath, entrypoint: config.worker.piEntrypoint,
    provider: config.worker.provider, model: config.worker.model, shellTool: config.worker.shellTool, runMs: config.worker.runMs,
    statsMs: config.worker.statsMs, requestMs: 5000, stopMs: 5000, requestPollMs: 1000,
    ...(config.worker.thinking === undefined ? {} : { thinking: config.worker.thinking }),
    ...(config.worker.maxCost === undefined ? {} : { maxCost: config.worker.maxCost }),
    ...(config.worker.maxTokens === undefined ? {} : { maxTokens: config.worker.maxTokens }),
  });
  const workerEnvironment = structuredClone(config.worker.environment ?? inherited([
    "PATH", "HOME", "USER", "TMPDIR", "LANG",
    "USERPROFILE", "USERNAME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "SystemRoot", "PATHEXT", "ComSpec",
  ]));
  const keepAwake = structuredClone(config.keepAwake);
  const tasks = await SqliteTaskStore.open({ caller, path: databasePath(config), repo: config.tasks.repo, retryMs: config.databaseRetryMs });
  try {
    const runtime = new RuntimeRecords(config.runtimeRoot, tasks.database);
    const workspaceOptions = {
      treehouse: () => onPath("treehouse"), git, repository: config.workspaces.repository, poolRoot: config.workspaces.poolRoot,
      fetch: config.workspaces.fetch, environment: hostEnvironment,
    };
    const workspaces = options.dispatch ? await TreehouseProvider.open(workspaceOptions) : TreehouseProvider.connect(workspaceOptions);
    return {
      close: () => tasks.close(),
      caller,
      contextId: config.contextId,
      checks: config.checks,
      checkEnvironment: hostEnvironment,
      tasks,
      maxAttempts: config.maxAttempts,
      maxAttemptsPerTask: config.maxAttemptsPerTask,
      workspaces,
      attempts: new AttemptStore(tasks.database, config.contextId, caller, config.checks),
      runtime,
      runtimeSettings, configurationProvenance: configurationProvenance(config),
      launch: (input, signal, onRequest, settings) => {
        if (!settings) throw new Error("Launching requires stored runtime settings");
        const { profile: _, ...options } = settings;
        return new PiWorker(runtime, { ...options, environment: workerEnvironment, keepAwake }).execute(input, signal, {
          ...(progress ? { onActivity: entry => progress(describeEntry(entry)) } : {}), ...(onRequest ? { onRequest } : {}),
        });
      },
      retention: async request => checkRetention(git(), hostEnvironment, request),
      repository: config.workspaces.repository,
      policy: {
        get git() { return git(); }, environment: hostEnvironment, repository: config.workspaces.repository, baseRef: config.delivery.baseRef,
        globalFile: config.finalisation.globalFile ?? join(homedir(), ".config", "switchboard", "policy.json"),
        context: { ...(config.finalisation.kind ? { kind: config.finalisation.kind } : {}), ...(config.finalisation.targetBranch ? { targetBranch: config.finalisation.targetBranch } : {}), ...(config.finalisation.forbid ? { forbid: config.finalisation.forbid } : {}) },
        forge: branch => githubBranchProtection({ git: git(), gh: onPathOrUndefined("gh"), repository: config.workspaces.repository, environment: hostEnvironment, branch }),
      },
      staleMs: config.worker.staleMs,
      delivery: {
        baseRef: config.delivery.baseRef, branchPrefix: config.delivery.branchPrefix, byTaskKind: config.delivery.byTaskKind,
        default: {
          kind: config.delivery.kind, acceptance: config.delivery.acceptance,
          requiredEvidence: config.delivery.requiredEvidence, requiredDeliverables: config.delivery.requiredDeliverables,
        },
      },
      ...(progress ? { progress } : {}),
    };
  } catch (error) {
    tasks.close();
    throw error;
  }
}

function onPathOrUndefined(name: string): string | undefined {
  try { return onPath(name); } catch { return undefined; }
}
