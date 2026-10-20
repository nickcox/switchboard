import { readFile } from "node:fs/promises";
import { z } from "zod";
import { runCommand } from "../infra/command.ts";

/**
 * Finalisation policy (Phase 2 PRD, finishing an attempt). The kinds are built in, because each is a sequence of steps
 * that move or publish work; documents only choose a kind and its settings, from three layers.
 */
export const policyKinds = ["manual", "local-merge"] as const;
export type PolicyKind = (typeof policyKinds)[number];
export type PolicyLayer = "default" | "global" | "repository" | "context";

const kind = z.enum(policyKinds);
const branch = z.string().min(1).refine(value => !value.startsWith("-"), "Must not start with '-'");
/** A layer may choose the kind and target branch. Only operator layers may forbid kinds. */
export const operatorPolicySchema = z.strictObject({ kind: kind.optional(), targetBranch: branch.optional(), forbid: z.array(kind).optional() });
const repositoryPolicySchema = z.strictObject({ kind: kind.optional(), targetBranch: branch.optional() });
type OperatorPolicy = z.infer<typeof operatorPolicySchema>;

/** Where Switchboard finds each layer. The repository file is read from the base branch, never from a workspace. */
export type PolicySources = {
  git: string;
  environment: Record<string, string>;
  /** The backing repository and the base branch the repository file is read from. */
  repository: string;
  baseRef: string;
  /** Absolute path of the global policy file; a missing file is skipped. */
  globalFile: string;
  context: OperatorPolicy;
  /** Facts from the repository's forge, used only to refuse a policy that cannot work. */
  forge?: (targetBranch: string) => Promise<ForgeFact>;
};

export type ForgeFact = { protected: boolean } | { unknown: string };

export type ResolvedPolicy = {
  kind: PolicyKind;
  /** For `local-merge`: the branch fast-forwarded to the output branch. */
  targetBranch?: string;
  /** Which layer set each part. */
  sources: { kind: PolicyLayer; targetBranch?: PolicyLayer };
  forbidden: { kind: PolicyKind; by: PolicyLayer }[];
  /** Set when the policy cannot be used; `finish` refuses with this reason. */
  refusal?: string;
  /** Set when a forge fact could not be read, so the policy is used without that check. */
  forgeUnknown?: string;
};

export const repositoryPolicyPath = ".switchboard/policy.json";

export async function resolvePolicy(sources: PolicySources): Promise<ResolvedPolicy> {
  const global = await readGlobal(sources.globalFile);
  const repository = await readRepository(sources);
  const context = operatorPolicySchema.parse(sources.context);
  const resolved: ResolvedPolicy = { kind: "manual", sources: { kind: "default" }, forbidden: [] };
  for (const [layer, policy] of [["global", global], ["repository", repository], ["context", context]] as const) {
    if (!policy) continue;
    if (policy.kind) { resolved.kind = policy.kind; resolved.sources.kind = layer; }
    if (policy.targetBranch) { resolved.targetBranch = policy.targetBranch; resolved.sources.targetBranch = layer; }
  }
  for (const [layer, policy] of [["global", global], ["context", context]] as const) {
    for (const forbidden of policy?.forbid ?? []) resolved.forbidden.push({ kind: forbidden, by: layer });
  }
  if (resolved.kind === "local-merge" && resolved.targetBranch === undefined) {
    resolved.targetBranch = sources.baseRef;
    resolved.sources.targetBranch = "default";
  }
  if (resolved.kind !== "local-merge") { delete resolved.targetBranch; delete resolved.sources.targetBranch; }
  const forbiddenBy = resolved.forbidden.find(f => f.kind === resolved.kind);
  if (forbiddenBy) {
    resolved.refusal = `The ${resolved.kind} policy chosen by the ${resolved.sources.kind} layer is forbidden by the ${forbiddenBy.by} layer`;
  } else if (resolved.kind === "local-merge" && sources.forge) {
    const fact = await sources.forge(resolved.targetBranch!).catch(error => ({ unknown: error instanceof Error ? error.message : String(error) }));
    if ("unknown" in fact) resolved.forgeUnknown = fact.unknown;
    else if (fact.protected) resolved.refusal = `Branch ${resolved.targetBranch} is protected, so local-merge cannot update it`;
  }
  return resolved;
}

async function readGlobal(path: string): Promise<OperatorPolicy | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  return parseLayer("global", path, text, operatorPolicySchema);
}

/**
 * Reads the repository's policy file from the base branch in the backing repository, never from a workspace. The branch
 * is named in full (`refs/heads/<baseRef>`), so a tag or other reference with the same short name cannot stand in for it,
 * and the file is read from the commit it points to. A file listed in that commit's tree that cannot be read is an error,
 * not an absent layer.
 */
async function readRepository(sources: PolicySources): Promise<z.infer<typeof repositoryPolicySchema> | undefined> {
  const run = (args: string[]) => runCommand(sources.git, args, { cwd: sources.repository, env: sources.environment, timeoutMs: 15000 });
  const ref = sources.baseRef.startsWith("refs/heads/") ? sources.baseRef : `refs/heads/${sources.baseRef}`;
  const base = await run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (base.exitCode !== 0 || base.timedOut) throw new Error(`Base branch ${sources.baseRef} cannot be read in the backing repository`);
  const commit = base.stdout.trim();
  const listed = await run(["ls-tree", "-z", commit, "--", repositoryPolicyPath]);
  if (listed.exitCode !== 0 || listed.timedOut || listed.truncated) throw new Error(`Could not check for ${repositoryPolicyPath} on ${sources.baseRef}: its tree cannot be read`);
  if (listed.stdout === "") return undefined;
  const entry = /^\d+ blob ([0-9a-f]+)\t/.exec(listed.stdout);
  if (!entry) throw new Error(`${repositoryPolicyPath} on ${sources.baseRef} is not a regular file`);
  const shown = await run(["cat-file", "blob", entry[1]!]);
  if (shown.exitCode !== 0 || shown.timedOut || shown.truncated) throw new Error(`${repositoryPolicyPath} on ${sources.baseRef} cannot be read`);
  return parseLayer("repository", `${sources.baseRef}:${repositoryPolicyPath} (commit ${commit})`, shown.stdout, repositoryPolicySchema);
}

function parseLayer<T>(layer: string, where: string, text: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`The ${layer} policy at ${where} is not valid JSON`); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`The ${layer} policy at ${where} is invalid: ${parsed.error.issues.map(i => `${i.path.join(".") || "policy"}: ${i.message}`).join("; ")}`);
  return parsed.data;
}
